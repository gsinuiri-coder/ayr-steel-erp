import * as XLSX from 'xlsx';
import type { CoilWasteDto, CoilWasteRowDto } from '@ayr/shared';
import { coilWasteXlsx } from './coil-waste-xlsx';

/** cc39 (D-580): «Merma por bobina» en xlsx, del mismo DTO que la pantalla. */

const row = (code: string, over: Partial<CoilWasteRowDto> = {}): CoilWasteRowDto => ({
  coilId: `11111111-1111-4111-a111-${code.padStart(12, '0')}`,
  code,
  kind: 'COIL',
  typeKey: 'ALZ-0.30',
  finishName: 'Aluzinc natural',
  colorName: null,
  widthMm: '1200.00',
  status: 'OPEN',
  consumedKg: '100.000',
  theoreticalKg: '98.000',
  differenceKg: '2.000',
  trimKg: '1.000',
  closeAdjustmentKg: '0.000',
  wasteKg: '3.000',
  wastePct: '3.06',
  overStandard: true,
  manualScrapKg: '0.500',
  productions: [
    {
      reportId: '22222222-2222-4222-a222-222222222222',
      productionOrderId: '33333333-3333-4333-a333-333333333333',
      productionOrderCode: 'OP-000001',
      operationDate: '2026-10-02',
      consumedKg: '100.000',
      theoreticalKg: '98.000',
      missingTheoretical: null,
      outOfTolerance: { label: 'Bobina más liviana que el nominal', excessPct: '2.04' },
    },
  ],
  ...over,
});

const REPORT: CoilWasteDto = {
  from: '2026-10-01',
  to: '2026-10-09',
  businessLine: 'drywall',
  standardPct: '1.00',
  rows: [
    row('B-1'),
    row('B-2', {
      consumedKg: '50.000',
      theoreticalKg: null,
      differenceKg: null,
      wasteKg: null,
      wastePct: null,
      overStandard: false,
      productions: [
        {
          reportId: null,
          productionOrderId: null,
          productionOrderCode: null,
          operationDate: '2026-10-03',
          consumedKg: '50.000',
          theoreticalKg: null,
          missingTheoretical: 'NO_REPORT',
          outOfTolerance: null,
        },
      ],
    }),
  ],
  totals: {
    coilCount: 2,
    consumedKg: '150.000',
    trimKg: '2.000',
    closeAdjustmentKg: '0.000',
    manualScrapKg: '1.000',
    comparableCoilCount: 1,
    comparableConsumedKg: '100.000',
    theoreticalKg: '98.000',
    differenceKg: '2.000',
    wasteKg: '3.000',
    wastePct: '3.06',
    overStandard: true,
  },
};

function sheet(buffer: Buffer, name: string): unknown[][] {
  const grid = XLSX.read(buffer, { type: 'buffer' }).Sheets[name];
  if (grid === undefined) throw new Error(`falta la hoja ${name}`);
  return XLSX.utils.sheet_to_json(grid, { header: 1, defval: null });
}

describe('coilWasteXlsx (cc39, D-580)', () => {
  it('una fila por bobina con el acabado, el total del reporte y la línea en el archivo', () => {
    const { buffer, filename } = coilWasteXlsx(REPORT);
    expect(filename).toBe('merma-por-bobina-2026-10-01-a-2026-10-09-drywall.xlsx');
    const rows = sheet(buffer, 'Merma por bobina');
    const header = rows[0]!;
    // En Drywall lo que sale al cerrar la OP es la merma de proceso (D-057).
    expect(header).toContain('Merma de proceso (kg)');
    expect(header).not.toContain('Despunte (kg)');
    expect(rows[1]!.slice(0, 3)).toEqual(['B-1', 'ALZ-0.30', 'Aluzinc natural']);
    // Sin teórico atribuible, las celdas quedan vacías (no cero).
    expect(rows[2]![header.indexOf('Teórico (kg)')]).toBeNull();
    const total = rows.find((r) => String(r[0]).startsWith('Total ·'))!;
    expect(total[0]).toBe('Total · 2 bobinas');
    expect(total[header.indexOf('Consumido (kg)')]).toBe(150);
    expect(total[header.indexOf('Teórico (kg)')]).toBe(98);
    expect(total[header.indexOf('Merma (kg)')]).toBe(3);
    expect(total[header.indexOf('Merma %')]).toBe(3.06);
    expect(total[header.indexOf('Fuera de tolerancia (merma %)')]).toBe('Sí');
    // Con bobinas sin teórico, la hoja dice de cuántas son el teórico y la merma.
    expect(rows.some((r) => String(r[0]).startsWith('Teórico, diferencia y merma: 1 de 2'))).toBe(
      true,
    );
  });

  it('las producciones del detalle, cada una en su fila', () => {
    const rows = sheet(coilWasteXlsx(REPORT).buffer, 'Producciones');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual([
      'B-1',
      'OP-000001',
      '2026-10-02',
      100,
      98,
      'Bobina más liviana que el nominal',
      2.04,
      '',
    ]);
    expect(rows[2]![1]).toBe('Sin orden');
    expect(rows[2]![7]).toBe('Salida de producción sin reporte de planta');
  });

  it('en Coberturas Aluzinc la columna es «Despunte»', () => {
    const rows = sheet(
      coilWasteXlsx({ ...REPORT, businessLine: 'metallic-roofing' }).buffer,
      'Merma por bobina',
    );
    expect(rows[0]).toContain('Despunte (kg)');
  });
});
