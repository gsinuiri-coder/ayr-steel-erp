import { BadRequestException } from '@nestjs/common';
import { InventoryItemType, type Prisma } from '@prisma/client';
import {
  BUSINESS_LINE_LABELS,
  Decimal,
  fixedLengthUnitValue,
  fixedLengthValuePerMeter,
  minAllowedValue,
  minTypeablePrice,
  money,
  salePriceFromValue,
  saleValueFromPrice,
  toDecimal,
} from '@ayr/shared';
import { toSharedLineCode } from '../common/business-line-code';
import { rawMaterialCoilIds, type RawMaterialSpecRef } from './raw-material';

/**
 * El **piso duro de precio** de una línea de venta (D-163).
 *
 * `precio mínimo = costo unitario promedio del kardex ÷ (1 − margen mínimo) × 1.18`.
 *
 * Tres cosas que no son obvias y que decidieron cómo está escrito:
 *
 * 1. **Se compara valor contra valor, no precio contra precio.** Lo que la línea guarda es el
 *    valor sin IGV, y el vendedor tipea el precio con IGV: entre los dos hay una división por
 *    1.18 redondeada a cuatro decimales. Comparando precios, tipear exactamente el mínimo que
 *    la pantalla muestra podía caer una diezmilésima por debajo y rebotar. El precio con IGV
 *    aparece solo en el mensaje, que es donde el vendedor lo necesita.
 * 2. **Sin costo no hay piso.** Un SKU que nunca entró al kardex tiene costo promedio cero, y
 *    cero dividido por lo que sea sigue siendo cero: la línea pasa. Es a propósito. Bloquear
 *    con "el mínimo es S/ 0.00" no protege ningún margen y sí impide cotizar un producto
 *    nuevo, que es exactamente cuando más falta hace cotizar.
 * 3. **El bloqueo es para todos los roles**, incluido el ADMINISTRADOR. D-032 dejaba que el
 *    administrador bajara del mínimo caso por caso; D-163 lo cierra: el ajuste legítimo es
 *    cambiar el margen mínimo en Configuración → Márgenes, que queda auditado, en vez de una
 *    excepción por línea que no queda en ningún lado.
 */

/** De dónde sale el costo unitario de la línea, **en la unidad en la que se cotiza**. */
export type PriceFloorCost =
  /** Un SKU con stock propio: plancha, perfil, trading. El costo es el de su saldo. */
  | { kind: 'PRODUCT'; productId: string }
  /** Venta de bobina entera (RF-73): el costo por kg de ese rollo. */
  | { kind: 'COIL'; coilId: string }
  /**
   * Cobertura a medida: no tiene stock propio —su producto no existe hasta que planta lo
   * rola— así que el costo por metro sale de la bobina: `kg por metro × costo por kg del
   * agregado compatible`. Es el mismo agregado contra el que la línea promete al reservar.
   */
  | { kind: 'RAW_MATERIAL'; spec: RawMaterialSpecRef; kgPerUnit: Decimal };

/**
 * **En qué unidad se negocia el precio de esta línea**, que no siempre es su unidad de venta.
 *
 * Hace falta porque el piso vive en la unidad de venta (el costo del kardex es por plancha) y
 * lo que el vendedor tipea puede estar en otra (por metro, D-161). Sin esto, el mensaje de
 * rechazo de una plancha de 3.60 m le mostraba el mínimo **por plancha** rotulado «por metro»:
 * el mismo factor ×largo que D-161 vino a corregir, reintroducido en el cartel de error.
 */
export type PriceBasis =
  /** Se tipea el precio de una unidad de venta. `unitLabel` es cómo nombrarla. */
  | { kind: 'UNIT'; unitLabel: string }
  /** D-161: se tipea el precio por metro lineal y el unitario sale del largo del SKU. */
  | { kind: 'PER_METER'; lengthMm: string };

/** Una línea a comprobar contra su piso. */
export interface PriceFloorCandidate {
  /** `Línea 3`, para el mensaje. También es la clave del resultado. */
  at: string;
  sku: string;
  businessLineId: string;
  basis: PriceBasis;
  /** El **valor** de venta (sin IGV) por unidad de venta que la línea propone. */
  unitValuePen: string;
  cost: PriceFloorCost;
}

/** El piso de una línea, ya calculado. Ausente cuando esa línea no tiene piso que aplicar. */
export interface PriceFloor {
  /** Valor de venta mínimo por unidad de venta, SIN IGV. Es contra esto que se compara. */
  minValuePen: string;
  /**
   * El precio mínimo **tipeable**, con IGV, en la unidad en la que se negocia y con dos
   * decimales. Es lo que se muestra y lo que se nombra en el rechazo. No es `minValuePen ×
   * 1.18` recortado: ver `minTypeablePrice`, que lo verifica contra la cadena de vuelta.
   */
  minPricePen: string;
  /** Cómo nombrar la unidad de `minPricePen`: `NIU`, `kg`, `metro`. */
  priceUnitLabel: string;
  /** Costo unitario promedio del kardex en la unidad de venta. */
  costPen: string;
  minMarginPct: string;
}

