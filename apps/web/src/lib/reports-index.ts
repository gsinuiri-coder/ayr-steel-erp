import type { Role } from '@ayr/shared';
import { NAV, type NavItem } from './nav';
import { matchPreset, type ReportPeriod } from './report-period';

/**
 * cc32 — la página `/reportes`: los siete reportes agrupados por la pregunta que responden. Los
 * títulos, rutas y roles salen del menú (`NAV`), que es la única fuente; acá solo se agrega el
 * grupo y la línea que dice qué responde cada uno (tablero `ReporteIndice`).
 */
export const REPORT_SECTIONS: readonly { title: string; reports: readonly string[] }[] = [
  {
    title: 'Ventas y cobranza',
    reports: [
      '/reportes/ventas-margen',
      '/reportes/ventas-material',
      '/reportes/cuentas-por-cobrar',
    ],
  },
  {
    title: 'Almacén',
    reports: ['/reportes/inventario-valorizado', '/reportes/bobinas'],
  },
  {
    title: 'Planta',
    reports: ['/reportes/merma', '/reportes/produccion'],
  },
];

export const REPORT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  '/reportes/ventas-margen': 'Cuánto se vendió y cuánto quedó, por pedido, vendedor o cliente.',
  '/reportes/ventas-material': 'Venta, costo y rendimiento por tipo, espesor y color.',
  '/reportes/cuentas-por-cobrar': 'Quién debe, cuánto y desde cuándo.',
  '/reportes/inventario-valorizado': 'Qué hay en almacén hoy y cuánto vale.',
  '/reportes/bobinas': 'Saldo de cada bobina al inicio y al fin del mes.',
  '/reportes/merma': 'Cuánto se perdió sobre lo esperado.',
  '/reportes/produccion': 'Qué se produjo, con cuántos kilos y cuánto despunte.',
};

/** Los reportes que leen el periodo de la URL como `from`/`to`. */
const RANGE_REPORTS = new Set([
  '/reportes/ventas-margen',
  '/reportes/merma',
  '/reportes/produccion',
]);

/**
 * El enlace a un reporte con el periodo puesto. Ventas por material lee su propio parámetro
 * (`range`: mes en curso, anterior o libre); Cuentas por cobrar e Inventario valorizado son «a
 * hoy» y el Reporte mensual de bobinas elige un mes: esos van sin periodo.
 */
export function reportHref(href: string, period: ReportPeriod, today: string): string {
  if (RANGE_REPORTS.has(href)) return `${href}?from=${period.from}&to=${period.to}`;
  if (href === '/reportes/ventas-material') {
    const preset = matchPreset(period, today);
    if (preset === 'this-month') return `${href}?range=month`;
    if (preset === 'last-month') return `${href}?range=prev`;
    return `${href}?range=custom&from=${period.from}&to=${period.to}`;
  }
  return href;
}

/** Las secciones con los reportes que el rol puede abrir; una sección vacía no se muestra. */
export function reportSectionsFor(
  role: Role,
): { title: string; reports: (NavItem & { description: string })[] }[] {
  const items = new Map(
    NAV.flatMap((g) => g.items)
      .filter((i) => i.roles.includes(role))
      .map((i) => [i.href, i]),
  );
  return REPORT_SECTIONS.map((s) => ({
    title: s.title,
    reports: s.reports.flatMap((href) => {
      const item = items.get(href);
      return item ? [{ ...item, description: REPORT_DESCRIPTIONS[href] ?? '' }] : [];
    }),
  })).filter((s) => s.reports.length > 0);
}
