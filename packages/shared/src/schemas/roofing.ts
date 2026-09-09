import { z } from 'zod';
import { Decimal, decimalStringSchema, MAX_VALUE, roundTo, toDecimal } from '../decimal';
import { PRODUCTION_ORDER_STATUSES } from '../enums';
import { reasonSchema } from './coil';
import { backdatableFields } from './operation';

/**
 * Producción de coberturas metálicas contra pedido (RF-30..RF-33; D-082..D-091).
 *
 * Modelo en una línea: la OP **nace de un pedido** (D-084), copia sus subítems
 * `{cantidad, largo}` como plan de corte editable, monta una o varias bobinas filtradas por
 * espesor y color (D-086), reporta los largos **reales** —que entran al kardex del producto
 * en **metros lineales** (D-083)— y se cierra declarando los kilos que la bobina consumió de
 * verdad; la diferencia contra el kilo teórico es la merma de despunte (D-089).
 *
 * Montar la bobina no mueve kardex: es custodia, exactamente D-060.
 */

// --------------------------------------------------------------------------
// Constantes compartidas entre web y API
// --------------------------------------------------------------------------

/**
 * Tolerancia de espesor del filtro de bobina (D-086), en mm.
 *
 * El espesor nominal de una bobina y el que trae el rollo no coinciden nunca: exigir
 * igualdad exacta dejaría fuera del filtro material perfectamente válido y empujaría a
 * alguien a saltarse el filtro. Es constante y no campo de pantalla por el mismo motivo que
 * `MAX_SCRAP_RATIO_WITHOUT_REASON`: un número que la operación no cambia todos los días no
 * necesita UI, y una UI lo convierte en algo que se puede aflojar hasta que no filtre nada.
 * El API admite un override por variable de entorno para poder probarlo.
 */
export const ROOFING_THICKNESS_TOLERANCE_MM = '0.02';

/**
 * Tope de líneas de largo en un plan de corte o en un reporte. Una obra real tiene un
 * puñado de medidas distintas; sin cota, el detalle de la OP crecería sin límite y el
 * comprobante llevaría una descripción imposible de leer.
 */
export const MAX_PIECE_LINES = 30;

/** Largo mínimo de una plancha, en mm. Por debajo es un recorte, no un producto. */
export const MIN_PIECE_LENGTH_MM = 100;

/** Largo máximo de una plancha, en mm. Ninguna roladora del rubro pasa de esto. */
export const MAX_PIECE_LENGTH_MM = 20_000;

/**
 * D-166: **¿este largo es un largo posible para una plancha?**
 *
 * Existe como función y no como dos comparaciones sueltas porque la misma pregunta se hace en
 * tres lugares que hasta D-166 no se hablaban: el largo de un subítem del plan de corte (que
 * ya la tenía, inline), el **largo fijo de una plancha en el catálogo** (que no la tenía, y
 * ahí estaba el defecto) y la línea de venta que multiplica por ese largo.
 *
 * El defecto que la trajo: el catálogo pide el largo **en milímetros** y el resto de la
 * pantalla de coberturas trabaja en **metros**, así que las tres planchas cargadas por el
 * dueño tenían `3.00` y `6.00` donde iban 3 000 y 6 000. Un largo de 3 mm pasa `> 0`, así que
 * `sellsByFixedLength` decía que sí y la línea salía **mil veces más barata**: diez planchas a
 * S/ 11 el metro daban S/ 0.28 en vez de S/ 330, sin un solo error por ningún lado.
 *
 * El rango no es una cota de seguridad inventada para esto: es el mismo que el plan de corte
 * ya exigía a cada largo que se tipea a mano. Lo único nuevo es que ahora también lo cumple el
 * largo que vive en el maestro, que es de donde salía el número que nadie miraba.
 */
export function isPlausiblePieceLength(lengthMm: string): boolean {
  const length = toDecimal(lengthMm);
  return length.gte(MIN_PIECE_LENGTH_MM) && length.lte(MAX_PIECE_LENGTH_MM);
}

/** El rango de largos, en metros, para los mensajes de error. */
export const PIECE_LENGTH_RANGE_LABEL = `${MIN_PIECE_LENGTH_MM / 1000} y ${MAX_PIECE_LENGTH_MM / 1000} metros`;

/** Tope de planchas de un mismo largo en una línea. */
export const MAX_PIECE_QTY = 10_000;

