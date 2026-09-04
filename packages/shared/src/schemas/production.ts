import { z } from 'zod';
import {
  decimalStringSchema,
  MAX_VALUE,
  roundTo,
  toDecimal,
  type Decimal,
  type DecimalInput,
} from '../decimal';
import { BUSINESS_LINES, PRODUCTION_ORDER_STATUSES, PRODUCTION_REPORT_STATUSES } from '../enums';
import { reasonSchema } from './coil';

/**
 * Producción de drywall (RF-32..35, RF-39; D-055..D-060).
 *
 * Modelo en una línea: una OP toma flejes (`coils kind=STRIP`) contra la receta del
 * producto (D-059), reporta piezas en N eventos (D-058) y se cierra. La unidad primaria
 * del producto terminado son **piezas** (D-055); los kilos son derivados
 * (`piezas × kgPerPiece`). Asignar un fleje no mueve kardex (D-060, mismo criterio que
 * D-050): el kardex sale con cada reporte y, al cerrar, con la merma de proceso (D-057).
 */

// --------------------------------------------------------------------------
// Constantes y aritmética compartida entre web y API
// --------------------------------------------------------------------------

/**
 * Tope de flejes asignados a una misma OP. Cada uno abre una fila y, en cada reporte,
 * puede abrir un movimiento de kardex dentro de la transacción que sostiene sus locks —
 * mismo motivo que `MAX_SPLIT_CHILDREN` en el partido (RF-15).
 */
export const MAX_ORDER_STRIPS = 20;

/** Tope de piezas de un solo reporte. Una corrida real de drywall no pasa de miles. */
export const MAX_REPORT_PIECES = 1_000_000;

/**
 * Tope de reportes vigentes por orden. Una corrida real reporta por tanda, no por pieza;
 * sin cota, `POST /:id/report` de una pieza a la vez haría crecer el detalle de la OP sin
 * límite y la lista de planta tendría que materializarlo entero en cada recarga.
 */
export const MAX_ORDER_REPORTS = 200;

/**
 * Fracción de merma de proceso que una orden puede cerrar **sin motivo escrito**. Por
 * encima, cerrar exige un `reason` como cualquier otra merma (RF-17/D-040): un cierre con
 * un cuarto del material sin convertir en piezas es una baja de inventario, y una baja de
 * inventario sin motivo no queda auditable (RF-95).
 */
export const MAX_SCRAP_RATIO_WITHOUT_REASON = 0.1;

/**
 * Kilo teórico de una pieza desde su geometría y el factor de densidad del acabado
 * (D-047, RF-25). `widthMm × thicknessMm × lengthMm` da mm³; el factor viene en t/m³
 * (acero ≈ 7.85), así que dividir entre 1 000 000 deja kilos:
 * `mm³ / 1e9 = m³`, `× (factor × 1000) = kg` ⇒ `mm³ × factor / 1e6`.
 *
 * Vive acá y no en el API para que el maestro (web) sugiera exactamente el mismo número
 * que el API valida, igual que las constantes del partido (RF-15).
 */
export function theoreticalKgPerPiece(input: {
  widthMm: DecimalInput;
  thicknessMm: DecimalInput;
  pieceLengthMm: DecimalInput;
  densityFactor: DecimalInput;
}): Decimal {
  const volume = toDecimal(input.widthMm)
    .times(toDecimal(input.thicknessMm))
    .times(toDecimal(input.pieceLengthMm));
  return roundTo(volume.times(toDecimal(input.densityFactor)).div(1_000_000), 'KG');
}

/** `piezas × kgPerPiece`, redondeado a la escala de kilos (D-003). */
export function theoreticalKg(pieces: number, kgPerPiece: DecimalInput): Decimal {
  return roundTo(toDecimal(kgPerPiece).times(pieces), 'KG');
}

// --------------------------------------------------------------------------
// D-059 — receta en el maestro de productos
// --------------------------------------------------------------------------

const piecesSchema = z
  .number({ required_error: 'Las piezas son obligatorias' })
  .int('Las piezas se cuentan en enteros')
  .min(1, 'Al menos una pieza')
  .max(MAX_REPORT_PIECES, `Máximo ${MAX_REPORT_PIECES} piezas`);

