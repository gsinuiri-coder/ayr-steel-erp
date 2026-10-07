import { describe, expect, it } from 'vitest';
import { Role } from '@ayr/shared';
import { NAV } from './nav';
import {
  REPORT_DESCRIPTIONS,
  REPORT_SECTIONS,
  reportHref,
  reportSectionsFor,
} from './reports-index';

/** cc32 — la página `/reportes`. */
const TODAY = '2026-10-07';

describe('inicio de Reportes', () => {
  it('lista los siete reportes del menú, cada uno con su línea', () => {
    const menu = NAV.find((g) => g.label === 'Reportes')?.items.map((i) => i.href) ?? [];
    const listed = REPORT_SECTIONS.flatMap((s) => s.reports);
    expect([...listed].sort((a, b) => a.localeCompare(b))).toEqual(
      [...menu].sort((a, b) => a.localeCompare(b)),
    );
    expect(listed).toHaveLength(7);
    for (const href of listed) expect(REPORT_DESCRIPTIONS[href]).toBeTruthy();
  });

  it('solo muestra lo que el rol puede abrir', () => {
    const admin = reportSectionsFor(Role.ADMINISTRADOR);
    expect(admin.map((s) => s.title)).toEqual(['Ventas y cobranza', 'Almacén', 'Planta']);
    const plant = reportSectionsFor(Role.SUPERVISOR_PLANTA);
    expect(plant.flatMap((s) => s.reports.map((r) => r.title))).toEqual([
      'Reporte mensual de bobinas',
      'Reporte de producción',
    ]);
    expect(reportSectionsFor(Role.VENDEDOR)).toEqual([]);
  });

  it('los enlaces llevan el periodo, cada reporte con su parámetro', () => {
    const period = { from: '2026-09-01', to: '2026-09-30' };
    expect(reportHref('/reportes/ventas-margen', period, TODAY)).toBe(
      '/reportes/ventas-margen?from=2026-09-01&to=2026-09-30',
    );
    // cc32 (corte 2): Ventas por material, Merma y Producción con el periodo único.
    for (const href of ['/reportes/ventas-material', '/reportes/merma', '/reportes/produccion']) {
      expect(reportHref(href, period, TODAY)).toBe(`${href}?from=2026-09-01&to=2026-09-30`);
    }
    // Bobinas: el mes de la fecha final, sin pasar del mes en curso.
    expect(reportHref('/reportes/bobinas', period, TODAY)).toBe('/reportes/bobinas?mes=2026-09');
    expect(reportHref('/reportes/bobinas', { from: '2026-08-01', to: TODAY }, TODAY)).toBe(
      '/reportes/bobinas?mes=2026-10',
    );
    expect(reportHref('/reportes/bobinas', { from: '2026-10-01', to: '2026-12-31' }, TODAY)).toBe(
      '/reportes/bobinas?mes=2026-10',
    );
    // «A hoy»: sin periodo.
    expect(reportHref('/reportes/cuentas-por-cobrar', period, TODAY)).toBe(
      '/reportes/cuentas-por-cobrar',
    );
    expect(reportHref('/reportes/inventario-valorizado', period, TODAY)).toBe(
      '/reportes/inventario-valorizado',
    );
  });
});
