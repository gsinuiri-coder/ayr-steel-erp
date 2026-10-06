import * as XLSX from 'xlsx';
import type { CoilMonthReportDto, CoilMonthReportRowDto } from '@ayr/shared';
import { coilMonthXlsx } from './coil-month-xlsx';

const row = (code: string, closing: string, value: string | null): CoilMonthReportRowDto => ({
  id: '11111111-1111-1111-1111-111111111111',
  code,
  typeKey: 'ALZ-ROJO-3020-0.30',
  kind: 'COIL',
  businessLine: 'metallic-roofing',
  colorName: 'ROJO',
  widthMm: '1000.00',
  openingKg: '1000.000',
  weightKg: '1000.000',
  closingKg: closing,
  unitCostPerKg: value === null ? null : '2.7500',
  closingValuePen: value,
  status: 'OPEN',
  operationDate: '2026-09-01',
});

function report(withCosts: boolean): CoilMonthReportDto {
  const v = (s: string) => (withCosts ? s : null);
  return {
    month: '2026-09',
    businessLine: null,
    from: '2026-09-01',
    to: '2026-09-30',
    sealed: {
      rows: [row('B-1', '1000.000', v('2750.0000'))],
      totals: {
        openingKg: '1000.000',
        weightKg: '1000.000',
        closingKg: '1000.000',
        closingValuePen: v('2750.0000'),
      },
    },
    opened: {
      rows: [row('B-2', '400.000', v('1100.0000'))],
      totals: {
        openingKg: '1000.000',
        weightKg: '1000.000',
        closingKg: '400.000',
        closingValuePen: v('1100.0000'),
      },
    },
    totals: {
      openingKg: '2300.000',
      weightKg: '2300.000',
      closingKg: '1400.000',
      closingValuePen: v('3850.0000'),
    },
    finished: { count: 1, consumedKg: '100.000' },
    annulledWithOpening: { count: 1, openingKg: '200.000' },
    flow: { openingKg: '2300.000', entriesKg: '0.000', exitsKg: '900.000', closingKg: '1400.000' },
  };
}

function sheet(buffer: Buffer, name: string): unknown[][] {
  const book = XLSX.read(buffer, { type: 'buffer' });
  const grid = book.Sheets[name];
  if (grid === undefined) throw new Error(`falta la hoja ${name}`);
  return XLSX.utils.sheet_to_json(grid, { header: 1 });
}

describe('coilMonthXlsx (D-355)', () => {
  it('una hoja por tabla con su subtotal, y el resumen con lo no listado y el cuadre', () => {
    const { buffer, filename } = coilMonthXlsx(report(true));
    expect(filename).toBe('reporte-bobinas-2026-09.xlsx');
    const sealed = sheet(buffer, 'Selladas');
    expect(sealed[1]!.slice(0, 2)).toEqual(['B-1', 'ALZ-ROJO-3020-0.30']);
    expect(sealed[1]![10]).toBe('Sellada');
    expect(sealed[2]![0]).toBe('Subtotal Selladas');
    const summary = sheet(buffer, 'Resumen');
    expect(summary.find((r) => r[0] === 'Salidas del mes')![2]).toBe(900);
    expect(summary.find((r) => String(r[0]).startsWith('Bobinas terminadas'))!.slice(1)).toEqual([
      1, 100,
    ]);
    expect(summary.find((r) => String(r[0]).startsWith('Anuladas'))!.slice(1)).toEqual([1, 200]);
  });

  it('sin permiso de costos no lleva columnas de costo ni valor', () => {
    const sealed = sheet(coilMonthXlsx(report(false)).buffer, 'Selladas');
    expect(sealed[0]).not.toContain('Costo/kg (S/)');
    expect(sealed[0]).not.toContain('Valor fin de mes (S/)');
  });

  it('cc24 (D-408, D-418): con una línea, el Excel la nombra en el archivo y en el resumen', () => {
    const { buffer, filename } = coilMonthXlsx({ ...report(true), businessLine: 'drywall' });
    expect(filename).toBe('reporte-bobinas-2026-09-drywall.xlsx');
    expect(sheet(buffer, 'Resumen')[1]?.[0]).toBe('Línea: Drywall');
  });
});
