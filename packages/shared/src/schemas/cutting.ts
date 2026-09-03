import { z } from 'zod';
import { decimalStringSchema, MAX_VALUE } from '../decimal';
import { BUSINESS_LINES, CUTTING_ORDER_COIL_STATUSES, CUTTING_ORDER_STATUSES } from '../enums';
import { MAX_SPLIT_CHILDREN, MAX_SPLIT_ROWS, MIN_CHILD_WIDTH_MM, reasonSchema } from './coil';

/**
 * Corte tercerizado (RF-40..42, D-049/D-050). Enviar una bobina a un tercero no mueve
 * kardex (D-050); el plan de anchos es una intención (RF-40) que se contrasta contra lo
 * realmente recibido (RF-41), que sí ejecuta el partido (`planCoilSplit`) y crea flejes
 * `kind=STRIP`.
 */

/** Una fila de plan/recepción: un ancho y cuántas tiras iguales de ese ancho. */
const widthCountSchema = z.object({
  widthMm: decimalStringSchema('MM', { positive: true, max: MAX_VALUE.WIDTH_MM }).refine(
    (v) => Number(v) >= MIN_CHILD_WIDTH_MM,
    `El ancho de cada fleje debe ser de al menos ${MIN_CHILD_WIDTH_MM} mm`,
  ),
  stripsCount: z
    .number()
    .int()
    .min(1, 'Al menos una tira')
    .max(MAX_SPLIT_CHILDREN, `Máximo ${MAX_SPLIT_CHILDREN} tiras iguales`),
});
export type WidthCountInput = z.infer<typeof widthCountSchema>;

const widthPlanSchema = z
  .array(widthCountSchema)
  .min(1, 'El plan necesita al menos un ancho')
  .max(MAX_SPLIT_ROWS, `Un plan admite hasta ${MAX_SPLIT_ROWS} filas de anchos`)
  .superRefine((rows, ctx) => {
    // Cada tira abre una fila de `coils` y un movimiento de kardex dentro de la misma
    // transacción que sostiene el lock de la madre (igual razón que `createCoilSplitSchema`
    // en `coil.ts`): sin este tope total, filas dentro del límite individual podían sumar
    // cientos de tiras en una sola recepción.
    const total = rows.reduce((acc, r) => acc + r.stripsCount, 0);
    if (total > MAX_SPLIT_CHILDREN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `El plan admite hasta ${MAX_SPLIT_CHILDREN} tiras en total`,
      });
    }
  });

// --------------------------------------------------------------------------
// RF-40 — enviar bobinas a corte
// --------------------------------------------------------------------------

const cuttingOrderCoilInputSchema = z.object({
  coilId: z.string({ required_error: 'La bobina es obligatoria' }).uuid(),
  widthPlanMm: widthPlanSchema,
  /** Merma de corte esperada, en mm de ancho (§ mismo criterio que el partido interno). */
  expectedKerfLossMm: decimalStringSchema('MM', { max: MAX_VALUE.WIDTH_MM }).default('0.00'),
});
export type CuttingOrderCoilInput = z.infer<typeof cuttingOrderCoilInputSchema>;

export const createCuttingOrderSchema = z.object({
  supplierId: z.string({ required_error: 'El proveedor de corte es obligatorio' }).uuid(),
  notes: z.string().trim().max(500).optional(),
  coils: z
    .array(cuttingOrderCoilInputSchema)
    .min(1, 'La orden necesita al menos una bobina')
    .max(50, 'Una orden admite hasta 50 bobinas'),
});
export type CreateCuttingOrderInput = z.infer<typeof createCuttingOrderSchema>;

// --------------------------------------------------------------------------
// RF-41 — recibir flejes (permite parcial, por bobina)
// --------------------------------------------------------------------------

export const receiveCuttingOrderCoilSchema = z.object({
  receivedWidthsMm: widthPlanSchema,
  /** Kilos realmente recibidos; base del prorrateo de `planCoilSplit`. */
  receivedWeightKg: decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG }),
  kerfLossMm: decimalStringSchema('MM', { max: MAX_VALUE.WIDTH_MM }).default('0.00'),
});
export type ReceiveCuttingOrderCoilInput = z.infer<typeof receiveCuttingOrderCoilSchema>;

