import { describe, expect, it } from 'vitest';
import { BusinessLine } from '@ayr/shared';
import {
  axisMoney,
  billedPen,
  coilWasteHref,
  fillDays,
  salesMarginHref,
  variationPct,
} from './admin-dashboard';

/** cc26 (D-440, D-443). Lo único que la web hace con las cifras del Panel. */
describe('Panel del administrador', () => {
  it('rellena con cero los días sin facturación y conserva los importes del reporte', () => {
    const days = fillDays({ from: '2026-10-01', to: '2026-10-04' }, [
      { date: '2026-10-02', salesPen: '850.0000' },
      { date: '2026-10-04', salesPen: '-10.5000' },
    ]);
    expect(days).toEqual([
      { date: '2026-10-01', salesPen: '0.0000' },
      { date: '2026-10-02', salesPen: '850.0000' },
      { date: '2026-10-03', salesPen: '0.0000' },
      { date: '2026-10-04', salesPen: '-10.5000' },
    ]);
  });

  it('la variación contra el mismo tramo del mes anterior; sin base, no hay porcentaje', () => {
    expect(variationPct('1100.0000', '1000.0000')).toBe('+10.0');
    expect(variationPct('900.0000', '1000.0000')).toBe('-10.0');
    expect(variationPct('900.0000', '0.0000')).toBeNull();
    // Una caída que redondea a cero no se muestra «+-0.0» (autorrevisión cc26, A-5).
    expect(variationPct('999.9999', '1000.0000')).toBe('0.0');
  });

  it('cada enlace lleva el rango de la cifra y la pestaña de la línea', () => {
    const range = { from: '2026-10-01', to: '2026-10-06' };
    expect(salesMarginHref(range)).toBe('/reportes/ventas-margen?from=2026-10-01&to=2026-10-06');
    expect(salesMarginHref(range, BusinessLine.DRYWALL)).toBe(
      '/reportes/ventas-margen?from=2026-10-01&to=2026-10-06&linea=drywall',
    );
    expect(salesMarginHref(range, null)).toBe(
      '/reportes/ventas-margen?from=2026-10-01&to=2026-10-06',
    );
    expect(coilWasteHref(range, BusinessLine.METALLIC_ROOFING)).toBe(
      '/reportes/merma?from=2026-10-01&to=2026-10-06',
    );
    expect(coilWasteHref(range, BusinessLine.DRYWALL)).toBe(
      '/reportes/merma?from=2026-10-01&to=2026-10-06&linea=drywall',
    );
  });

  it('el eje de montos va en miles desde S/ 1 000', () => {
    expect(axisMoney(0)).toBe('0');
    expect(axisMoney(850)).toBe('850');
    expect(axisMoney(12_499)).toBe('12,5 mil');
    expect(axisMoney(1500)).toBe('1,5 mil');
    expect(axisMoney(6000)).toBe('6 mil');
    expect(axisMoney(-2500)).toBe('-2,5 mil');
  });

  it('cc28 (D-444): lo facturado del mes es la venta del margen más la que el margen deja fuera', () => {
    expect(
      billedPen({
        salesPen: '905.8700',
        excludedSalesPen: '120.0000',
        untraceableSalesPen: '10.1300',
      }),
    ).toBe('1036.0000');
    expect(
      billedPen({ salesPen: '50.0000', excludedSalesPen: '0.0000', untraceableSalesPen: '0.0000' }),
    ).toBe('50.0000');
  });
});
