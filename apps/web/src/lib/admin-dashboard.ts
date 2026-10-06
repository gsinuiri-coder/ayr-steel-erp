import {
  addDays,
  BusinessLine,
  toDecimal,
  toFixedString,
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

/**
 * Variación del mes en curso contra el mismo tramo del anterior (D-443), en %, con su signo y un
 * decimal («+10.0», «-3.2», «0.0»: lo que redondea a cero no lleva signo). Sin base, nulo.
 */
export function variationPct(current: string, previous: string): string | null {
  const base = toDecimal(previous);
  if (base.lte(0)) return null;
  const pct = toDecimal(current).minus(base).div(base).times(100).toDecimalPlaces(1);
  if (pct.isZero()) return '0.0';
  return `${pct.gt(0) ? '+' : ''}${pct.toFixed(1)}`;
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

/** Rótulo del eje de montos: en miles desde S/ 1 000; debajo, el número entero («0 mil» repetido no dice nada). */
export function axisMoney(value: number): string {
  if (Math.abs(value) < 1000) return String(Math.round(value));
  // Un decimal si hace falta: el eje parte en tramos como 1 500, que no es «2 mil».
  const thousands = Math.round(value / 100) / 10;
  return `${String(thousands).replace('.', ',')} mil`;
}

/**
 * cc28 (D-444): lo facturado del mes, sin IGV: la venta del margen más la que el margen deja fuera
 * por su costo (no comparable o no rastreable). Es lo que suma el gráfico «Facturado por día».
 */
export function billedPen(sales: {
  salesPen: string;
  excludedSalesPen: string;
  untraceableSalesPen: string;
}): string {
  return toFixedString(
    toDecimal(sales.salesPen).plus(sales.excludedSalesPen).plus(sales.untraceableSalesPen),
    'MONEY',
  );
}