// --------------------------------------------------------------------------
// Subítems de largo: la forma que comparten cotización, pedido, plan de corte y reporte
// --------------------------------------------------------------------------

export const roofingPieceInputSchema = z.object({
  /** Largo de la plancha en mm (escala MM, D-003). La UI lo muestra en metros. */
  lengthMm: decimalStringSchema('MM', { positive: true, max: MAX_VALUE.WIDTH_MM }).refine(
    isPlausiblePieceLength,
    `El largo tiene que estar entre ${PIECE_LENGTH_RANGE_LABEL}`,
  ),
  qty: z
    .number({ required_error: 'La cantidad es obligatoria' })
    .int('Las planchas se cuentan en enteros')
    .min(1, 'Al menos una plancha')
    .max(MAX_PIECE_QTY, `Máximo ${MAX_PIECE_QTY} planchas por largo`),
});
export type RoofingPieceInput = z.infer<typeof roofingPieceInputSchema>;

/**
 * La lista de largos. **Un largo aparece una sola vez**: dos líneas de 4.20 m son la misma
 * medida escrita dos veces, y admitirlas dejaría el plan de corte y la descripción del
 * comprobante contando lo mismo dos veces sin que nadie lo note.
 */
export const roofingPiecesSchema = z
  .array(roofingPieceInputSchema)
  .min(1, 'Al menos un largo')
  .max(MAX_PIECE_LINES, `Máximo ${MAX_PIECE_LINES} largos distintos`)
  .superRefine((pieces, ctx) => {
    const seen = new Set<string>();
    pieces.forEach((piece, i) => {
      const key = toDecimal(piece.lengthMm).toFixed(2);
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'lengthMm'],
          message: 'Ese largo ya está en la lista: súmalo a la cantidad de esa línea',
        });
      }
      seen.add(key);
    });
  });

export const roofingPieceSchema = z.object({
  lineNumber: z.number().int(),
  lengthMm: z.string(),
  qty: z.number().int(),
});
export type RoofingPieceDto = z.infer<typeof roofingPieceSchema>;

// --------------------------------------------------------------------------
// Aritmética compartida
// --------------------------------------------------------------------------

/** Interfaz mínima para operar largos: sirve tanto al input como a la fila persistida. */
export interface PieceLike {
  lengthMm: string;
  qty: number;
}

/**
 * Metros lineales de una lista de largos: `Σ cantidad × largo / 1000`.
 *
 * Es lo que la línea de venta guarda como `qty` y lo que entra al kardex del producto a
 * medida (D-083). Vive acá para que el total que el vendedor ve mientras tipea sea
 * exactamente el que el API guarda, igual que `salesLineTotals` y las constantes del
 * partido.
 */
export function piecesMeters(pieces: readonly PieceLike[]): Decimal {
  const mm = pieces.reduce(
    (acc, p) => acc.plus(toDecimal(p.lengthMm).times(p.qty)),
    new Decimal(0),
  );
  return roundTo(mm.div(1000), 'KG');
}

/** Cuántas planchas son en total. */
export function piecesCount(pieces: readonly PieceLike[]): number {
  return pieces.reduce((acc, p) => acc + p.qty, 0);
}

/**
 * `3 × 4.20 m, 2 × 6.00 m`. Es lo que viaja a la descripción del comprobante: el cliente
 * compra metros pero recibe planchas, y sin esto la factura de una cobertura a medida no
 * dice qué le llega.
 */
export function describePieces(pieces: readonly PieceLike[]): string {
  // La división va con `Decimal` y no con `number` (regla dura 1) y no es cosmético: este
  // texto viaja a `sales_order_items.description` y de ahí a la descripción del comprobante,
  // así que un largo de 4 205 mm impreso como "4.21 m" sería un dato fiscal equivocado.
  return pieces.map((p) => `${p.qty} × ${toDecimal(p.lengthMm).div(1000).toFixed(2)} m`).join(', ');
}

// --------------------------------------------------------------------------
// D-161 — la plancha de catálogo se vende por metro lineal
// --------------------------------------------------------------------------

/** Lo mínimo de un producto que hace falta para saber si se cotiza por largo fijo. */
export interface FixedLengthProductLike {
  roofingKind: string | null;
  lengthMm: string | null;
  unit: string;
}

