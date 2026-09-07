import { BadRequestException } from '@nestjs/common';
import { InventoryItemType, ReservationStatus, type Prisma } from '@prisma/client';
import { Decimal, rawMaterialLabel, salesOrderCode, toDecimal, toFixedString } from '@ayr/shared';
import { findLiveStripAssignments } from '../production/production-assignments';
import { roofingCoilWhere } from '../production/roofing-coil-match';

/**
 * La reserva **genérica** de materia prima (D-134).
 *
 * Hasta hoy una cobertura a medida prometía kilos de **una bobina concreta**: el vendedor
 * la elegía al cotizar (D-086/D-097) o, desde D-127, la elegía el API al confirmar. Las dos
 * formas comparten el mismo error de fondo — comprometen un rollo físico semanas antes de
 * que exista la decisión que lo elige. Quién rola qué rollo lo decide planta al montar la
 * OP, y hasta entonces lo único que se sabe (y lo único que hace falta saber) es **qué
 * material sirve**: la línea de negocio, el color y el espesor.
 *
 * Así que la promesa cambia de objeto: la línea reserva kilos contra el **agregado** de
 * bobinas compatibles (`raw_material_specs`), no contra una de ellas. La invariante
 * `disponible ≥ reservado` de D-066 sigue valiendo palabra por palabra; lo que cambia es
 * que el disponible es una **suma** sobre las bobinas que cumplen la spec y no la lectura
 * de un solo `inventory_balances`.
 *
 * Ese cambio arrastra un guardrail nuevo, y es la parte que no se puede omitir: cualquier
 * operación que le quite kilos al agregado —una merma, un partido, una venta de bobina
 * entera, un envío a corte, un montaje en una OP ajena, cerrar una bobina— puede dejarlo
 * por debajo de lo prometido **sin tocar ninguna bobina que la reserva nombre**, porque la
 * reserva ya no nombra ninguna. La invariante por ítem de `reservation-guard.ts` no ve
 * nada de eso. `assertRawMaterialInvariant` es la mitad que faltaba.
 *
 * Vive en una función suelta y no en un servicio por el mismo motivo que
 * `reservation-guard.ts`: la consultan `sales`, `inventory`, `coils`, `cutting` y
 * `production`, y hacerla un provider inyectable metería a `sales` en un ciclo con los
 * cuatro.
 */

/** El agregado, tal como lo describe una fila de `raw_material_specs`. */
export interface RawMaterialSpecRef {
  id: string;
  businessLineId: string;
  colorId: string | null;
  /** Espesor de la receta, con escala de mm. */
  thicknessMm: string;
}

/** Lo que hay y lo que se prometió de un agregado, en kg. */
export interface RawMaterialAvailability {
  spec: RawMaterialSpecRef;
  /** Kilos físicos de las bobinas compatibles y disponibles. */
  physical: Decimal;
  /** Lo que esas bobinas tienen comprometido **por ítem** (venta de bobina entera, RF-73). */
  reservedOnCoils: Decimal;
  /** Lo que el agregado tiene comprometido de forma genérica. */
  reservedGeneric: Decimal;
  /** `physical − reservedOnCoils − reservedGeneric`. Puede ser negativo si algo lo rompió. */
  available: Decimal;
  /** Las bobinas que hoy cumplen la spec y no están bajo custodia de nadie. */
  coilIds: string[];
  /**
   * Kilos de bobinas compatibles que están **montadas en una OP viva** (D-060) y por eso no
   * cuentan en `physical` ni en `reservedOnCoils`/`reservedGeneric`: el faltante no es que el
   * material no exista, es que está en la roladora. D-134 (hallazgo de Fase 7-final): sin
   * este número, un rechazo por agregado corto decía "0.000 físicos menos 0.000
   * comprometidos" sobre un almacén con material real, sin decir dónde estaba.
   */
  mountedKg: Decimal;
  /** Las órdenes de producción que tienen algo de ese material montado, para nombrarlas. */
  mountedOrderCodes: string[];
}

/**
 * Encuentra —o crea— el agregado de una combinación.
 *
 * Se crea al vuelo porque la combinación la define el catálogo (el color del SKU) y la
 * receta (el espesor de entrada), no un maestro que alguien mantenga: exigir que un
 * administrador dé de alta la spec antes de poder cotizar sería inventarle trabajo a un
 * dato derivado. La carrera entre dos altas simultáneas la resuelve el índice único, y el
 * `P2002` se reintenta leyendo: la fila que ganó es exactamente la que queríamos.
 */
