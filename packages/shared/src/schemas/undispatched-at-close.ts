import { z } from 'zod';
import { operationDateSchema } from './operation';

/**
 * cc56 (D-670) — **facturado y no despachado al cierre.** Los comprobantes de un período cuya
 * mercadería sale del kardex **después** del cierre (D-278: el despacho va a la fecha del último
 * parte) o todavía no salió. Es una lectura aparte para el contador: no cambia Ventas y margen ni el
 * inventario valorizado; dice qué parte del inventario al cierre ya está vendida y con qué costo.
 */
export const undispatchedAtCloseQuerySchema = z
  .object({ from: operationDateSchema, to: operationDateSchema })
  .refine((v) => v.from <= v.to, { message: 'El rango termina antes de empezar' });
export type UndispatchedAtCloseQuery = z.infer<typeof undispatchedAtCloseQuerySchema>;

export const UNDISPATCHED_AT_CLOSE_STATUSES = [
  'DESPACHADO_DESPUES',
  'PARCIAL',
  'SIN_SALIDA',
] as const;
export type UndispatchedAtCloseStatus = (typeof UNDISPATCHED_AT_CLOSE_STATUSES)[number];

export const UNDISPATCHED_AT_CLOSE_STATUS_LABELS: Record<UndispatchedAtCloseStatus, string> = {
  DESPACHADO_DESPUES: 'Salió después del cierre',
  PARCIAL: 'Parte pendiente al cierre',
  SIN_SALIDA: 'Todavía sin salida',
};

export const undispatchedAtCloseRowSchema = z.object({
  documentId: z.string().uuid(),
  number: z.string(),
  issueDate: z.string(),
  customerName: z.string(),
  /** Venta sin IGV del comprobante (la de Ventas y margen). */
  salesPen: z.string(),
  /** El costo con que Ventas y margen lo cuenta (D-667), en la proporción pendiente; `null` sin costo comparable. */
  estimatedCostPen: z.string().nullable(),
  /** Fechas de salida real de sus despachos declarados, en orden. */
  dispatchDates: z.array(z.string()),
  status: z.enum(UNDISPATCHED_AT_CLOSE_STATUSES),
});
export type UndispatchedAtCloseRowDto = z.infer<typeof undispatchedAtCloseRowSchema>;

export const undispatchedAtCloseSchema = z.object({
  from: z.string(),
  to: z.string(),
  rows: z.array(undispatchedAtCloseRowSchema),
  totals: z.object({
    count: z.number().int(),
    salesPen: z.string(),
    estimatedCostPen: z.string(),
    withoutCostCount: z.number().int(),
  }),
});
export type UndispatchedAtCloseDto = z.infer<typeof undispatchedAtCloseSchema>;