/**
 * D-161: **¿esta línea se cotiza por metro lineal contra un largo fijo del SKU?**
 *
 * Es la **tercera** pregunta de la familia de D-131, y las tres se responden con funciones
 * distintas porque las tres devuelven `boolean` y el compilador no avisa cuando se contesta
 * una con otra:
 *
 * - `sellsByLength` (unidad `MTR`) — *¿la línea necesita el detalle de largos?* La cantidad
 *   de la línea **son** metros y el vendedor los compone plancha por plancha.
 * - `isMadeToMeasure` (subtipo `A_MEDIDA`) — *¿se fabrica contra pedido desde bobina?* Decide
 *   la rama de la reserva.
 * - `sellsByFixedLength` (esta) — *¿el precio se negocia por metro pero la cantidad se cuenta
 *   en planchas?* La cantidad sigue siendo `NIU` —el kardex, la reserva y el despacho de una
 *   plancha están en planchas— y lo único que cambia es de dónde sale el valor unitario.
 *
 * Pide **tres** campos a propósito, y ninguno sobra:
 *
 * - `roofingKind === 'PLANCHA'` — es el subtipo el que dice que hay un largo de catálogo;
 * - `lengthMm > 0` — un `PLANCHA` sin largo en el maestro (los hay, ver
 *   `roofing-catalog-report.ts`) tiene que caer en el camino viejo —valor por plancha tipeado
 *   a mano— en vez de en un largo cero que dejaría toda la línea en S/ 0;
 * - `unit === 'NIU'` — y este es el que menos se ve venir. El CHECK de la base solo exige que
 *   una `PLANCHA` **no** esté en `MTR`, así que una en `KGM` o `MTK` es legal y el catálogo la
 *   admite a propósito (hay SKU legados). Multiplicar el largo por el precio solo significa
 *   algo si la cantidad de la línea son **piezas**: en una plancha vendida por kilo, ese
 *   producto no es el valor unitario de nada y el importe saldría multiplicado por el largo.
 *   Es la regla dura 14 mirada al revés — una pregunta sobre la aritmética de la unidad no se
 *   responde con el subtipo.
 */
export function sellsByFixedLength(product: FixedLengthProductLike): boolean {
  return (
    product.roofingKind === 'PLANCHA' &&
    product.unit === 'NIU' &&
    product.lengthMm !== null &&
    toDecimal(product.lengthMm).gt(0)
  );
}

/**
 * D-161: valor unitario (sin IGV) de **una** plancha = `largo del SKU en metros × valor por
 * metro`. Sin redondear: lo redondea el llamador, una sola vez, al persistir.
 */
export function fixedLengthUnitValue(
  lengthMm: string,
  valuePerMeterPen: Decimal | string,
): Decimal {
  return toDecimal(lengthMm).div(1000).times(toDecimal(valuePerMeterPen));
}

/**
 * D-161: el camino inverso — el valor por metro que corresponde a un valor por plancha ya
 * guardado. Es como se muestra el precio de lista del maestro (que es por plancha) en un
 * campo que se negocia por metro, y como se reabre para editar una línea existente.
 */
export function fixedLengthValuePerMeter(
  lengthMm: string,
  unitValuePen: Decimal | string,
): Decimal {
  const meters = toDecimal(lengthMm).div(1000);
  // Sin la guarda, un largo cero devuelve `Infinity` y `toFixedString` lo serializa como
  // texto: un precio "Infinity" viajando a una pantalla o a la base. Hoy todos los llamadores
  // pasan por `sellsByFixedLength`, que ya lo descarta, pero esta es una función exportada del
  // paquete compartido y esa garantía no viaja con ella.
  if (meters.lte(0)) {
    throw new RangeError(`Largo inválido (${lengthMm} mm): no se puede repartir por metro`);
  }
  return toDecimal(unitValuePen).div(meters);
}

/** D-161: los metros lineales de una línea de planchas = `largo del SKU × cantidad`. */
export function fixedLengthMeters(lengthMm: string, qty: Decimal | string): Decimal {
  return roundTo(toDecimal(lengthMm).div(1000).times(toDecimal(qty)), 'KG');
}

// --------------------------------------------------------------------------
// D-146 — el plan de corte acota los METROS; el kg declarado solo avisa (D-154)
// --------------------------------------------------------------------------