// --------------------------------------------------------------------------
// RF-22 — cancelar
// --------------------------------------------------------------------------

export const cancelCuttingOrderSchema = z.object({ reason: reasonSchema });
export type CancelCuttingOrderInput = z.infer<typeof cancelCuttingOrderSchema>;

// --------------------------------------------------------------------------
// DTOs
// --------------------------------------------------------------------------

const widthCountDtoSchema = z.object({
  widthMm: z.string(),
  stripsCount: z.number().int(),
});

export const cuttingOrderCoilSchema = z.object({
  id: z.string().uuid(),
  cuttingOrderId: z.string().uuid(),
  coilId: z.string().uuid(),
  coilCode: z.string(),
  coilWidthMm: z.string(),
  coilAvailableKg: z.string(),
  widthPlanMm: z.array(widthCountDtoSchema),
  expectedKerfLossMm: z.string(),
  status: z.enum(CUTTING_ORDER_COIL_STATUSES),
  receivedAt: z.string().nullable(),
  receivedWidthsMm: z.array(widthCountDtoSchema).nullable(),
  receivedWeightKg: z.string().nullable(),
  receivedKerfLossMm: z.string().nullable(),
  receivedKerfLossKg: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  /** Última reversa de recepción (Fase 3b), si la hubo. */
  revertedAt: z.string().nullable(),
  /** Flejes creados al recibir esta fila (vacío mientras siga `SENT`). */
  strips: z.array(
    z.object({
      id: z.string().uuid(),
      code: z.string(),
      widthMm: z.string(),
      weightKg: z.string(),
    }),
  ),
  createdAt: z.string(),
});
export type CuttingOrderCoilDto = z.infer<typeof cuttingOrderCoilSchema>;

export const cuttingOrderSchema = z.object({
  id: z.string().uuid(),
  supplierId: z.string().uuid(),
  supplierName: z.string(),
  businessLine: z.enum(BUSINESS_LINES),
  status: z.enum(CUTTING_ORDER_STATUSES),
  sentAt: z.string(),
  cancelledAt: z.string().nullable(),
  notes: z.string().nullable(),
  /** Servicios de corte (RF-41) ya imputados a esta orden. */
  services: z.array(
    z.object({
      purchaseId: z.string().uuid(),
      documentLabel: z.string(),
      status: z.string(),
      amountPen: z.string(),
    }),
  ),
  coils: z.array(cuttingOrderCoilSchema),
  createdAt: z.string(),
});
export type CuttingOrderDto = z.infer<typeof cuttingOrderSchema>;

export const cuttingOrderListItemSchema = cuttingOrderSchema
  .omit({ coils: true, services: true })
  .extend({
    coilCount: z.number().int(),
  });
export type CuttingOrderListItemDto = z.infer<typeof cuttingOrderListItemSchema>;

export const cuttingOrderQuerySchema = z.object({
  businessLine: z.enum(BUSINESS_LINES).optional(),
  supplierId: z.string().uuid().optional(),
  status: z.enum(CUTTING_ORDER_STATUSES).optional(),
});
export type CuttingOrderQuery = z.infer<typeof cuttingOrderQuerySchema>;

/** Stock de flejes por ancho (RF-42): agrupado por `typeKey` + `widthMm`, a diferencia
 *  del inventario de bobinas (RF-51), que agrupa solo por `typeKey`. */
export const stripStockRowSchema = z.object({
  typeKey: z.string(),
  finishCode: z.string(),
  thicknessMm: z.string(),
  widthMm: z.string(),
  qtyKg: z.string(),
  avgCostPen: z.string().nullable(),
  totalValuePen: z.string().nullable(),
  coilCount: z.number().int(),
});
export type StripStockRowDto = z.infer<typeof stripStockRowSchema>;

export const stripStockQuerySchema = z.object({
  businessLine: z.enum(BUSINESS_LINES).optional(),
});
export type StripStockQuery = z.infer<typeof stripStockQuerySchema>;
