import { z } from 'zod';
import { decimalStringSchema } from '../decimal';
import { BUSINESS_LINES, COIL_STATUSES, CURRENCIES } from '../enums';

/**
 * Bobina de acero (RF-10..RF-14). Alta siempre por una de las tres vías de Fase 2a
 * (compra manual, XML de factura, planilla); no hay endpoint de creación suelta.
 */
export const coilSchema = z.object({
  id: z.string().uuid(),
  /** RF-13: `{supplierCode}-{finishCode}-{thicknessMm}-{weightKg}-{correlativo}`. */
  code: z.string(),
  /** RF-14: `{finishCode}-{thicknessMm}`, ignora el ancho. */
  typeKey: z.string(),
  businessLine: z.enum(BUSINESS_LINES),
  supplierId: z.string().uuid(),
  supplierName: z.string(),
  purchaseId: z.string().uuid().nullable(),
  purchaseLabel: z.string().nullable(),
  finishId: z.string().uuid(),
  finishCode: z.string(),
  finishName: z.string(),
  weightKg: z.string(),
  widthMm: z.string(),
  thicknessMm: z.string(),
  currency: z.enum(CURRENCIES),
  exchangeRate: z.string(),
  /** Costo por kg SIN IGV (D-038). */
  unitCostPerKg: z.string(),
  totalCost: z.string(),
  totalCostPen: z.string(),
  status: z.enum(COIL_STATUSES),
  parentCoilId: z.string().uuid().nullable(),
  /** Kilos disponibles según el kardex; puede diferir de `weightKg` tras consumos. */
  availableKg: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CoilDto = z.infer<typeof coilSchema>;

/** Filtros de la lista de bobinas por línea (RF-23). */
export const coilQuerySchema = z.object({
  businessLine: z.enum(BUSINESS_LINES).optional(),
  finishId: z.string().uuid().optional(),
  thicknessMm: decimalStringSchema('MM', { positive: true }).optional(),
  status: z.enum(COIL_STATUSES).optional(),
  supplierId: z.string().uuid().optional(),
  search: z.string().trim().max(80).optional(),
});
export type CoilQuery = z.infer<typeof coilQuerySchema>;