/** Lo que el plan de corte de un ítem promete, lo que ya se reportó y lo que queda (D-146). */
export interface RoofingPlanProgress {
  /** `Σ cantidad × largo` del plan de corte, en metros lineales. */
  planMeters: Decimal;
  /** Metros ya reportados por los reportes **vigentes** de la orden. */
  reportedMeters: Decimal;
  /** `planMeters − reportedMeters`, nunca negativo. */
  remainingMeters: Decimal;
  /**
   * `false` cuando la orden no tiene plan de corte: sin plan no hay tope que aplicar, y es
   * distinto de un plan de cero metros. Hoy solo lo alcanzan órdenes anteriores a D-146.
   */
  hasPlan: boolean;
}

/**
 * El estado del plan de un ítem contra lo ya reportado (D-146).
 *
 * `remainingMeters` puede quedar en cero sobre datos históricos que ya se pasaron del plan
 * —los reportes anteriores a D-146 no tenían tope y no se tocan—, y eso es a propósito: la
 * regla mira hacia adelante, así que lo único que hace un acumulado excedido es dejar el
 * restante en cero y rechazar el **siguiente** reporte.
 */
export function roofingPlanProgress(
  planItems: readonly PieceLike[],
  reportedMeters: Decimal | string,
): RoofingPlanProgress {
  const planMeters = piecesMeters(planItems);
  const reported = toDecimal(reportedMeters);
  return {
    planMeters,
    reportedMeters: reported,
    remainingMeters: Decimal.max(planMeters.minus(reported), new Decimal(0)),
    hasPlan: planItems.length > 0,
  };
}

/**
 * ¿Cuánto se pasa del plan un reporte nuevo? (D-146)
 *
 * Positivo ⇒ hay que rechazarlo. **Sin tolerancia**: el plan y el reporte se miden con la
 * misma escala de tres decimales, así que "casi" no existe — un metro de más es un metro
 * que el pedido no encargó y que nadie va a pagar.
 */
export function roofingPlanOverrun(
  progress: RoofingPlanProgress,
  newMeters: Decimal | string,
): Decimal {
  if (!progress.hasPlan) return new Decimal(0);
  return progress.reportedMeters.plus(toDecimal(newMeters)).minus(progress.planMeters);
}

/**
 * Cuántas planchas de cada largo del plan quedan por reportar (D-146).
 *
 * Se compara **por largo**: el plan es editable y los reportes son libres, así que un largo
 * reportado que el plan no tiene simplemente no descuenta de ninguna línea. El tope global
 * sigue siendo el de metros, que sí los cuenta a todos.
 */
export function remainingPlanPieces(
  planItems: readonly PieceLike[],
  reportedPieces: readonly PieceLike[],
): (PieceLike & { qty: number })[] {
  const reported = new Map<string, number>();
  for (const piece of reportedPieces) {
    const key = toDecimal(piece.lengthMm).toFixed(2);
    reported.set(key, (reported.get(key) ?? 0) + piece.qty);
  }
  return planItems.map((item) => {
    const key = toDecimal(item.lengthMm).toFixed(2);
    const already = reported.get(key) ?? 0;
    const left = Math.max(item.qty - already, 0);
    reported.set(key, Math.max(already - item.qty, 0));
    return { lengthMm: key, qty: left };
  });
}

export type PlanMetersSplit =
  { ok: true; pieces: (PieceLike & { qty: number })[] } | { ok: false; reason: string };

/**
 * Reparte unos metros lineales sobre los largos que el plan todavía debe (D-147).
 *
 * Es lo que hace posible capturar una tanda escribiendo **un solo número por orden**: el
 * papel de planta dice "de la OP-000123 salieron 42 m", no cómo se repartieron.
 *
 * La búsqueda es **exacta y no glotona**, y la diferencia importa: con un plan de
 * `2 × 4.20 m` y `1 × 6.00 m`, glotón por orden de plan no encuentra los 6.00 m —se lleva
 * una plancha de 4.20 y se queda con 1.80 m que no cierran— aunque la respuesta exista.
 * El recorrido prueba primero la cantidad **mayor** de cada línea en el orden del plan, así
 * que cuando la solución glotona sirve es la que devuelve, y solo retrocede cuando no.
 *
 * Falla en vez de redondear cuando los metros no caen en un número entero de planchas: media
 * plancha no existe, y elegir por el operario cuál largo recortar sería inventarle un
 * producto.
 */
