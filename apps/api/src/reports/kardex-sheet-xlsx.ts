import * as XLSX from 'xlsx';
import { KARDEX_METHOD_LABELS, type KardexSheet } from '@ayr/shared';
import { dmy, num } from './kardex-peps-xlsx';

/**
 * D-298 — el Excel del kardex de un ítem con el formato del cliente (el mismo de la pantalla), en
 * el método elegido (Promedio o PEPS).
 *
 * Reusa lo del Excel PEPS/SUNAT (D-279): la librería, la conversión a número (los importes ya
 * vienen redondeados a su escala por el cálculo en `Decimal`; el `Number` solo transporta) y el
 * formato de fecha. No calcula nada: escribe las filas de la hoja tal como las armó
 * `movementsToKardexSheet` / `pepsToKardexSheet`.
 *
 * Cabecera: Producto / Código / Método (y el período). Columnas: Fecha, Detalle, ENTRADAS,
 * SALIDAS y SALDO, cada una con cantidad, C.U. y monto.
 */
export function kardexSheetXlsx(sheet: KardexSheet): { buffer: Buffer; filename: string } {
  const period =
    sheet.from && sheet.to
      ? `${dmy(sheet.from)} al ${dmy(sheet.to)}`
      : sheet.to
        ? `desde el inicio al ${dmy(sheet.to)}`
        : '(sin período acotado)';
  const header: (string | number | null)[][] = [
    ['KARDEX'],
    ['PRODUCTO:', sheet.itemDescription],
    ['CÓDIGO:', sheet.itemCode],
    ['MÉTODO:', KARDEX_METHOD_LABELS[sheet.method]],
    ['PERÍODO:', period],
    ...(sheet.unit ? [['UNIDAD:', sheet.unit]] : []),
    [],
  ];
  const groupRow = header.length;
  const groups: (string | null)[][] = [
    ['FECHA', 'DETALLE', 'ENTRADAS', null, null, 'SALIDAS', null, null, 'SALDO', null, null],
    [
      null,
      null,
      'CANTIDAD',
      'C.U.',
      'MONTO',
      'CANTIDAD',
      'C.U.',
      'MONTO',
      'CANTIDAD',
      'C.U.',
      'MONTO',
    ],
  ];
  const body: (string | number | null)[][] = sheet.rows.map((row) => [
    row.date ? dmy(row.date) : null,
    row.detail,
    num(row.inQty),
    num(row.inUnitCost),
    num(row.inTotal),
    num(row.outQty),
    num(row.outUnitCost),
    num(row.outTotal),
    num(row.balanceQty),
    num(row.balanceUnitCost),
    num(row.balanceTotal),
  ]);

  const grid = XLSX.utils.aoa_to_sheet([...header, ...groups, ...body]);
  grid['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 10 } },
    { s: { r: groupRow, c: 0 }, e: { r: groupRow + 1, c: 0 } },
    { s: { r: groupRow, c: 1 }, e: { r: groupRow + 1, c: 1 } },
    { s: { r: groupRow, c: 2 }, e: { r: groupRow, c: 4 } },
    { s: { r: groupRow, c: 5 }, e: { r: groupRow, c: 7 } },
    { s: { r: groupRow, c: 8 }, e: { r: groupRow, c: 10 } },
  ];
  grid['!cols'] = [11, 46, 12, 12, 14, 12, 12, 14, 12, 12, 14].map((wch) => ({ wch }));

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, grid, 'Kardex');
  const code = sheet.itemCode.replace(/[^A-Za-z0-9._-]/g, '_');
  return {
    buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
    filename: `kardex-${sheet.method.toLowerCase()}-${code}-${sheet.from || 'inicio'}-${sheet.to || 'hoy'}.xlsx`,
  };
}
