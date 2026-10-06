import * as XLSX from 'xlsx';
import { Role } from '@ayr/shared';
import { columnsFor, listSheet, listXlsx, type ListColumn } from './list-xlsx';

/**
 * cc26 (D-provisional): el Excel de un listado. Las columnas de costo o margen solo para
 * ADMINISTRADOR, decidido en la API, y la fila de total sumada con `Decimal`.
 */

interface Row {
  code: string;
  totalPen: string;
  costPen: string;
}

const COLUMNS: readonly ListColumn<Row>[] = [
  { header: 'Código', width: 10, cell: (r) => r.code },
  { header: 'Total (S/)', width: 12, cell: (r) => Number(r.totalPen), amount: (r) => r.totalPen },
  {
    header: 'Costo (S/)',
    width: 12,
    cell: (r) => Number(r.costPen),
    amount: (r) => r.costPen,
    adminOnly: true,
  },
];

const ROWS: Row[] = [
  { code: 'A', totalPen: '0.1000', costPen: '0.0500' },
  { code: 'B', totalPen: '0.2000', costPen: '0.0500' },
];

function readSheet(buffer: Buffer): unknown[][] {
  const book = XLSX.read(buffer, { type: 'buffer' });
  const sheet = book.Sheets[book.SheetNames[0] ?? ''];
  if (!sheet) throw new Error('sin hoja');
  return XLSX.utils.sheet_to_json(sheet, { header: 1 });
}

describe('columnsFor — columnas por rol', () => {
  it('el ADMINISTRADOR ve las columnas de costo', () => {
    expect(columnsFor(COLUMNS, Role.ADMINISTRADOR).map((c) => c.header)).toEqual([
      'Código',
      'Total (S/)',
      'Costo (S/)',
    ]);
  });

  it.each([Role.VENDEDOR, Role.SUPERVISOR_PLANTA])('%s no recibe columnas adminOnly', (role) => {
    expect(columnsFor(COLUMNS, role).map((c) => c.header)).toEqual(['Código', 'Total (S/)']);
  });
});

describe('listSheet — fila de total', () => {
  it('suma con Decimal: 0,1 + 0,2 es 0,3 y no 0,30000000000000004', () => {
    const sheet = listSheet('Hoja', COLUMNS, ROWS, { singular: 'fila', plural: 'filas' });
    expect(sheet.rows.at(-1)).toEqual(['Total (2 filas)', 0.3, 0.1]);
  });

  it('singular con una fila, y cero sin filas', () => {
    const noun = { singular: 'fila', plural: 'filas' };
    expect(listSheet('Hoja', COLUMNS, ROWS.slice(0, 1), noun).rows.at(-1)?.[0]).toBe(
      'Total (1 fila)',
    );
    expect(listSheet('Hoja', COLUMNS, [], noun).rows).toEqual([['Total (0 filas)', 0, 0]]);
  });
});

describe('listXlsx — el archivo', () => {
  it('un VENDEDOR recibe el archivo sin la columna de costo ni su total', () => {
    const file = listXlsx({
      sheetName: 'Hoja',
      columns: COLUMNS,
      rows: ROWS,
      role: Role.VENDEDOR,
      noun: { singular: 'fila', plural: 'filas' },
      filename: 'x.xlsx',
    });
    expect(readSheet(file.buffer)).toEqual([
      ['Código', 'Total (S/)'],
      ['A', 0.1],
      ['B', 0.2],
      ['Total (2 filas)', 0.3],
    ]);
  });
});