export function piecesFromPlanMeters(
  planItems: readonly PieceLike[],
  reportedPieces: readonly PieceLike[],
  meters: Decimal | string,
): PlanMetersSplit {
  const target = toDecimal(meters);
  if (target.lte(0)) return { ok: false, reason: 'Los metros van en un número mayor a cero.' };
  if (planItems.length === 0) {
    return {
      ok: false,
      reason: 'La orden no tiene plan de corte: reporta los largos uno por uno desde la terminal.',
    };
  }

  // Todo el reparto se resuelve en **centésimas de milímetro enteras** y no con `Decimal`:
  // el largo tiene escala 2 y los metros escala 3, así que ×100 000 los deja enteros
  // exactos, y la búsqueda necesita comparar e ir restando miles de veces sin que aparezca
  // un residuo de redondeo que convierta un reparto válido en "no cierra".
  const lines = remainingPlanPieces(planItems, reportedPieces)
    .filter((line) => line.qty > 0 && toDecimal(line.lengthMm).gt(0))
    .map((line) => ({
      lengthMm: line.lengthMm,
      qty: line.qty,
      units: toDecimal(line.lengthMm).times(100).toNumber(),
    }));
  const reachable = lines.reduce((acc, l) => acc + l.units * l.qty, 0);
  const targetUnits = target.times(100_000).toNumber();

  const toMeters = (units: number) => new Decimal(units).div(100_000).toFixed(3);
  if (lines.length === 0 || targetUnits > reachable) {
    return {
      ok: false,
      reason:
        reachable === 0
          ? 'El plan de corte ya no tiene planchas pendientes.'
          : `El plan solo tiene ${toMeters(reachable)} m pendientes y se reportan ${target.toFixed(3)} m.`,
    };
  }

  // Presupuesto de nodos: el problema es una mochila acotada y una orden patológica (30
  // largos distintos con miles de planchas cada uno) podría hacerla explotar. Una orden
  // real tiene dos o tres medidas y se resuelve en decenas de nodos; el tope existe para
  // que el caso raro devuelva "no cierra" en vez de colgar la transacción.
  let budget = 50_000;
  const taken: number[] = new Array<number>(lines.length).fill(0);
  const search = (index: number, left: number): boolean => {
    if (left === 0) return true;
    if (index >= lines.length || budget-- <= 0) return false;
    const line = lines[index];
    if (line === undefined) return false;
    const max = Math.min(line.qty, Math.floor(left / line.units));
    for (let qty = max; qty >= 0; qty -= 1) {
      taken[index] = qty;
      if (search(index + 1, left - qty * line.units)) return true;
    }
    taken[index] = 0;
    return false;
  };

  if (!search(0, targetUnits)) {
    // El presupuesto agotado y "no hay reparto" son dos respuestas distintas, y decir la
    // segunda cuando pasó la primera es mentirle al operario: puede que su número esté bien
    // y que lo que se agotó sea la búsqueda. Se distingue, y la salida es reportar los
    // largos a mano desde la terminal.
    if (budget <= 0) {
      return {
        ok: false,
        reason:
          `No se pudo repartir ${target.toFixed(3)} m entre los largos pendientes de esta orden: ` +
          'reporta los largos uno por uno desde la terminal de planta.',
      };
    }
    return {
      ok: false,
      reason:
        `${target.toFixed(3)} m no salen de un número entero de planchas del plan ` +
        `(${lines.map((l) => `${String(l.qty)} × ${toDecimal(l.lengthMm).div(1000).toFixed(2)} m`).join(', ')} pendientes).`,
    };
  }

  const pieces = lines
    .map((line, i) => ({ lengthMm: line.lengthMm, qty: taken[i] ?? 0 }))
    .filter((p) => p.qty > 0);
  return { ok: true, pieces };
}

/**
 * ¿El espesor de esta bobina sirve para esta receta? (D-086)
 *
 * Vive acá y no en el API para que la lista que `/planta` muestra y la que el API acepta
 * sean la misma: si divergieran, el operario vería un rollo que al montarlo se rechaza.
 */
export function thicknessWithinTolerance(
  coilThicknessMm: string,
  bomThicknessMm: string,
  toleranceMm: string = ROOFING_THICKNESS_TOLERANCE_MM,
): boolean {
  return toDecimal(coilThicknessMm)
    .minus(toDecimal(bomThicknessMm))
    .abs()
    .lte(toDecimal(toleranceMm));
}

