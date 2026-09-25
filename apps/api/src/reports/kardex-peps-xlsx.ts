import * as XLSX from 'xlsx';
import type { KardexPepsReport } from './kardex-peps.service';

/**
 * D-279 — el kardex PEPS en el formato 13.1 de SUNAT (registro de inventario permanente
 * valorizado, detalle del inventario valorizado).
 *
 * Igual que los otros xlsx (`reports-xlsx.ts`): cantidades y montos van como **número**, ya
 * redondeados a su escala por el cálculo en `Decimal`; el `Number` solo transporta.
 *
 * Además de las columnas del formato se agrega una última, «Observación», con el origen del
 * movimiento, su motivo y cualquier advertencia del cálculo (una salida sin capas
 * suficientes): el formato no tiene dónde decirlo y callarlo sería peor.
 */

const TITLE =
  'FORMATO 13.1: REGISTRO DE INVENTARIO PERMANENTE VALORIZADO - DETALLE DEL INVENTARIO VALORIZADO';

export function num(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `YYYY-MM-DD` → `DD/MM/YYYY`, como lo lee un contador. */
export function dmy(value: string): string {
  const [y, m, d] = value.split('-');
  return `${d}/${m}/${y}`;
}

export function kardexPepsXlsx(report: KardexPepsReport): { buffer: Buffer; filename: string } {
  const { peps } = report;
  const header: (string | number | null)[][] = [
    [TITLE],
    ['PERÍODO:', `${dmy(report.from)} al ${dmy(report.to)}`],
    ['RUC:', report.companyRuc || '(sin configurar)'],
    ['APELLIDOS Y NOMBRES, DENOMINACIÓN O RAZÓN SOCIAL:', report.companyName || '(sin configurar)'],
    ['ESTABLECIMIENTO (1):', ''],
    ['CÓDIGO DE LA EXISTENCIA:', report.itemCode],
    ['TIPO (TABLA 5):', report.existenceType],
    ['DESCRIPCIÓN:', report.itemDescription],
    ['CÓDIGO DE LA UNIDAD DE MEDIDA (TABLA 6):', report.unitCode],
    ['MÉTODO DE VALUACIÓN:', 'PEPS'],
    [],
  ];
  const groupRow = header.length;
  const columns: (string | number | null)[][] = [
    [
      'DOCUMENTO DE TRASLADO, COMPROBANTE DE PAGO, DOCUMENTO INTERNO O SIMILAR',
      null,
      null,
      null,
      'TIPO DE OPERACIÓN (TABLA 12)',
      'ENTRADAS',
      null,
      null,
      'SALIDAS',
      null,
      null,
      'SALDO FINAL',
      null,
      null,
      'OBSERVACIÓN',
    ],
    [
      'FECHA',
      'TIPO (TABLA 10)',
      'SERIE',
      'NÚMERO',
      null,
      'CANTIDAD',
      'COSTO UNITARIO',
      'COSTO TOTAL',
      'CANTIDAD',
      'COSTO UNITARIO',
      'COSTO TOTAL',
      'CANTIDAD',
      'COSTO UNITARIO',
      'COSTO TOTAL',
      null,
    ],
  ];

  const body: (string | number | null)[][] = [
    [
      dmy(report.from),
      '00',
      '',
      '',
      '16 - SALDO INICIAL',
      null,
      null,
      null,
      null,
      null,
      null,
      num(peps.opening.qty),
      num(peps.opening.unitCost),
      num(peps.opening.total),
      'Saldo al inicio del período, valorizado por PEPS con los movimientos anteriores',
    ],
  ];
  for (const row of peps.rows) {
    const doc = report.documents.get(row.movementId);
    const note = [doc?.note, row.warning].filter(Boolean).join(' · ');
    body.push([
      dmy(row.operationDate),
      doc?.docTypeCode ?? '00',
      doc?.series ?? '',
      doc?.number ?? '',
      doc ? `${doc.operationCode} - ${doc.operationLabel}` : '99 - OTROS',
      num(row.inQty),
      num(row.inUnitCost),
      num(row.inTotal),
      num(row.outQty),
      num(row.outUnitCost),
      num(row.outTotal),
      num(row.balanceQty),
      num(row.balanceUnitCost),
      num(row.balanceTotal),
      note || null,
    ]);
  }
  body.push([
    'TOTALES',
    null,
    null,
    null,
    null,
    num(peps.totals.inQty),
    null,
    num(peps.totals.inTotal),
    num(peps.totals.outQty),
    null,
    num(peps.totals.outTotal),
    num(peps.closing.qty),
    null,
    num(peps.closing.total),
    peps.warnings.length > 0
      ? `${peps.warnings.length} advertencia(s) del cálculo PEPS: ver la columna Observación`
      : null,
  ]);

  const grid = XLSX.utils.aoa_to_sheet([...header, ...columns, ...body]);
  grid['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 14 } },
    { s: { r: groupRow, c: 0 }, e: { r: groupRow, c: 3 } },
    { s: { r: groupRow, c: 4 }, e: { r: groupRow + 1, c: 4 } },
    { s: { r: groupRow, c: 5 }, e: { r: groupRow, c: 7 } },
    { s: { r: groupRow, c: 8 }, e: { r: groupRow, c: 10 } },
    { s: { r: groupRow, c: 11 }, e: { r: groupRow, c: 13 } },
    { s: { r: groupRow, c: 14 }, e: { r: groupRow + 1, c: 14 } },
  ];
  grid['!cols'] = [11, 9, 7, 14, 30, 11, 11, 13, 11, 11, 13, 11, 11, 13, 60].map((wch) => ({
    wch,
  }));

  const layers = XLSX.utils.aoa_to_sheet([
    ['Capas PEPS al cierre del período', null, null],
    ['Cantidad', 'Costo unitario', 'Costo total'],
    ...peps.closing.layers.map((l) => [num(l.qty), num(l.unitCost), num(l.total)]),
  ]);
  layers['!cols'] = [12, 14, 14].map((wch) => ({ wch }));

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, grid, 'Formato 13.1');
  XLSX.utils.book_append_sheet(book, layers, 'Capas al cierre');
  const code = report.itemCode.replace(/[^A-Za-z0-9._-]/g, '_');
  return {
    buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
    filename: `kardex-peps-${code}-${report.from}-${report.to}.xlsx`,
  };
}