export async function resolveRawMaterialSpec(
  tx: Prisma.TransactionClient,
  input: { businessLineId: string; colorId: string | null; thicknessMm: string },
): Promise<RawMaterialSpecRef> {
  const thicknessMm = toFixedString(toDecimal(input.thicknessMm), 'MM');
  const where = {
    businessLineId: input.businessLineId,
    colorId: input.colorId,
    thicknessMm,
  };
  const existing = await tx.rawMaterialSpec.findFirst({ where, select: SPEC_SELECT });
  if (existing) return toSpecRef(existing);

  // `INSERT … ON CONFLICT DO NOTHING` y no `try/catch`: dentro de una transacción
  // interactiva, un `P2002` la deja **abortada**, así que el `findFirst` de recuperación
  // falla también y se pierde la confirmación entera del pedido. Una sola sentencia que no
  // lanza es la forma de resolver la carrera sin arriesgar la transacción.
  await tx.$executeRaw`
    INSERT INTO "raw_material_specs" ("id", "business_line_id", "color_id", "thickness_mm")
    VALUES (gen_random_uuid(), ${where.businessLineId}::uuid, ${where.colorId}::uuid, ${where.thicknessMm}::decimal)
    ON CONFLICT DO NOTHING
  `;
  const spec = await tx.rawMaterialSpec.findFirst({ where, select: SPEC_SELECT });
  if (!spec) throw new BadRequestException('No se pudo resolver el agregado de materia prima');
  return toSpecRef(spec);
}

const SPEC_SELECT = {
  id: true,
  businessLineId: true,
  colorId: true,
  thicknessMm: true,
} satisfies Prisma.RawMaterialSpecSelect;

function toSpecRef(row: {
  id: string;
  businessLineId: string;
  colorId: string | null;
  thicknessMm: Prisma.Decimal;
}): RawMaterialSpecRef {
  return {
    id: row.id,
    businessLineId: row.businessLineId,
    colorId: row.colorId,
    thicknessMm: row.thicknessMm.toFixed(2),
  };
}

/**
 * El agregado de una combinación **si ya existe**, sin crearlo.
 *
 * Es lo que usa una lectura: un `GET` no puede tener efectos, y el disponible de una spec
 * que todavía no existe es exactamente el mismo que el de una spec sin promesas — se
 * calcula igual con la combinación, sin necesidad de que haya una fila.
 */
export async function findRawMaterialSpec(
  tx: Prisma.TransactionClient,
  input: { businessLineId: string; colorId: string | null; thicknessMm: string },
): Promise<RawMaterialSpecRef> {
  const thicknessMm = toFixedString(toDecimal(input.thicknessMm), 'MM');
  const where = { businessLineId: input.businessLineId, colorId: input.colorId, thicknessMm };
  const existing = await tx.rawMaterialSpec.findFirst({ where, select: SPEC_SELECT });
  if (existing) return toSpecRef(existing);
  // Una spec **virtual**: el id vacío no coincide con ninguna reserva, así que
  // `reservedGeneric` da cero, que es la verdad — nadie pudo prometer contra un agregado
  // que todavía no existe.
  return { id: '', ...where };
}

/** Las specs por id, para los llamadores que solo tienen el `itemId` de la reserva. */
export async function findRawMaterialSpecs(
  tx: Prisma.TransactionClient,
  ids: string[],
): Promise<Map<string, RawMaterialSpecRef>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.rawMaterialSpec.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: SPEC_SELECT,
  });
  return new Map(rows.map((r) => [r.id, toSpecRef(r)]));
}

/**
 * Etiqueta legible de una spec (`Bobina 0.45 mm ROJO`). Necesita el nombre del color, que
 * no vive en la spec: lo trae de `colors` en la misma consulta.
 */
export async function rawMaterialSpecLabels(
  tx: Prisma.TransactionClient,
  specIds: string[],
): Promise<Map<string, string>> {
  // Se descartan los ids vacíos: son las specs **virtuales** que devuelve
  // `findRawMaterialSpec` cuando el agregado todavía no tiene fila. Pasarlos a la consulta
  // hacía que Prisma intentara parsear "" como UUID y devolviera un 500 donde correspondía
  // una etiqueta.
  const ids = [...new Set(specIds)].filter((id) => id !== '');
  if (ids.length === 0) return new Map();
  const rows = await tx.rawMaterialSpec.findMany({
    where: { id: { in: ids } },
    select: { id: true, thicknessMm: true, color: { select: { name: true } } },
  });
  return new Map(
    rows.map((r) => [
      r.id,
      rawMaterialLabel({ thicknessMm: r.thicknessMm.toFixed(2), colorName: r.color?.name ?? null }),
    ]),
  );
}