/**
 * El piso de cada línea, **sin lanzar**, indexado por la clave que trae el candidato en
 * `at`. Es la mitad que usa la lectura: el panel de stock del formulario muestra el mínimo
 * antes de que el vendedor tipee, y el rechazo lo pone `assertPriceFloor` con la misma
 * cuenta. Que sean la misma función es lo que impide que la pantalla prometa un mínimo y el
 * API rechace por otro.
 */
export async function computePriceFloors(
  tx: Prisma.TransactionClient,
  candidates: PriceFloorCandidate[],
  toleranceMm: string,
): Promise<Map<string, PriceFloor>> {
  const out = new Map<string, PriceFloor>();
  if (candidates.length === 0) return out;

  const minMarginByLineId = await minMarginsByBusinessLine(
    tx,
    candidates.map((c) => c.businessLineId),
  );
  const costByKey = await unitCosts(tx, candidates, toleranceMm);

  for (const candidate of candidates) {
    const minMarginPct = minMarginByLineId.get(candidate.businessLineId);
    // Sin fila en `pricing_settings` no hay margen que aplicar. El seed crea una por línea,
    // así que esto solo alcanza a una línea de negocio agregada a mano sin su configuración;
    // dejar pasar es preferible a trabar la venta por un maestro incompleto.
    if (minMarginPct === undefined) continue;
    const cost = costByKey.get(costKey(candidate.cost)) ?? new Decimal(0);
    if (cost.lte(0)) continue;
    const costPen = cost.toFixed(4);
    const minValuePen = minAllowedValue(costPen, minMarginPct);
    // El mismo piso, expresado en la unidad en la que el vendedor lo va a tipear: por metro
    // en una plancha, por unidad de venta en el resto.
    const basisValuePen =
      candidate.basis.kind === 'PER_METER'
        ? fixedLengthValuePerMeter(candidate.basis.lengthMm, minValuePen).toFixed(4)
        : minValuePen;
    out.set(candidate.at, {
      minValuePen,
      minPricePen: minTypeablePrice(minValuePen, basisValuePen, toUnitValue(candidate.basis)),
      priceUnitLabel: candidate.basis.kind === 'PER_METER' ? 'metro' : candidate.basis.unitLabel,
      costPen,
      minMarginPct,
    });
  }
  return out;
}

/**
 * La cadena de vuelta: de lo que el vendedor tipea al valor unitario que se guarda.
 *
 * Es **la misma** que aplican `resolveSalesLines` y el formulario, y por eso vive en una
 * función: el mínimo que se muestra se calcula probándolo contra esta cadena
 * (`minTypeablePrice`), así que si alguna de las tres divergiera, el mínimo mostrado dejaría
 * de ser alcanzable — que es exactamente el defecto que obligó a escribirla.
 */
function toUnitValue(basis: PriceBasis): (pricePen: string) => Decimal {
  return (pricePen) => {
    const value = money(saleValueFromPrice(pricePen));
    return basis.kind === 'PER_METER' ? money(fixedLengthUnitValue(basis.lengthMm, value)) : value;
  };
}

/**
 * Rechaza la primera línea que caiga por debajo de su piso. No devuelve nada: o pasa todo o
 * la transacción del llamador se cae con un 400 que dice el mínimo exacto.
 */
export async function assertPriceFloor(
  tx: Prisma.TransactionClient,
  candidates: PriceFloorCandidate[],
  toleranceMm: string,
): Promise<void> {
  const floors = await computePriceFloors(tx, candidates, toleranceMm);
  for (const candidate of candidates) {
    const floor = floors.get(candidate.at);
    if (!floor) continue;
    if (toDecimal(candidate.unitValuePen).gte(toDecimal(floor.minValuePen))) continue;

    // El precio propuesto se nombra **en la misma unidad** que el mínimo, o el vendedor lee
    // dos números que no se pueden comparar: en una plancha de 3.60 m tipeó por metro y el
    // valor guardado es por plancha.
    const proposedValue =
      candidate.basis.kind === 'PER_METER'
        ? fixedLengthValuePerMeter(candidate.basis.lengthMm, candidate.unitValuePen)
        : toDecimal(candidate.unitValuePen);
    throw new BadRequestException(
      `${candidate.at}: ${candidate.sku} se está vendiendo a ` +
        `S/ ${salePriceFromValue(proposedValue).toFixed(2)} por ${floor.priceUnitLabel} y el precio ` +
        `mínimo es S/ ${floor.minPricePen} por ${floor.priceUnitLabel} (costo promedio ` +
        `S/ ${toDecimal(floor.costPen).toFixed(2)} y margen mínimo ` +
        `${toDecimal(floor.minMarginPct).toFixed(2)}%). Sube el precio, o cambia el margen mínimo de esa ` +
        'línea de negocio en Configuración → Márgenes.',
    );
  }
}

