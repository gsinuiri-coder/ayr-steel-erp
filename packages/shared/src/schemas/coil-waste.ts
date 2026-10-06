import { z } from 'zod';
import { COIL_KINDS, COIL_STATUSES } from '../enums';
import { operationDateSchema } from './operation';
import { COIL_REPORT_LINES } from './report-lines';

/* ------------------------------------------------------------------------------------- *
 * cc25 — Merma por bobina (D-424, D-425, D-429..D-431, D-433).
 *
 * Por bobina, con las pestañas Coberturas Aluzinc y Drywall (sin «Todas», D-424). Entran las
 * bobinas con producción en el rango (D-425), y sus cifras son las de los movimientos de kardex
 * del rango (D-429):
 *
 * - consumido: las salidas `PRODUCTION` de la bobina (lo que sacaron los reportes de planta);
 * - teórico: el kilo teórico de esos reportes (D-047), atribuido a la bobina (D-433);
 * - diferencia: consumido − teórico (negativa si un reporte quedó topado en lo montado, D-246);
 * - despunte: las salidas `SCRAP` del cierre de una OP (D-057, D-089);
 * - ajuste de cierre: el `CLOSE_ADJUSTMENT` de la bobina (D-164), salida positiva y entrada
 *   negativa;
 * - merma = diferencia + despunte + ajuste, y porcentaje = merma ÷ teórico (D-430);
 * - otra merma (manual, RF-17): informativa, fuera de la merma (D-431).
 *
 * Nada se estima: si una producción no tiene teórico atribuible, la bobina lo declara y su
 * merma queda sin calcular (D-425).
 * ------------------------------------------------------------------------------------- */

/** El estándar contra el que se compara el porcentaje: la merma de `standardDensityFactor`. */
export const STANDARD_WASTE_PCT = '1.00';

/** Las pestañas del reporte: las de bobinas (D-424). */
export type CoilWasteLine = (typeof COIL_REPORT_LINES)[number];

export const coilWasteQuerySchema = z
  .object({
    from: operationDateSchema,
    to: operationDateSchema,
    /** La pestaña; sin ella, Coberturas Aluzinc (D-418). */
    businessLine: z.enum(COIL_REPORT_LINES).optional(),
  })
  .refine((v) => v.from <= v.to, { message: 'El rango termina antes de empezar' });
export type CoilWasteQuery = z.infer<typeof coilWasteQuerySchema>;

/** Por qué una producción no tiene teórico atribuible a la bobina (D-433). */
export const MISSING_THEORETICAL_REASONS = [
  /** La salida de producción no apunta a un reporte de planta. */
  'NO_REPORT',
  /** El reporte tiene teórico cero y sacó kilos. */
  'ZERO_THEORETICAL',
  /** El reporte salió de varias bobinas y lo que sacó no es su teórico: no se puede repartir. */
  'SPLIT_NOT_THEORETICAL',
] as const;
export type MissingTheoreticalReason = (typeof MISSING_THEORETICAL_REASONS)[number];

export const MISSING_THEORETICAL_LABELS: Record<MissingTheoreticalReason, string> = {
  NO_REPORT: 'Salida de producción sin reporte de planta',
  ZERO_THEORETICAL: 'El reporte no tiene kilo teórico',
  SPLIT_NOT_THEORETICAL:
    'El reporte salió de varias bobinas con kilos distintos de su teórico: no se reparte',
};

export const coilWasteProductionSchema = z.object({
  /** El reporte de planta; `null` si la salida no apunta a uno (`NO_REPORT`). */
  reportId: z.string().uuid().nullable(),
  productionOrderId: z.string().uuid().nullable(),
  productionOrderCode: z.string().nullable(),
  operationDate: z.string(),
  /** Lo que este reporte sacó de esta bobina. */
  consumedKg: z.string(),
  /** El teórico atribuido a esta bobina; `null` con `missingTheoretical`. */
  theoreticalKg: z.string().nullable(),
  missingTheoretical: z.enum(MISSING_THEORETICAL_REASONS).nullable(),
  /** D-388/D-389: confirmada con la casilla «Fuera de tolerancia». */
  outOfTolerance: z
    .object({
      /** «Bobina más liviana que el nominal», u «Otro: <detalle>». */
      label: z.string(),
      excessPct: z.string(),
    })
    .nullable(),
});
export type CoilWasteProductionDto = z.infer<typeof coilWasteProductionSchema>;

export const coilWasteRowSchema = z.object({
  coilId: z.string().uuid(),
  code: z.string(),
  kind: z.enum(COIL_KINDS),
  /** RF-14: acabado + espesor. */
  typeKey: z.string(),
  colorName: z.string().nullable(),
  widthMm: z.string(),
  status: z.enum(COIL_STATUSES),
  consumedKg: z.string(),
  /** `null` si alguna producción de la bobina no tiene teórico atribuible. */
  theoreticalKg: z.string().nullable(),
  differenceKg: z.string().nullable(),
  trimKg: z.string(),
  closeAdjustmentKg: z.string(),
  wasteKg: z.string().nullable(),
  /** Porcentaje con dos decimales; `null` sin teórico o con teórico cero. */
  wastePct: z.string().nullable(),
  /** El porcentaje pasa el 1 % estándar. */
  overStandard: z.boolean(),
  /** D-431: merma manual (RF-17), informativa. */
  manualScrapKg: z.string(),
  productions: z.array(coilWasteProductionSchema),
});
export type CoilWasteRowDto = z.infer<typeof coilWasteRowSchema>;

export const coilWasteSchema = z.object({
  from: z.string(),
  to: z.string(),
  businessLine: z.enum(COIL_REPORT_LINES),
  standardPct: z.string(),
  /** Por código de bobina. */
  rows: z.array(coilWasteRowSchema),
  totals: z.object({
    coilCount: z.number().int(),
    /** Todas las bobinas: el consumo es el del kardex del rango. */
    consumedKg: z.string(),
    trimKg: z.string(),
    closeAdjustmentKg: z.string(),
    manualScrapKg: z.string(),
    /**
     * Solo las bobinas con teórico completo (`comparableCoilCount`): el consumo, el teórico, la
     * diferencia, la merma y su porcentaje de esas bobinas. Sumar el teórico de una bobina
     * incompleta sería estimar la parte que falta.
     */
    comparableCoilCount: z.number().int(),
    comparableConsumedKg: z.string(),
    theoreticalKg: z.string(),
    differenceKg: z.string(),
    wasteKg: z.string(),
    wastePct: z.string().nullable(),
  }),
  /**
   * D-424: las bobinas con producción en el rango que se vendieron enteras no entran. Se
   * declaran para que el consumo de producción del rango siga cuadrando con el kardex.
   */
  soldWhole: z.object({
    count: z.number().int(),
    consumedKg: z.string(),
    codes: z.array(z.string()),
  }),
});
export type CoilWasteDto = z.infer<typeof coilWasteSchema>;
