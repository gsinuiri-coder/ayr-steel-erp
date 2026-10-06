import { z } from 'zod';
import { AGING_BUCKETS } from './receivables-aging';
import { BUSINESS_LINES } from '../enums';
import { COIL_REPORT_LINES } from './report-lines';

/* ------------------------------------------------------------------------------------- *
 * cc26 (D-440). El Panel por rol.
 *
 * El Panel **no calcula**: cada cifra es un campo del DTO de su reporte, leído con la misma
 * función que ese reporte y para el mismo rango, y cada indicador lleva el enlace a ese
 * reporte con ese rango. Por eso aquí solo viven los rangos (que el enlace y la lectura
 * comparten) y la forma de la respuesta.
 * ------------------------------------------------------------------------------------- */

export interface DashboardRange {
  from: string;
  to: string;
}

/**
 * cc26 (D-443 provisional). El mes en curso hasta hoy y **el mismo tramo del mes anterior**
 * (del 1 al mismo día; si el mes anterior es más corto, hasta su último día). Comparar el mes
 * a medias con el mes anterior completo haría que todo mes empiece «cayendo».
 *
 * Aritmética de calendario sobre una fecha de negocio ya resuelta en Lima (`businessToday`).
 */
export function dashboardMonthRanges(today: string): {
  current: DashboardRange;
  previous: DashboardRange;
  previousMonth: DashboardRange;
} {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const pad = (n: number) => String(n).padStart(2, '0');
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  // Día 0 del mes siguiente = último día del mes (en UTC, sin zona).
  const prevLastDay = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
  const prevFrom = `${prevY}-${pad(prevM)}-01`;
  return {
    current: { from: `${y}-${pad(m)}-01`, to: today },
    previous: { from: prevFrom, to: `${prevY}-${pad(prevM)}-${pad(Math.min(d, prevLastDay))}` },
    previousMonth: { from: prevFrom, to: `${prevY}-${pad(prevM)}-${pad(prevLastDay)}` },
  };
}

const rangeSchema = z.object({ from: z.string(), to: z.string() });

const agingBucketsSchema = z.object(
  Object.fromEntries(AGING_BUCKETS.map((b) => [b, z.string()])) as Record<
    (typeof AGING_BUCKETS)[number],
    z.ZodString
  >,
);

export const adminDashboardSchema = z.object({
  asOf: z.string(),
  current: rangeSchema,
  previous: rangeSchema,
  /** `GET /reports/sales-margin` del mes en curso, «Todas»: sus `totals`, tal cual. */
  sales: z.object({
    salesPen: z.string(),
    noCostSalesPen: z.string(),
    costPen: z.string(),
    marginPen: z.string(),
    marginPct: z.string().nullable(),
    partialOrderCount: z.number().int(),
    excludedOrderCount: z.number().int(),
    excludedSalesPen: z.string(),
    untraceableOrderCount: z.number().int(),
    untraceableSalesPen: z.string(),
  }),
  /** El mismo reporte, para el mismo tramo del mes anterior: su `totals.salesPen`. */
  previousSalesPen: z.string(),
  /**
   * Lo facturado por día del mes en curso: la venta de cada comprobante del reporte, agrupada
   * por su fecha de emisión. Suma la venta de **todos** los pedidos del reporte, también los que
   * quedan fuera de los totales por su costo; por eso `Σ = salesPen + excludedSalesPen +
   * untraceableSalesPen` (D-444 provisional).
   */
  salesByDay: z.array(z.object({ date: z.string(), salesPen: z.string() })),
  /** `totalsByLine` del mismo reporte. `businessLine` nulo es «Sin línea» (D-398). */
  salesByLine: z.array(
    z.object({
      businessLine: z.enum(BUSINESS_LINES).nullable(),
      salesPen: z.string(),
      marginPen: z.string(),
      marginPct: z.string().nullable(),
    }),
  ),
  /** `GET /reports/receivables-aging` sin vendedor: sus `totals`. */
  receivables: z.object({
    balancePen: z.string(),
    /** Lo de los tramos vencidos del reporte (todos menos «Por vencer»), sumado tal cual. */
    overduePen: z.string(),
    buckets: agingBucketsSchema,
    documentCount: z.number().int(),
    customerCount: z.number().int(),
  }),
  /** `GET /reports/inventory-valuation`, «Todas»: sus `totals`. */
  inventory: z.object({
    totalValuePen: z.string(),
    coilValuePen: z.string(),
    productValuePen: z.string(),
  }),
  /**
   * `GET /reports/coil-waste` del mes en curso, por pestaña: las producciones «Fuera de
   * tolerancia» (D-388/D-389) que el reporte lista.
   */
  outOfTolerance: z.array(
    z.object({
      businessLine: z.enum(COIL_REPORT_LINES),
      productionCount: z.number().int(),
      coilCount: z.number().int(),
    }),
  ),
});
export type AdminDashboardDto = z.infer<typeof adminDashboardSchema>;