/** El margen mínimo vigente de cada línea de negocio, en puntos porcentuales. */
async function minMarginsByBusinessLine(
  tx: Prisma.TransactionClient,
  businessLineIds: string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(businessLineIds)];
  if (ids.length === 0) return new Map();
  const settings = await tx.pricingSetting.findMany({
    where: { businessLineId: { in: ids } },
    select: { businessLineId: true, minMarginPct: true, businessLine: { select: { code: true } } },
  });
  const out = new Map<string, string>();
  for (const setting of settings) {
    const minMarginPct = setting.minMarginPct.toFixed(4);
    // El margen es **sobre la venta**: con 100 o más, `costo ÷ (1 − m)` explota o da negativo.
    // El schema de edición ya no lo admite (D-163), pero una fila anterior a esa validación
    // tiene que rebotar acá con un mensaje legible y no con un 500 desde `valueForMargin`.
    if (toDecimal(minMarginPct).gte(100)) {
      // D-174: el nombre de línea es de `BUSINESS_LINE_LABELS`, no de la columna `name`
      // de `business_lines`; D-175: el ítem del menú se llama "Márgenes y tipo de cambio",
      // bajo "Administración" (nunca existió un grupo "Configuración").
      throw new BadRequestException(
        `El margen mínimo de ${BUSINESS_LINE_LABELS[toSharedLineCode(setting.businessLine.code)]} es ${toDecimal(minMarginPct).toFixed(2)}%: ` +
          'no se puede calcular un precio mínimo con un margen de 100% o más. ' +
          'Corrígelo en Administración → Márgenes y tipo de cambio.',
      );
    }
    out.set(setting.businessLineId, minMarginPct);
  }
  return out;
}

/** Clave estable de un costo, para no consultar dos veces lo mismo en un documento. */
function costKey(cost: PriceFloorCost): string {
  switch (cost.kind) {
    case 'PRODUCT':
      return `P|${cost.productId}`;
    case 'COIL':
      return `C|${cost.coilId}`;
    case 'RAW_MATERIAL':
      return `R|${cost.spec.businessLineId}|${cost.spec.colorId ?? '-'}|${cost.spec.thicknessMm}|${cost.kgPerUnit.toFixed(6)}`;
  }
}

/**
 * El costo unitario de cada línea, en su unidad de venta. Todo en tres consultas como mucho,
 * y no una por línea: una cotización de cincuenta líneas del mismo SKU es una sola lectura.
 */
async function unitCosts(
  tx: Prisma.TransactionClient,
  candidates: PriceFloorCandidate[],
  toleranceMm: string,
): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>();

  const productIds = candidates.flatMap((c) =>
    c.cost.kind === 'PRODUCT' ? [c.cost.productId] : [],
  );
  const coilIds = candidates.flatMap((c) => (c.cost.kind === 'COIL' ? [c.cost.coilId] : []));

  if (productIds.length > 0) {
    const balances = await tx.inventoryBalance.findMany({
      where: { itemType: InventoryItemType.PRODUCT, itemId: { in: [...new Set(productIds)] } },
      select: { itemId: true, avgCost: true },
    });
    for (const balance of balances) {
      out.set(`P|${balance.itemId}`, toDecimal(balance.avgCost.toString()));
    }
  }
  if (coilIds.length > 0) {
    const balances = await tx.inventoryBalance.findMany({
      where: { itemType: InventoryItemType.COIL, itemId: { in: [...new Set(coilIds)] } },
      select: { itemId: true, avgCost: true },
    });
    for (const balance of balances) {
      out.set(`C|${balance.itemId}`, toDecimal(balance.avgCost.toString()));
    }
  }

  // El agregado: costo por kg **ponderado por los kilos que hay**, no el promedio simple de
  // los rollos. Dos bobinas de 5 000 y 100 kg a costos distintos no pesan lo mismo en lo que
  // esta cotización va a consumir, y el promedio simple corría el piso hacia el rollo chico.
  for (const candidate of candidates) {
    if (candidate.cost.kind !== 'RAW_MATERIAL') continue;
    const key = costKey(candidate.cost);
    if (out.has(key)) continue;
    const ids = await rawMaterialCoilIds(tx, candidate.cost.spec, toleranceMm);
    if (ids.length === 0) {
      out.set(key, new Decimal(0));
      continue;
    }
    const balances = await tx.inventoryBalance.findMany({
      where: { itemType: InventoryItemType.COIL, itemId: { in: ids } },
      select: { qty: true, avgCost: true },
    });
    let kilos = new Decimal(0);
    let value = new Decimal(0);
    for (const balance of balances) {
      const qty = toDecimal(balance.qty.toString());
      if (qty.lte(0)) continue;
      kilos = kilos.plus(qty);
      value = value.plus(qty.times(toDecimal(balance.avgCost.toString())));
    }
    out.set(key, kilos.lte(0) ? new Decimal(0) : value.div(kilos).times(candidate.cost.kgPerUnit));
  }

  return out;
}
