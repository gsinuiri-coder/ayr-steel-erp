import { z } from 'zod';
import { Decimal, decimalStringSchema, MAX_VALUE, roundTo, toDecimal } from '../decimal';
import { reasonSchema } from './coil';

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

/** Tope de planchas de un mismo largo en una línea. */
export const MAX_PIECE_QTY = 10_000;

// --------------------------------------------------------------------------
// Subítems de largo: la forma que comparten cotización, pedido, plan de corte y reporte
// --------------------------------------------------------------------------

export const roofingPieceInputSchema = z.object({
  /** Largo de la plancha en mm (escala MM, D-003). La UI lo muestra en metros. */
  lengthMm: decimalStringSchema('MM', { positive: true, max: MAX_VALUE.WIDTH_MM }).refine(
    (v) => {
      const d = toDecimal(v);
      return d.gte(MIN_PIECE_LENGTH_MM) && d.lte(MAX_PIECE_LENGTH_MM);
    },
    `El largo tiene que estar entre ${MIN_PIECE_LENGTH_MM / 1000} y ${MAX_PIECE_LENGTH_MM / 1000} metros`,
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
 * Crear la OP de coberturas. **`reservationId` es obligatorio**: no hay corrida sin pedido
 * detrás (RF-31, D-084), y ponerlo en el schema del endpoint es lo que hace que la regla no
 * dependa de que alguien la recuerde. El producto, la receta y el plan de corte salen de la
 * línea de pedido que esa reserva cubre; no se piden por separado, así no pueden discrepar.
 */
export const createRoofingOrderSchema = z.object({
  reservationId: z.string({ required_error: 'La reserva del pedido es obligatoria' }).uuid(),
  notes: z.string().trim().max(500).optional(),
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
  notes: z.string().trim().max(240).optional(),
});
export type ReportRoofingPiecesInput = z.infer<typeof reportRoofingPiecesSchema>;

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
  consumedKg: decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG }).optional(),
  notes: z.string().trim().max(240).optional(),
  reason: reasonSchema.optional(),
});
export type CloseRoofingOrderInput = z.infer<typeof closeRoofingOrderSchema>;

// --------------------------------------------------------------------------
// DTOs
// --------------------------------------------------------------------------

/**
 * Una bobina que la OP puede montar: el filtro de D-086 ya aplicado. No lleva ni un campo
 * de costo, por el mismo motivo que `reservableCoilSchema`: `/planta` la consulta un
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