/**
 * Las bobinas que hoy cumplen una spec, sin calcular nada más.
 *
 * Existe para poder **bloquearlas junto con las demás**: quien reserva puede estar tomando
 * a la vez bobinas concretas (una venta de rollo entero) y un agregado, y dos locks
 * separados sobre conjuntos que se solapan se cruzan en un deadlock aunque cada uno pida
 * sus filas ordenadas. El llamador junta los dos conjuntos, ordena una sola vez y bloquea
 * una sola vez.
 */
export async function rawMaterialCoilIds(
  tx: Prisma.TransactionClient,
  spec: RawMaterialSpecRef,
  toleranceMm: string,
): Promise<string[]> {
  const rows = await tx.coil.findMany({
    where: roofingCoilWhere({
      businessLineId: spec.businessLineId,
      colorId: spec.colorId,
      inputThicknessMm: toDecimal(spec.thicknessMm),
      toleranceMm,
    }),
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((r) => r.id);
}

/**
 * Qué bobinas cumplen hoy una spec, y con cuántos kilos libres.
 *
 * Es el **mismo filtro** que usa el selector de la OP (`roofingCoilWhere`, D-086): misma
 * línea, `OPEN`, color con igualdad estricta y espesor dentro de tolerancia. Tenía que ser
 * el mismo o el vendedor prometería material que planta no puede montar — la divergencia
 * que D-127 ya cerró una vez y que no se vuelve a abrir por la puerta de atrás.
 *
 * Del disponible se descuentan tres cosas, y las tres por el mismo motivo (prometer lo que
 * no está deja al pedido sin material y hace fallar después a quien sí lo tenía):
 *
 * - lo reservado **por ítem** sobre cada bobina: una venta de bobina entera (RF-73);
 * - las bobinas **montadas en una OP viva** (D-060), que no dejan rastro de kardex y por
 *   eso se ven con el saldo intacto;
 * - lo ya prometido de forma **genérica** contra la propia spec.
 *
 * `lockCoils` toma `FOR UPDATE` sobre las bobinas candidatas, en orden de id. Es lo que
 * cierra la ventana entre leer el disponible y escribir la reserva, igual que
 * `assertCoilsNotReserved`: sin él, dos confirmaciones simultáneas ven las dos el mismo
 * agregado libre y las dos lo prometen.
 */
export async function rawMaterialAvailability(
  tx: Prisma.TransactionClient,
  spec: RawMaterialSpecRef,
  toleranceMm: string,
  options: { lockCoils?: boolean; exceptReservationIds?: string[] } = {},
): Promise<RawMaterialAvailability> {
  const candidates = await tx.coil.findMany({
    where: roofingCoilWhere({
      businessLineId: spec.businessLineId,
      colorId: spec.colorId,
      inputThicknessMm: toDecimal(spec.thicknessMm),
      toleranceMm,
    }),
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  const ids = candidates.map((c) => c.id);

  if (options.lockCoils === true && ids.length > 0) {
    await tx.$queryRaw`
      SELECT "id" FROM "coils" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR UPDATE
    `;
  }

  const except = options.exceptReservationIds ?? [];
  const [balances, onCoils, mounted, generic] = await Promise.all([
    ids.length === 0
      ? []
      : tx.inventoryBalance.findMany({
          where: { itemType: InventoryItemType.COIL, itemId: { in: ids } },
          select: { itemId: true, qty: true },
        }),
    ids.length === 0
      ? []
      : tx.reservation.findMany({
          where: {
            status: ReservationStatus.ACTIVE,
            itemType: InventoryItemType.COIL,
            itemId: { in: ids },
            ...(except.length === 0 ? {} : { id: { notIn: except } }),
          },
          select: { itemId: true, qty: true },
        }),
    ids.length === 0 ? [] : findLiveStripAssignments(tx, ids),
    spec.id === ''
      ? Promise.resolve({ _sum: { qty: null } })
      : tx.reservation.aggregate({
          where: {
            status: ReservationStatus.ACTIVE,
            itemType: InventoryItemType.RAW_MATERIAL,
            itemId: spec.id,
            ...(except.length === 0 ? {} : { id: { notIn: except } }),
          },
          _sum: { qty: true },
        }),
  ]);

  const takenByProduction = new Set(mounted.map((m) => m.coilId));
  const free = ids.filter((id) => !takenByProduction.has(id));
  const freeSet = new Set(free);

  const physical = balances
    .filter((b) => freeSet.has(b.itemId))
    .reduce((acc, b) => acc.plus(toDecimal(b.qty.toString())), new Decimal(0));
  const reservedOnCoils = onCoils
    .filter((r) => freeSet.has(r.itemId))
    .reduce((acc, r) => acc.plus(toDecimal(r.qty.toString())), new Decimal(0));
  const reservedGeneric = toDecimal(generic._sum.qty?.toString() ?? '0');

  const balanceByCoilId = new Map(balances.map((b) => [b.itemId, toDecimal(b.qty.toString())]));
  const mountedKg = mounted.reduce(
    (acc, m) => acc.plus(balanceByCoilId.get(m.coilId) ?? new Decimal(0)),
    new Decimal(0),
  );
  const mountedOrderCodes = [...new Set(mounted.map((m) => m.orderCode))];

  return {
    spec,
    physical,
    reservedOnCoils,
    reservedGeneric,
    available: physical.minus(reservedOnCoils).minus(reservedGeneric),
    coilIds: free,
    mountedKg,
    mountedOrderCodes,
  };
}

/**
 * La invariante del agregado, para toda operación que le quite kilos.
 *
 * Se le pasan las **bobinas** que la operación está por tocar; de ahí sale qué agregados
 * pueden quedar cortos. Una bobina puede cumplir varias specs a la vez (dos recetas con
 * espesores distintos dentro de la misma tolerancia), así que se comprueban todas las que
 * tengan alguna promesa viva — comprobar solo la "suya" sería suponer que la spec es una
 * propiedad de la bobina, y no lo es.
 *
 * Se llama **después** de haber escrito el cambio (la salida de kardex, la asignación, el
 * cambio de estado) y dentro de la misma transacción: así lee el estado resultante y no
 * hay que anticiparlo. Si falla, la transacción entera se deshace.
 *
 * `exceptReservationIds` es la promesa **propia**: la OP que nace del pedido tiene que
 * poder montar el material que ese mismo pedido reservó. Sin la excepción, la reserva se
 * bloquearía a sí misma — el mismo problema y la misma solución que `assertNotReserved`.
 */
export async function assertRawMaterialInvariant(
  tx: Prisma.TransactionClient,
  coilIds: string[],
  toleranceMm: string,
  options: { exceptReservationIds?: string[]; alsoAffecting?: CoilAttributes[] } = {},
): Promise<void> {
  const ids = [...new Set(coilIds)];
  const attributes =
    ids.length === 0
      ? []
      : await tx.coil.findMany({
          where: { id: { in: ids } },
          select: { businessLineId: true, colorId: true, thicknessMm: true },
        });
  return assertRawMaterialInvariantFor(
    tx,
    [
      ...attributes.map((a) => ({
        businessLineId: a.businessLineId,
        colorId: a.colorId,
        thicknessMm: a.thicknessMm.toFixed(2),
      })),
      ...(options.alsoAffecting ?? []),
    ],
    toleranceMm,
    options,
  );
}

/** Los atributos de una bobina que deciden a qué agregados pertenece. */
export interface CoilAttributes {
  businessLineId: string;
  colorId: string | null;
  thicknessMm: string;
}

/**
 * La misma invariante, partiendo de **atributos** en vez de bobinas.
 *
 * Existe por un caso que la versión por id no puede cubrir: cuando lo que cambia es el
 * color de la bobina, después del cambio esa bobina ya no pertenece al agregado que
 * abandonó, así que leerla de la base no encuentra al que quedó corto. El llamador que
 * mueve una bobina de un agregado a otro pasa los **dos** juegos de atributos.
 */
export async function assertRawMaterialInvariantFor(
  tx: Prisma.TransactionClient,
  attributes: CoilAttributes[],
  toleranceMm: string,
  options: { exceptReservationIds?: string[] } = {},
): Promise<void> {
  const specs = await findSpecsAffectedByAttributes(tx, attributes, toleranceMm);
  if (specs.length === 0) return;

  for (const spec of specs) {
    // **Con `lockCoils`, y esa es la parte que faltaba.** Sin el lock, el camino que
    // consume (una salida de kardex, que bloquea `inventory_balances`) y el que promete
    // (confirmar un pedido, que bloquea `coils`) tomaban conjuntos **disjuntos** de filas:
    // ninguno esperaba al otro y los dos leían un estado en el que el otro todavía no había
    // commiteado. Resultado medido en la auditoría: 1.000 kg prometidos contra 100 kg
    // físicos, sin que ningún guardrail se enterara.
    //
    // Con el lock, las dos transacciones compiten por las mismas filas de `coils` y la
    // segunda ve lo que la primera dejó. El orden es siempre id ascendente, acá y en
    // `createReservations`.
    const availability = await rawMaterialAvailability(tx, spec, toleranceMm, {
      lockCoils: true,
      exceptReservationIds: options.exceptReservationIds,
    });
    if (availability.available.gte(0)) continue;

    const holders = await tx.reservation.findMany({
      where: {
        status: ReservationStatus.ACTIVE,
        itemType: InventoryItemType.RAW_MATERIAL,
        itemId: spec.id,
        ...(options.exceptReservationIds?.length
          ? { id: { notIn: options.exceptReservationIds } }
          : {}),
      },
      select: { qty: true, salesOrder: { select: { seq: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const detail = holders
      .map((h) => `${salesOrderCode(h.salesOrder.seq)} (${h.qty.toFixed(3)} kg)`)
      .join(', ');
    const label = (await rawMaterialSpecLabels(tx, [spec.id])).get(spec.id) ?? 'materia prima';
    const promised = availability.reservedGeneric.toFixed(3);
    const left = availability.physical.minus(availability.reservedOnCoils).toFixed(3);
    throw new BadRequestException(
      `La operación dejaría ${left} kg libres de ${label} y hay ${promised} kg prometidos a ${detail}. ` +
        'Anula el pedido, libera la reserva o abre otra bobina de ese color y espesor antes de continuar.',
    );
  }
}

/**
 * Qué agregados **con promesas vivas** cumplen alguna de esas bobinas.
 *
 * La comparación es simétrica y en los dos sentidos la misma: una bobina cumple una spec si
 * comparten línea y color y sus espesores no difieren más que la tolerancia. Se filtra por
 * las specs que tienen alguna reserva activa porque comprobar una spec sin promesas no
 * puede fallar nunca y sí cuesta una consulta por operación de kardex.
 */
async function findSpecsAffectedByAttributes(
  tx: Prisma.TransactionClient,
  attributes: CoilAttributes[],
  toleranceMm: string,
): Promise<RawMaterialSpecRef[]> {
  if (attributes.length === 0) return [];

  const tolerance = toDecimal(toleranceMm);
  const candidates = await tx.rawMaterialSpec.findMany({
    where: {
      OR: attributes.map((c) => ({
        businessLineId: c.businessLineId,
        colorId: c.colorId,
        thicknessMm: {
          gte: toDecimal(c.thicknessMm).minus(tolerance).toFixed(2),
          lte: toDecimal(c.thicknessMm).plus(tolerance).toFixed(2),
        },
      })),
    },
    select: SPEC_SELECT,
  });
  if (candidates.length === 0) return [];

  const withPromises = await tx.reservation.groupBy({
    by: ['itemId'],
    where: {
      status: ReservationStatus.ACTIVE,
      itemType: InventoryItemType.RAW_MATERIAL,
      itemId: { in: candidates.map((c) => c.id) },
    },
  });
  const live = new Set(withPromises.map((r) => r.itemId));
  return candidates.filter((c) => live.has(c.id)).map(toSpecRef);
}

/**
 * Bloquea, en orden de id, **todas** las bobinas que una salida de kardex sobre estas
 * puede afectar: la propia y las de cada agregado con promesas vivas que la alcanza.
 *
 * Existe para fijar un orden único de locks en todo el sistema: **primero las bobinas,
 * después los saldos**. Confirmar un pedido ya lo hacía así (`createReservations`); el
 * camino de kardex tomaba antes el saldo y recién después, dentro del guardrail, las
 * bobinas — el orden inverso, que es la receta de un deadlock en cuanto las dos
 * operaciones se cruzan sobre el mismo agregado.
 *
 * Se llama **antes** de `lockBalance` y no reemplaza al guardrail: aquel comprueba, este
 * solo ordena la espera.
 */
export async function lockRawMaterialCoils(
  tx: Prisma.TransactionClient,
  coilIds: string[],
  toleranceMm: string,
): Promise<void> {
  const ids = [...new Set(coilIds)];
  if (ids.length === 0) return;
  const attributes = await tx.coil.findMany({
    where: { id: { in: ids } },
    select: { businessLineId: true, colorId: true, thicknessMm: true },
  });
  const specs = await findSpecsAffectedByAttributes(
    tx,
    attributes.map((a) => ({
      businessLineId: a.businessLineId,
      colorId: a.colorId,
      thicknessMm: a.thicknessMm.toFixed(2),
    })),
    toleranceMm,
  );
  const all = new Set(ids);
  for (const spec of specs) {
    for (const id of await rawMaterialCoilIds(tx, spec, toleranceMm)) all.add(id);
  }
  const sorted = [...all].sort();
  await tx.$queryRaw`
    SELECT "id" FROM "coils" WHERE "id" = ANY(${sorted}::uuid[]) ORDER BY "id" FOR UPDATE
  `;
}
