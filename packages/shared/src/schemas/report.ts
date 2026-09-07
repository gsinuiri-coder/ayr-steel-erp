import { z } from 'zod';
import { BUSINESS_LINES, COIL_KINDS, COIL_STATUSES } from '../enums';
import { monthSchema } from './operation';

/**
 * Reportes con corte mensual (RF-90..RF-94, adelanto de la Fase 7f).
 *
 * Existen recién ahora porque hasta D-124 no había con qué cortarlos: sin fecha de
 * operación, todo lo registrado quedaba fechado el día en que se tipeó y un reporte de
 * agosto no podía distinguirse de uno de septiembre.
 */
export const coilMonthReportQuerySchema = z.object({
  /** Mes del corte, `YYYY-MM`. Por defecto, el mes en curso en Lima. */
  month: monthSchema.optional(),
  businessLine: z.enum(BUSINESS_LINES).optional(),
});
export type CoilMonthReportQuery = z.infer<typeof coilMonthReportQuerySchema>;

export const coilMonthReportRowSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  /** RF-14: acabado + espesor, sin ancho. */
  typeKey: z.string(),
  kind: z.enum(COIL_KINDS),
  businessLine: z.enum(BUSINESS_LINES),
  colorName: z.string().nullable(),
  widthMm: z.string(),
  /**
   * Saldo de kardex al **primer día del mes**, antes de cualquier movimiento del mes. Es la
   * columna que el dueño pidió en lugar de la empresa proveedora: sale de sumar los
   * movimientos con \`operationDate\` anterior al corte, y por eso no existía antes de D-124.
   */
  openingKg: z.string(),
  /** Peso nominal con el que la bobina se dio de alta (RF-13). No cambia con los consumos. */
  weightKg: z.string(),
  /** Saldo de kardex al **último día del mes**. En el mes en curso, es el saldo de hoy. */
  closingKg: z.string(),
  /** Costo por kg del documento, sin IGV (D-038). `null` para quien no ve costos. */
  unitCostPerKg: z.string().nullable(),
  status: z.enum(COIL_STATUSES),
  /** D-124: día de negocio en que la bobina entró. */
  operationDate: z.string(),
});
export type CoilMonthReportRowDto = z.infer<typeof coilMonthReportRowSchema>;

export const coilMonthReportSchema = z.object({
  month: monthSchema,
  /** Primer y último día del mes, `YYYY-MM-DD`, para rotular el corte sin recalcularlo. */
  from: z.string(),
  to: z.string(),
  rows: z.array(coilMonthReportRowSchema),
  totals: z.object({
    openingKg: z.string(),
    weightKg: z.string(),
    closingKg: z.string(),
  }),
});
export type CoilMonthReportDto = z.infer<typeof coilMonthReportSchema>;