export const upsertProductBomSchema = z.object({
  finishId: z.string({ required_error: 'El acabado del fleje es obligatorio' }).uuid(),
  inputThicknessMm: decimalStringSchema('MM', {
    positive: true,
    max: MAX_VALUE.THICKNESS_MM,
  }),
  inputWidthMm: decimalStringSchema('MM', { positive: true, max: MAX_VALUE.WIDTH_MM }),
  pieceLengthMm: decimalStringSchema('MM', { positive: true, max: MAX_VALUE.WIDTH_MM }),
  /**
   * Kilo teórico por pieza. Si no viene, el API lo calcula con `theoreticalKgPerPiece`
   * desde la geometría y el `densityFactor` del acabado (D-047); mandarlo es el override
   * que el maestro usa cuando planta pesó el perfil real.
   */
  kgPerPiece: decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG }).optional(),
  isActive: z.boolean().optional(),
});
export type UpsertProductBomInput = z.infer<typeof upsertProductBomSchema>;

export const productBomSchema = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  productSku: z.string(),
  productName: z.string(),
  businessLine: z.enum(BUSINESS_LINES),
  finishId: z.string().uuid(),
  finishCode: z.string(),
  finishName: z.string(),
  inputThicknessMm: z.string(),
  inputWidthMm: z.string(),
  pieceLengthMm: z.string(),
  kgPerPiece: z.string(),
  /** El kilo que sale de la geometría; difiere de `kgPerPiece` si el maestro lo sobreescribió. */
  suggestedKgPerPiece: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProductBomDto = z.infer<typeof productBomSchema>;

// --------------------------------------------------------------------------
// RF-34 — orden de producción
// --------------------------------------------------------------------------

export const createProductionOrderSchema = z.object({
  productId: z.string({ required_error: 'El producto a fabricar es obligatorio' }).uuid(),
  targetPieces: piecesSchema.optional(),
  notes: z.string().trim().max(500).optional(),
  /**
   * D-054/D-066: reserva de un pedido que esta OP viene a cumplir. Con ella, la orden puede
   * montar el material reservado (que para cualquier otra orden está bloqueado) y, al
   * emitir el primer material, la reserva pasa a `CONSUMIDA`. Sin ella, la OP es una
   * corrida de stock como las de Fase 4.
   */
  reservationId: z.string().uuid().optional(),
});
export type CreateProductionOrderInput = z.infer<typeof createProductionOrderSchema>;

/**
 * Asignar un fleje a la OP. `qtyKg` opcional: sin él se toma todo el saldo disponible
 * del fleje, que es el caso normal en planta (el operario monta el rollo entero).
 */
export const consumeStripSchema = z.object({
  coilId: z.string({ required_error: 'El fleje es obligatorio' }).uuid(),
  qtyKg: decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG }).optional(),
});
export type ConsumeStripInput = z.infer<typeof consumeStripSchema>;

/** Reporte parcial de piezas buenas (D-058). */
export const reportPiecesSchema = z.object({
  pieces: piecesSchema,
  notes: z.string().trim().max(240).optional(),
});
export type ReportPiecesInput = z.infer<typeof reportPiecesSchema>;

/**
 * Cerrar la OP: la merma de proceso sale sola por diferencia (D-057), sin input. El
 * `reason` solo es obligatorio cuando esa merma supera `MAX_SCRAP_RATIO_WITHOUT_REASON`
 * del material asignado — el API es quien decide, porque solo él conoce los kilos reales.
 */
export const closeProductionOrderSchema = z.object({
  notes: z.string().trim().max(240).optional(),
  reason: reasonSchema.optional(),
});
export type CloseProductionOrderInput = z.infer<typeof closeProductionOrderSchema>;

/** Anular la OP y liberar los flejes no consumidos. Motivo obligatorio (RF-95). */
export const cancelProductionOrderSchema = z.object({ reason: reasonSchema });
export type CancelProductionOrderInput = z.infer<typeof cancelProductionOrderSchema>;

// --------------------------------------------------------------------------
// DTOs
// --------------------------------------------------------------------------