// --------------------------------------------------------------------------
// D-084 — la orden
// --------------------------------------------------------------------------

/**
 * Crear la OP de coberturas. Dos caminos (D-140):
 *
 * - **Contra pedido** (RF-31, D-084): `reservationId` de la reserva de materia prima que la
 *   cotización dejó activa. El producto, el acabado y el plan de corte salen de la línea de
 *   pedido que esa reserva cubre; no se piden por separado, así no pueden discrepar.
 * - **A stock** (D-140): sin pedido detrás. Solo existe para una **plancha de catálogo**
 *   (largo fijo en el SKU, D-127; la cotización de esa línea reserva producto terminado, no
 *   materia prima, así que nunca hay una reserva de la que nacer). `productId` +
 *   `targetPieces` reemplazan lo que en el camino anterior salía de la reserva; una cobertura
 *   a medida no tiene este camino porque sin pedido no hay largo que fabricar.
 */
export const createRoofingOrderSchema = z
  .object({
    ...backdatableFields,
    reservationId: z.string().uuid().optional(),
    productId: z.string().uuid().optional(),
    targetPieces: z
      .number()
      .int('Las planchas se cuentan en enteras')
      .min(1, 'Al menos una plancha')
      .max(MAX_PIECE_QTY, `Máximo ${MAX_PIECE_QTY} planchas por corrida`)
      .optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.reservationId === undefined && v.productId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reservationId'],
        message:
          'Se necesita la reserva de un pedido, o un producto de catálogo para producir a stock',
      });
    }
    if (v.reservationId !== undefined && v.productId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['productId'],
        message: 'Una orden nace de un pedido o se produce a stock: no de las dos formas a la vez',
      });
    }
    if (v.productId !== undefined && v.targetPieces === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetPieces'],
        message: 'La cantidad objetivo es obligatoria para producir a stock',
      });
    }
  });
export type CreateRoofingOrderInput = z.infer<typeof createRoofingOrderSchema>;

/**
 * Ajustar el plan de corte (D-084). Reemplaza la lista entera: el techo real se mide en
 * obra y el largo cambia, así que planta corrige lo que haga falta antes y durante la
 * corrida. El plan es una intención — lo que mueve kardex son los largos reportados.
 */
export const updateRoofingPlanSchema = z.object({ items: roofingPiecesSchema });
export type UpdateRoofingPlanInput = z.infer<typeof updateRoofingPlanSchema>;

/**
 * Montar una bobina en la roladora. Misma forma que asignar un fleje en drywall
 * (`consumeStripSchema`), y a propósito: es la misma operación de custodia (D-060) sobre
 * otra clase de rollo. Se declara acá en vez de reusar aquel schema para que `roofing` no
 * importe de `production`, que sí importa de `roofing` el DTO de largos.
 *
 * `qtyKg` opcional: sin él se monta todo el saldo del rollo, que es el caso normal.
 */
export const mountRoofingCoilSchema = z.object({
  coilId: z.string({ required_error: 'La bobina es obligatoria' }).uuid(),
  qtyKg: decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG }).optional(),
});
export type MountRoofingCoilInput = z.infer<typeof mountRoofingCoilSchema>;

/** Reportar los largos que de verdad salieron (D-083). Parcial, N veces, como D-058. */
export const reportRoofingPiecesSchema = z.object({
  /**
   * Bobina de la que salieron estas planchas. Opcional cuando la orden tiene una sola
   * montada, que es el caso normal. **Un reporte sale de un rollo**: el kilo teórico
   * depende del ancho y el espesor de ESA bobina (D-047), así que repartir un mismo reporte
   * entre dos rollos de geometría distinta daría un consumo que no es el de ninguno de los
   * dos. Varias bobinas por orden (RF-30) se cubren montándolas todas y reportando contra
   * cada una por turno.
   */
  coilId: z.string().uuid().optional(),
  pieces: roofingPiecesSchema,
  /**
   * D-146: kilos que planta dice que la bobina consumió en **este** reporte. Opcional, y
   * cuando viene es **dato declarado, no consumo**: el kardex sigue sacando de la bobina el
   * kilo teórico de los largos (D-047), y el consumo real se reconcilia al cerrar (D-089),
   * que es donde sale el despunte. Existe para que el papel de planta entre entero y se
   * pueda comparar contra lo teórico sin esperar al cierre.
   *
   * El tope lo pone el servicio, que es el único que conoce la geometría de la bobina
   * montada: el acumulado declarado no puede pasar del kilo teórico del **plan completo**.
   */
  consumedKg: decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG }).optional(),
  notes: z.string().trim().max(240).optional(),
  ...backdatableFields,
});
export type ReportRoofingPiecesInput = z.infer<typeof reportRoofingPiecesSchema>;

