import {
  addDays,
  BusinessLine,
  toDecimal,
  type AdminDashboardDto,
  type DashboardRange,
} from '@ayr/shared';

/**
 * cc26 (D-440). Lo que el Panel del administrador hace con las cifras: nada que cambie una
 * cifra. Rellenar con cero los días sin facturación (para que el eje sea el mes), comparar dos
 * totales del mismo reporte y armar los enlaces a cada reporte con el rango de la cifra.
 */

/** Cada día del rango, con lo facturado o cero. Los importes siguen siendo los del reporte. */
export function fillDays(
  range: DashboardRange,
  byDay: AdminDashboardDto['salesByDay'],
): { date: string; salesPen: string }[] {
  const known = new Map(byDay.map((d) => [d.date, d.salesPen]));
  const days: { date: string; salesPen: string }[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
    days.push({ date: d, salesPen: known.get(d) ?? '0.0000' });
  }
  return days;
}

/** Variación del mes en curso contra el mismo tramo del anterior (D-443), en %; sin base, nulo. */
export function variationPct(current: string, previous: string): string | null {
  const base = toDecimal(previous);
  if (base.lte(0)) return null;
  return toDecimal(current).minus(base).div(base).times(100).toFixed(1);
}

/** El reporte de ventas y margen para un rango (y una pestaña), los parámetros de D-395/D-401. */
export function salesMarginHref(range: DashboardRange, line?: BusinessLine | null): string {
  const qs = new URLSearchParams({ from: range.from, to: range.to });
  if (line) qs.set('linea', line);
  return `/reportes/ventas-margen?${qs.toString()}`;
}

/** La merma del rango; Coberturas Aluzinc es la pestaña por defecto y no se escribe (D-424). */
export function coilWasteHref(range: DashboardRange, line: BusinessLine): string {
  const qs = new URLSearchParams({ from: range.from, to: range.to });
  if (line !== BusinessLine.METALLIC_ROOFING) qs.set('linea', line);
  return `/reportes/merma?${qs.toString()}`;
}