export const productionOrderConsumptionSchema = z.object({
  id: z.string().uuid(),
  coilId: z.string().uuid(),
  coilCode: z.string(),
  widthMm: z.string(),
  assignedKg: z.string(),
  consumedKg: z.string(),
  /** `assignedKg − consumedKg`: lo que todavía puede convertirse en piezas o en merma. */
  remainingKg: z.string(),
  /** Saldo de kardex del fleje, para que planta vea si le queda material fuera de la OP. */
  coilAvailableKg: z.string(),
  /** Bobina madre del fleje: la trazabilidad hasta el rollo comprado (RF-15/RF-41). */
  parentCoilId: z.string().uuid().nullable(),
  parentCoilCode: z.string().nullable(),
  releasedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ProductionOrderConsumptionDto = z.infer<typeof productionOrderConsumptionSchema>;

export const productionReportSchema = z.object({
  id: z.string().uuid(),
  pieces: z.number().int(),
  theoreticalKg: z.string(),
  /**
   * Costos en soles (D-042). No van enmascarados por rol como en `/inventory`: el módulo
   * entero está cerrado a ADMINISTRADOR y SUPERVISOR_PLANTA (§3.4), VENDEDOR no llega
   * acá. Si Fase 5 abriera alguna ruta de producción a VENDEDOR, hay que enmascararlos
   * como hace `InventoryService`, no confiar en este comentario.
   */
  materialCostPen: z.string(),
  unitCostPen: z.string(),
  status: z.enum(PRODUCTION_REPORT_STATUSES),
  notes: z.string().nullable(),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  revertedAt: z.string().nullable(),
});
export type ProductionReportDto = z.infer<typeof productionReportSchema>;

export const productionOrderSchema = z.object({
  id: z.string().uuid(),
  /** `OP-000123`, derivado del correlativo. */
  code: z.string(),
  businessLine: z.enum(BUSINESS_LINES),
  productId: z.string().uuid(),
  productSku: z.string(),
  productName: z.string(),
  status: z.enum(PRODUCTION_ORDER_STATUSES),
  targetPieces: z.number().int().nullable(),
  /** D-054: reserva consumida por esta OP. Siempre null en Fase 4. */
  reservationId: z.string().uuid().nullable(),
  notes: z.string().nullable(),
  /** Piezas buenas acumuladas de los reportes vigentes. */
  piecesReported: z.number().int(),
  /** Kilos asignados y kilos ya consumidos, sumando los flejes vivos de la OP. */
  assignedKg: z.string(),
  consumedKg: z.string(),
  /** Merma de proceso: solo tiene valor cuando la OP está cerrada (D-057). */
  scrapKg: z.string().nullable(),
  materialCostPen: z.string().nullable(),
  overheadCostPen: z.string().nullable(),
  totalCostPen: z.string().nullable(),
  unitCostPen: z.string().nullable(),
  bom: productBomSchema,
  consumptions: z.array(productionOrderConsumptionSchema),
  reports: z.array(productionReportSchema),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  closedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
});
export type ProductionOrderDto = z.infer<typeof productionOrderSchema>;

export const productionOrderListItemSchema = productionOrderSchema
  .omit({ bom: true, consumptions: true, reports: true })
  .extend({ stripCount: z.number().int() });
export type ProductionOrderListItemDto = z.infer<typeof productionOrderListItemSchema>;

export const productionOrderQuerySchema = z.object({
  status: z.enum(PRODUCTION_ORDER_STATUSES).optional(),
  productId: z.string().uuid().optional(),
  businessLine: z.enum(BUSINESS_LINES).optional(),
});
export type ProductionOrderQuery = z.infer<typeof productionOrderQuerySchema>;

/**
 * Un fleje candidato para una OP: los que `/planta` ofrece al operario. Sale del stock
 * de flejes (RF-42) filtrado por la receta del producto y por no estar tomado por otra OP.
 */
export const productionStripOptionSchema = z.object({
  coilId: z.string().uuid(),
  code: z.string(),
  widthMm: z.string(),
  thicknessMm: z.string(),
  finishCode: z.string(),
  availableKg: z.string(),
  parentCoilCode: z.string().nullable(),
  /** Piezas que salen de ese saldo según la receta; lo que planta necesita ver. */
  estimatedPieces: z.number().int(),
});
export type ProductionStripOptionDto = z.infer<typeof productionStripOptionSchema>;
