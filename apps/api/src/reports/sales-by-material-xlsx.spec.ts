import * as XLSX from 'xlsx';
import type { SalesByMaterialDto, SalesMaterialFiguresDto } from '@ayr/shared';
import { salesByMaterialXlsx } from './sales-by-material-xlsx';

const F = (sales: string, realKg: string, cost: string): SalesMaterialFiguresDto => ({
  metersSold: '10.000',
  theoreticalKg: '24.000',
  realKg,
  yieldKg: '0.000',
  yieldPct: '0.00',
  salesPen: sales,
  costPen: cost,
  profitPen: '0.0000',
  costPerKgPen: '2.5000',
  pricePerKgPen: '12.5000',
  marginPerKgPen: '10.0000',
  pricePerMeterPen: '30.0000',
  costPerMeterPen: '6.0000',
  marginPerMeterPen: '24.0000',
  unit: 'MTR',
  qty: '10.000',
  costPerUnitPen: '6.0000',
});

const coil = (code: string, kg: string, cost: string) => ({
  coilId: `11111111-1111-1111-1111-${code.padStart(12, '0')}`,
  code,
  thicknessMm: '0.30',
  colorLabel: 'ROJO',
  kg,
  costPen: cost,
  typeKey: 'PREP-0.30',
  theoreticalKg: kg,
  meters: '0.000',
  avgCostPen: null,
  documents: [],
});

const REPORT: SalesByMaterialDto = {
  from: '2026-09-01',
  to: '2026-09-30',
  businessLine: 'metallic-roofing',
  rows: [
    {
      kind: 'COBERTURA',
      thicknessMm: '0.30',
      colorLabel: 'ROJO',
      lineCount: 2,
      ...F('300.0000', '24.000', '60.0000'),
      coils: [coil('1', '20.000', '50.0000'), coil('2', '4.000', '10.0000')],
    },
    {
      kind: 'ACCESORIO',
      thicknessMm: '0.30',
      colorLabel: 'ROJO',
      lineCount: 1,
      ...F('100.0000', '8.000', '20.0000'),
      coils: [coil('1', '8.000', '20.0000')],
    },
  ],
  subtotals: [
    { kind: 'COBERTURA', ...F('300.0000', '24.000', '60.0000') },
    { kind: 'ACCESORIO', ...F('100.0000', '8.000', '20.0000') },
  ],
  total: F('400.0000', '32.000', '80.0000'),
  untraceable: [
    {
      kind: 'PLANCHA',
      thicknessMm: '0.30',
      colorLabel: 'ROJO',
      reason: 'SIN_PRODUCCION',
      documentId: '22222222-2222-2222-2222-222222222222',
      documentNumber: 'F001-9',
      issueDate: '2026-09-12',
      orderCode: 'PED-000009',
      sku: 'PL030ROJO360',
      metersSold: '36.000',
      salesPen: '500.0000',
    },
  ],
  untraceableSalesPen: '500.0000',
  reconciliation: {
    lineSalesPen: '900.0000',
    coilSalesPen: '0.0000',
    unclassifiedSalesPen: '0.0000',
  },
  noLineSalesPen: '0.0000',
  products: null,
};

function sheet(buffer: Buffer, name: string): unknown[][] {
  const book = XLSX.read(buffer, { type: 'buffer' });
  const grid = book.Sheets[name];
  if (grid === undefined) throw new Error(`falta la hoja ${name}`);
  return XLSX.utils.sheet_to_json(grid, { header: 1 });
}

describe('salesByMaterialXlsx (D-354)', () => {
  it('filas, subtotales, total y lo no trazable; montos como número', () => {
    const { buffer, filename } = salesByMaterialXlsx(REPORT);
    expect(filename).toBe('ventas-por-material-2026-09-01-a-2026-09-30.xlsx');
    const main = sheet(buffer, 'Ventas por material');
    expect(main[1]!.slice(0, 3)).toEqual(['Coberturas', 0.3, 'ROJO']);
    expect(main[2]![0]).toBe('Subtotal Coberturas');
    expect(main.find((r) => r[0] === 'Total')![8]).toBe(400);
    expect(main.find((r) => r[0] === 'Venta no trazable (S/)')![1]).toBe(500);
    const untraceable = sheet(buffer, 'No trazable');
    expect(untraceable[1]).toContain('Sin producción aún');
  });

  it('C06: por ML y costo por unidad; sin divisor, «—» (nunca 0 ni vacío)', () => {
    const noDivisor: SalesByMaterialDto = {
      ...REPORT,
      total: {
        ...F('400.0000', '32.000', '80.0000'),
        pricePerMeterPen: null,
        costPerMeterPen: null,
        marginPerMeterPen: null,
        unit: null,
        qty: null,
        costPerUnitPen: null,
      },
    };
    const main = sheet(salesByMaterialXlsx(noDivisor).buffer, 'Ventas por material');
    const header = main[0]!;
    const col = (name: string) => header.indexOf(name);
    const first = main[1]!;
    expect(first[col('Precio/ML venta (S/)')]).toBe(30);
    expect(first[col('Costo/ML (S/)')]).toBe(6);
    expect(first[col('Ganancia/ML (S/)')]).toBe(24);
    // D-579: la unidad se muestra con su abreviatura (`MTR` → «m», `NIU` → «und»).
    expect(first[col('Unidad')]).toBe('m');
    expect(first[col('Costo prom./unidad (S/)')]).toBe(6);
    const total = main.find((r) => r[0] === 'Total')!;
    for (const name of [
      'Precio/ML venta (S/)',
      'Costo/ML (S/)',
      'Ganancia/ML (S/)',
      'Cantidad vendida',
      'Unidad',
      'Costo prom./unidad (S/)',
    ]) {
      expect(total[col(name)]).toBe('—');
    }
  });

  it('la hoja del modal desglosa bobina × tipo sumando las filas del mismo tipo', () => {
    const rows = sheet(salesByMaterialXlsx(REPORT).buffer, 'Bobinas por tipo');
    expect(rows.slice(1)).toEqual([
      ['1', 0.3, 'ROJO', 'Accesorios', 8, 20],
      ['1', 0.3, 'ROJO', 'Coberturas', 20, 50],
      ['2', 0.3, 'ROJO', 'Coberturas', 4, 10],
    ]);
  });
});