// --------------------------------------------------------------------------
// D-155 — el espacio de producción del pedido
// --------------------------------------------------------------------------

/**
 * Órdenes por encima de las cuales el espacio de producción deja las pestañas y pasa a lista
 * lateral (D-155). Seis pestañas todavía se leen de un vistazo en una tablet; ocho ya se
 * amontonan y hay que buscar la orden en vez de verla.
 *
 * Es una constante de presentación y el API no la lee: vive acá porque es el único lugar que
 * las dos mitades comparten, igual que las cotas de largos.
 */
export const MAX_ORDER_TABS = 6;

// --------------------------------------------------------------------------
// D-148 — todas las órdenes de un pedido de una vez
// --------------------------------------------------------------------------

/**
 * Generar la OP de cada ítem del pedido que todavía no la tiene (D-148).
 *
 * No cambia el modelo: sigue siendo **1 ítem = 1 OP** naciendo de su reserva (D-084), con
 * las mismas validaciones y el mismo `CHECK` de D-145. Lo único que agrega es que las N
 * órdenes se crean en **una transacción**, así que un pedido de ocho líneas no puede quedar
 * con cinco en cola y tres olvidadas. No tiene reversa propia: anular una orden por
 * separado ya existe (RF-33).
 */
export const createRoofingOrdersFromSalesOrderSchema = z.object({
  ...backdatableFields,
  notes: z.string().trim().max(500).optional(),
});
export type CreateRoofingOrdersFromSalesOrderInput = z.infer<
  typeof createRoofingOrdersFromSalesOrderSchema
>;

export const roofingBatchCreateResultSchema = z.object({
  /** Órdenes creadas, con su código, en el orden de las líneas del pedido. */
  created: z.array(z.object({ orderId: z.string().uuid(), code: z.string() })),
  /** Líneas que ya tenían una orden viva y por eso no generaron otra. */
  alreadyQueued: z.number().int(),
});
export type RoofingBatchCreateResultDto = z.infer<typeof roofingBatchCreateResultSchema>;

/** Una bobina montada, con la geometría que da el kilo teórico (D-047). */
export const roofingBatchCoilSchema = z.object({
  coilId: z.string().uuid(),
  /**
   * D-155: la fila de `production_order_consumptions`, que es lo que hace falta para bajar
   * la bobina desde la propia pestaña. Sin esto había que pedir el detalle de la orden solo
   * para traducir bobina → asignación, que es el N+1 que este DTO existe para evitar.
   */
  consumptionId: z.string().uuid(),
  coilCode: z.string(),
  widthMm: z.string(),
  thicknessMm: z.string(),
  densityFactor: z.string(),
  /** Kilos ya rolados de esa asignación: por encima de cero la bobina ya no se puede bajar. */
  consumedKg: z.string(),
  remainingKg: z.string(),
});
export type RoofingBatchCoilDto = z.infer<typeof roofingBatchCoilSchema>;

/**
 * Una orden de coberturas abierta, con todo lo que su pestaña del espacio de producción
 * necesita mostrar y operar sin pedir el detalle de cada orden por separado (D-147, D-155).
 */
