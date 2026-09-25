import * as XLSX from 'xlsx';
import type { KardexSheet } from '@ayr/shared';
import { kardexSheetXlsx } from './kardex-sheet-xlsx';

// D-298: el Excel del kardex con el formato del cliente, en cualquiera de los dos métodos.
const sheet: KardexSheet = {
  method: 'PEPS',
  itemCode: 'BOB038AZUL',
  itemDescription: 'Bobina azul 0.38',
  from: '2026-09-01',
  to: '2026-09-30',
  unit: '01 - KILOGRAMOS',
  rows: [
    {
      key: 'opening',
      date: '2026-09-01',
      detail: 'Saldo inicial',
      kind: 'opening',
      inQty: null,
      inUnitCost: null,
      inTotal: null,
      outQty: null,
      outUnitCost: null,
      outTotal: null,
      balanceQty: '0.000',
      balanceUnitCost: '0.0000',
      balanceTotal: '0.0000',
    },
    {
      key: '1',
      date: '2026-09-02',
      detail: '02 F001-1 · COMPRA',
      kind: 'movement',
      inQty: '100.000',
      inUnitCost: '10.0000',
      inTotal: '1000.0000',
      outQty: null,
      outUnitCost: null,
      outTotal: null,
      balanceQty: '100.000',
      balanceUnitCost: '10.0000',
      balanceTotal: '1000.0000',
    },
    {
      key: '2:0',
      date: '2026-09-03',
      detail: 'VENTA',
      kind: 'movement',
      inQty: null,
      inUnitCost: null,
      inTotal: null,
      outQty: '60.000',
      outUnitCost: '10.0000',
      outTotal: '600.0000',
      balanceQty: null,
      balanceUnitCost: null,
      balanceTotal: null,
    },
  ],
};

function read(buffer: Buffer): (string | number | null)[][] {
  const book = XLSX.read(buffer, { type: 'buffer' });
  const grid = book.Sheets['Kardex']!;
  return XLSX.utils.sheet_to_json<(string | number | null)[]>(grid, { header: 1, defval: null });
}

describe('kardexSheetXlsx', () => {
  it('cabecera Producto / Código / Método y las columnas del cliente', () => {
    const { buffer, filename } = kardexSheetXlsx(sheet);
    const rows = read(buffer);
    expect(rows[1]?.slice(0, 2)).toEqual(['PRODUCTO:', 'Bobina azul 0.38']);
    expect(rows[2]?.slice(0, 2)).toEqual(['CÓDIGO:', 'BOB038AZUL']);
    expect(rows[3]?.slice(0, 2)).toEqual(['MÉTODO:', 'PEPS']);
    const groupIndex = rows.findIndex((r) => r[0] === 'FECHA');
    expect(rows[groupIndex]?.slice(0, 11)).toEqual([
      'FECHA',
      'DETALLE',
      'ENTRADAS',
      null,
      null,
      'SALIDAS',
      null,
      null,
      'SALDO',
      null,
      null,
    ]);
    expect(rows[groupIndex + 1]?.slice(2)).toEqual([
      'CANTIDAD',
      'C.U.',
      'MONTO',
      'CANTIDAD',
      'C.U.',
      'MONTO',
      'CANTIDAD',
      'C.U.',
      'MONTO',
    ]);
    expect(filename).toBe('kardex-peps-BOB038AZUL-2026-09-01-2026-09-30.xlsx');
  });

  it('las filas llevan cantidades y montos como número, y las celdas vacías quedan vacías', () => {
    const rows = read(kardexSheetXlsx(sheet).buffer);
    const first = rows.findIndex((r) => r[1] === 'Saldo inicial');
    expect(rows[first]).toEqual([
      '01/09/2026',
      'Saldo inicial',
      null,
      null,
      null,
      null,
      null,
      null,
      0,
      0,
      0,
    ]);
    expect(rows[first + 1]).toEqual([
      '02/09/2026',
      '02 F001-1 · COMPRA',
      100,
      10,
      1000,
      null,
      null,
      null,
      100,
      10,
      1000,
    ]);
    // Fila de una capa de una salida: el saldo va solo en la última capa del movimiento.
    expect(rows[first + 2]).toEqual([
      '03/09/2026',
      'VENTA',
      null,
      null,
      null,
      60,
      10,
      600,
      null,
      null,
      null,
    ]);
  });

  it('en promedio, el método y el nombre de archivo lo dicen', () => {
    const { buffer, filename } = kardexSheetXlsx({ ...sheet, method: 'AVERAGE' });
    expect(read(buffer)[3]?.slice(0, 2)).toEqual(['MÉTODO:', 'Promedio']);
    expect(filename.startsWith('kardex-average-')).toBe(true);
  });
});
