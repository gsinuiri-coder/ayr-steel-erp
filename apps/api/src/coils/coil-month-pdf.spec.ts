import type { CoilMonthReportDto } from '@ayr/shared';
import { buildCoilMonthReportPdf, coilMonthPdfSummary, coilMonthPdfTable } from './coil-pdf';

/** D-355 — el reporte mensual de bobinas en PDF: mismas tablas, lo no listado y el cuadre. */
function report(withCosts: boolean): CoilMonthReportDto {
  const v = (s: string) => (withCosts ? s : null);
  const totals = {
    openingKg: '1000.000',
    weightKg: '1000.000',
    closingKg: '400.000',
    closingValuePen: v('1100.0000'),
  };
  return {
    month: '2026-09',
    businessLine: null,
    from: '2026-09-01',
    to: '2026-09-30',
    sealed: { rows: [], totals: { ...totals, openingKg: '0.000', closingKg: '0.000' } },
    opened: {
      rows: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          code: 'B-2',
          typeKey: 'ALZ-ROJO-3020-0.30',
          kind: 'COIL',
          businessLine: 'metallic-roofing',
          colorName: 'ROJO',
          widthMm: '1000.00',
          openingKg: '1000.000',
          weightKg: '1000.000',
          closingKg: '400.000',
          unitCostPerKg: v('2.7500'),
          closingValuePen: v('1100.0000'),
          status: 'OPEN',
          operationDate: '2026-08-01',
        },
      ],
      totals,
    },
    totals: { ...totals, openingKg: '1300.000' },
    finished: { count: 2, consumedKg: '100.000' },
    annulledWithOpening: { count: 1, openingKg: '200.000' },
    flow: { openingKg: '1300.000', entriesKg: '0.000', exitsKg: '900.000', closingKg: '400.000' },
  };
}

describe('PDF del reporte mensual de bobinas (D-355)', () => {
  it('cada tabla lleva sus filas, su subtotal y el estado con el film de la tabla', () => {
    const t = coilMonthPdfTable('Abiertas', 'OPENED', report(true).opened);
    expect(t.headers).toContain('Valor (S/)');
    expect(t.rows[0]?.[0]).toBe('B-2');
    expect(t.rows[0]?.at(-1)).toBe('Abierta');
    expect(t.rows.at(-1)?.[0]).toBe('Subtotal Abiertas');
    expect(t.widths).toHaveLength(t.headers.length);
    expect(t.widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(595 - 96);
  });

  it('sin permiso de costos no hay columna de valor', () => {
    const t = coilMonthPdfTable('Abiertas', 'OPENED', report(false).opened);
    expect(t.headers).not.toContain('Valor (S/)');
    expect(t.widths).toHaveLength(t.headers.length);
    expect(t.widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(595 - 96);
  });

  it('debajo: terminadas, anuladas con saldo al inicio y el cuadre', () => {
    const lines = coilMonthPdfSummary(report(true));
    expect(lines).toEqual([
      '2 bobinas terminadas o agotadas en el mes, no listadas: 100.000 kg consumidos.',
      '1 anuladas con saldo al inicio: 200.000 kg.',
      'Saldo inicio 1300.000 kg + altas 0.000 kg − salidas 900.000 kg = saldo fin de mes 400.000 kg.',
      'Valor fin de mes: S/ 1100.0000.',
    ]);
    expect(coilMonthPdfSummary(report(false)).at(-1)).toMatch(/^Saldo inicio/);
  });

  it('arma un PDF', async () => {
    const buffer = await buildCoilMonthReportPdf(report(true), '2026-09-27');
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });
});