export const roofingBatchOrderSchema = z.object({
  orderId: z.string().uuid(),
  code: z.string(),
  status: z.enum(PRODUCTION_ORDER_STATUSES),
  /**
   * D-155: la reserva que la orden viene a cumplir, para pedirle a
   * `GET /production/roofing/coils` las bobinas candidatas sin que la promesa del propio
   * pedido esconda su material. Null en una corrida a stock (D-140).
   */
  reservationId: z.string().uuid().nullable(),
  productId: z.string().uuid(),
  productSku: z.string(),
  productName: z.string(),
  /** Unidad del producto terminado: `NIU` en una plancha de catálogo, `MTR` a medida. */
  productUnit: z.string().max(20),
  /**
   * D-159: largo fijo de la plancha de catálogo (`null` en una cobertura a medida, D-118).
   *
   * El workspace lo necesita para editar el plan de una corrida a stock **por cantidad**: en
   * una plancha el largo no se elige, lo trae el SKU, y pedirlo otra vez es ofrecer un campo
   * cuya única respuesta correcta el sistema ya conoce. Con el plan vacío no hay ninguna
   * línea de la que sacarlo, que es justo cuando hace falta.
   */
  productLengthMm: z.string().nullable(),
  salesOrderId: z.string().uuid().nullable(),
  salesOrderCode: z.string().nullable(),
  customerName: z.string().nullable(),
  planItems: z.array(roofingPieceSchema),
  planMeters: z.string(),
  reportedMeters: z.string(),
  remainingMeters: z.string(),
  /** Largos del plan que todavía no se reportaron, para que la fila diga qué falta. */
  remainingPieces: z.array(roofingPieceSchema),
  /** Kilos ya declarados por los reportes vigentes (D-146). */
  declaredKg: z.string(),
  /** Kilos teóricos que las planchas reportadas consumieron. */
  reportedKg: z.string(),
  coils: z.array(roofingBatchCoilSchema),
  operationDate: z.string(),
});
export type RoofingBatchOrderDto = z.infer<typeof roofingBatchOrderSchema>;

/**
 * Cerrar la corrida (D-089).
 *
 * `consumedKg` son los kilos que planta declara que la bobina consumió de verdad; sin él se
 * asume la suma de los kilos teóricos reportados, o sea merma cero. La diferencia sale como
 * merma de despunte y **lo que quedó asignado y no consumido vuelve al almacén**: la bobina
 * sigue ahí, a diferencia del fleje de drywall que entra entero a la perfiladora. El
 * `reason` solo es obligatorio cuando esa merma supera el umbral; lo decide el API, que es
 * quien conoce los kilos reales.
 */
export const closeRoofingOrderSchema = z.object({
  ...backdatableFields,
  consumedKg: decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG }).optional(),
  notes: z.string().trim().max(240).optional(),
  reason: reasonSchema.optional(),
});
export type CloseRoofingOrderInput = z.infer<typeof closeRoofingOrderSchema>;

/**
 * Reportar **y cerrar** en una sola transacción (D-159).
 *
 * No es una comodidad de pantalla: es lo que le devuelve la bobina al pedido en el acto. Un
 * pedido de coberturas genera una OP por línea (D-084/D-148) y todas se rolan del mismo
 * rollo; mientras la primera siga abierta con la bobina montada, `assertStripsNotAssigned`
 * no deja montarla en la segunda, y hasta acá el encargado tenía que reportar, salir, cerrar
 * desde otra pantalla y volver. Partido en dos endpoints, además, el cierre podía fallar con
 * el reporte ya escrito y la orden quedaba a mitad de camino.
 *
 * El cuerpo es el del reporte más los dos campos del cierre, con prefijo `close` para que
 * ninguno se confunda con el `consumedKg` **del reporte**, que es otra cosa: aquel es el kilo
 * declarado de esta pasada (D-146) y este el consumo total de la corrida (D-089).
 */
export const reportAndCloseRoofingSchema = reportRoofingPiecesSchema.extend({
  closeConsumedKg: decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG }).optional(),
  closeReason: reasonSchema.optional(),
});
export type ReportAndCloseRoofingInput = z.infer<typeof reportAndCloseRoofingSchema>;

// --------------------------------------------------------------------------
// DTOs
// --------------------------------------------------------------------------

/**
 * Una bobina que la OP puede montar: el filtro de D-086 ya aplicado. No lleva ni un campo
 * de costo, por el mismo motivo que `rawMaterialStockSchema`: `/planta` la consulta un
 * SUPERVISOR_PLANTA y el costo del rollo no es asunto suyo.
 */
export const roofingCoilOptionSchema = z.object({
  coilId: z.string().uuid(),
  code: z.string(),
  typeKey: z.string(),
  finishCode: z.string(),
  widthMm: z.string(),
  thicknessMm: z.string(),
  colorId: z.string().uuid().nullable(),
  colorName: z.string().nullable(),
  colorHex: z.string().nullable(),
  availableKg: z.string(),
  /** Metros que salen de ese saldo con la geometría de esta bobina: lo que planta necesita ver. */
  estimatedMeters: z.string(),
});
export type RoofingCoilOptionDto = z.infer<typeof roofingCoilOptionSchema>;
