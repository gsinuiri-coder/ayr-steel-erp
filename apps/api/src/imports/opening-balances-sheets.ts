import * as XLSX from 'xlsx';
import { getField, parseSpreadsheet, type ImportColumn } from './parse-spreadsheet';
import type { OpeningRow } from './opening-balances-plan';

/**
 * cc56 (D-668) — las planillas de saldos iniciales: qué columnas tienen, cómo se leen y cómo se
 * generan las plantillas (vacía con un ejemplo ficticio, o prellenada con las cuentas vivas).
 *
 * Las columnas «informativas» (cliente, total, saldo en la app) están para que el dueño sepa qué
 * comprobante es; el importador no las lee. Solo cuentan la clave (comprobante, o RUC + compra) y
 * las columnas de lo cobrado o del saldo al corte.
 */

export type OpeningSide = 'CUSTOMERS' | 'SUPPLIERS';

const CUSTOMER_COLUMNS = {
  key: { key: 'key', header: 'Comprobante', required: true },
  date: { key: 'date', header: 'Fecha de cobro', required: false },
  amount: { key: 'amount', header: 'Monto cobrado S/', required: false },
  method: { key: 'method', header: 'Medio', required: false },
  reference: { key: 'reference', header: 'Referencia', required: false },
  balance: { key: 'balance', header: 'Saldo pendiente al corte S/', required: false },
} satisfies Record<string, ImportColumn>;

const SUPPLIER_COLUMNS = {
  supplierDoc: { key: 'supplierDoc', header: 'RUC proveedor', required: true },
  document: { key: 'document', header: 'Compra', required: true },
  date: { key: 'date', header: 'Fecha de pago', required: false },
  amount: { key: 'amount', header: 'Monto pagado', required: false },
  exchangeRate: { key: 'exchangeRate', header: 'Tipo de cambio', required: false },
  method: { key: 'method', header: 'Medio', required: false },
  reference: { key: 'reference', header: 'Referencia', required: false },
  balance: { key: 'balance', header: 'Saldo pendiente al corte', required: false },
} satisfies Record<string, ImportColumn>;

/** La clave de una compra en el plan: RUC del proveedor y serie-número del papel. */
export function supplierKey(supplierDoc: string, document: string): string {
  return `${supplierDoc.trim()} · ${document.trim().toUpperCase()}`;
}

/** Las filas de la primera hoja del archivo, ya con la clave armada. La fila 1 es el encabezado. */
export function readOpeningRows(buffer: Buffer, side: OpeningSide): OpeningRow[] {
  const raw = parseSpreadsheet(buffer);
  return raw.map((r, i) => {
    const rowNumber = i + 2;
    if (side === 'CUSTOMERS') {
      const c = CUSTOMER_COLUMNS;
      return {
        rowNumber,
        key: getField(r, c.key).toUpperCase(),
        date: getField(r, c.date),
        amount: getField(r, c.amount),
        method: getField(r, c.method),
        reference: getField(r, c.reference),
        balance: getField(r, c.balance),
      };
    }
    const s = SUPPLIER_COLUMNS;
    const supplierDoc = getField(r, s.supplierDoc);
    const document = getField(r, s.document);
    return {
      rowNumber,
      key: supplierDoc === '' && document === '' ? '' : supplierKey(supplierDoc, document),
      date: getField(r, s.date),
      amount: getField(r, s.amount),
      method: getField(r, s.method),
      reference: getField(r, s.reference),
      balance: getField(r, s.balance),
      exchangeRate: getField(r, s.exchangeRate),
    };
  });
}

/** Una fila de la plantilla de cobranzas: lo informativo del comprobante. */
export interface CustomerTemplateRow {
  number: string;
  customer: string;
  customerDoc: string;
  issueDate: string;
  dueDate: string | null;
  totalPen: string;
  balancePen: string;
}

/** Una fila de la plantilla de pagos: lo informativo de la compra. */
export interface SupplierTemplateRow {
  supplierDoc: string;
  supplier: string;
  document: string;
  issueDate: string;
  currency: string;
  total: string;
  balance: string;
}

const CUSTOMER_HEADERS = [
  CUSTOMER_COLUMNS.key.header,
  'Cliente',
  'RUC / DNI',
  'Emisión',
  'Vencimiento',
  'Total S/',
  'Saldo en la app S/',
  CUSTOMER_COLUMNS.date.header,
  CUSTOMER_COLUMNS.amount.header,
  CUSTOMER_COLUMNS.method.header,
  CUSTOMER_COLUMNS.reference.header,
  CUSTOMER_COLUMNS.balance.header,
];

const SUPPLIER_HEADERS = [
  SUPPLIER_COLUMNS.supplierDoc.header,
  'Proveedor',
  SUPPLIER_COLUMNS.document.header,
  'Emisión',
  'Moneda',
  'Total',
  'Saldo en la app',
  SUPPLIER_COLUMNS.date.header,
  SUPPLIER_COLUMNS.amount.header,
  SUPPLIER_COLUMNS.exchangeRate.header,
  SUPPLIER_COLUMNS.method.header,
  SUPPLIER_COLUMNS.reference.header,
  SUPPLIER_COLUMNS.balance.header,
];

/** El ejemplo ficticio de la plantilla vacía: datos inventados, nunca de un cliente real. */
const CUSTOMER_EXAMPLE: (string | number)[][] = [
  [
    'F001-00000001',
    'CLIENTE DE EJEMPLO SAC',
    '20000000001',
    '2026-08-10',
    '2026-09-09',
    1180,
    1180,
    '2026-08-20',
    500,
    'Transferencia',
    'OP 123456',
    '',
  ],
  [
    'F001-00000001',
    'CLIENTE DE EJEMPLO SAC',
    '20000000001',
    '2026-08-10',
    '2026-09-09',
    1180,
    1180,
    '2026-09-05',
    300,
    'Depósito',
    '',
    '',
  ],
  [
    'F001-00000002',
    'OTRO CLIENTE EIRL',
    '20000000002',
    '2026-09-01',
    '2026-10-01',
    2360,
    2360,
    '',
    '',
    '',
    '',
    1000,
  ],
];

const SUPPLIER_EXAMPLE: (string | number)[][] = [
  [
    '20000000009',
    'PROVEEDOR DE EJEMPLO SAC',
    'F001-000123',
    '2026-08-05',
    'PEN',
    5900,
    5900,
    '2026-08-30',
    5900,
    '',
    'Transferencia',
    'OP 987654',
    '',
  ],
  [
    '20000000009',
    'PROVEEDOR DE EJEMPLO SAC',
    'F001-000124',
    '2026-09-02',
    'USD',
    3000,
    3000,
    '2026-09-20',
    1000,
    3.75,
    'Transferencia',
    '',
    '',
  ],
  [
    '20000000008',
    'OTRO PROVEEDOR SRL',
    'E001-55',
    '2026-09-10',
    'PEN',
    1200,
    1200,
    '',
    '',
    '',
    '',
    '',
    200,
  ],
];

function instructions(side: OpeningSide, cutoffHint: string): string[][] {
  const what = side === 'CUSTOMERS' ? 'comprobante' : 'compra';
  const paid = side === 'CUSTOMERS' ? 'cobrado' : 'pagado';
  const lines = [
    `Saldos iniciales de ${side === 'CUSTOMERS' ? 'cobranzas' : 'pagos a proveedor'} (cc56, D-668)`,
    '',
    `Cada fila es un ${what}. Llena UNA de estas dos formas (no las dos en la misma fila):`,
    `  A) Lo ${paid} hasta la fecha de corte: fecha, monto y medio. Si hubo varios, una fila por cada uno (repite el ${what}).`,
    `  B) Solo el saldo que quedaba pendiente a la fecha de corte (columna «Saldo pendiente al corte»). Si ya estaba todo ${paid}, pon 0.`,
    '',
    `Si dejas un ${what} en blanco (o lo borras), se trata según la opción que elijas al importar:`,
    `  «pagado al corte»: se registra como ${paid} entero a la fecha de corte;`,
    '  «sigue pendiente»: no se toca.',
    '',
    `Fechas: AAAA-MM-DD o DD/MM/AAAA, no posteriores al corte (${cutoffHint}).`,
    'Medios: Efectivo, Transferencia, Cheque, Depósito, Tarjeta, Yape / Plin, Otro. Vacío = Otro.',
    side === 'CUSTOMERS'
      ? 'Montos en soles, con IGV (lo que figura en el comprobante).'
      : 'Montos en la moneda de la compra (columna «Moneda»). Tipo de cambio: solo compras en dólares, opcional.',
    side === 'CUSTOMERS'
      ? 'Cliente, RUC / DNI, Emisión, Vencimiento, Total y Saldo en la app son de referencia: no se leen.'
      : 'Proveedor, Emisión, Moneda, Total y Saldo en la app son de referencia: no se leen.',
    '',
    'Nada se registra hasta que el lote pase sin errores; cada cobro queda auditado con su lote y se puede deshacer entero.',
  ];
  return lines.map((l) => [l]);
}

function workbook(
  name: string,
  headers: string[],
  rows: (string | number)[][],
  side: OpeningSide,
  cutoffHint: string,
): Buffer {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  sheet['!cols'] = headers.map((h) => ({ wch: Math.max(12, h.length + 2) }));
  XLSX.utils.book_append_sheet(book, sheet, name);
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet(instructions(side, cutoffHint)),
    'Instrucciones',
  );
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** Plantilla de cobranzas: vacía (con el ejemplo ficticio) o prellenada con los comprobantes. */
export function customerTemplate(rows: CustomerTemplateRow[] | null, cutoffHint: string): Buffer {
  const body =
    rows === null
      ? CUSTOMER_EXAMPLE
      : rows.map((r) => [
          r.number,
          r.customer,
          r.customerDoc,
          r.issueDate,
          r.dueDate ?? '',
          Number(r.totalPen),
          Number(r.balancePen),
          '',
          '',
          '',
          '',
          '',
        ]);
  return workbook('Cobranzas', CUSTOMER_HEADERS, body, 'CUSTOMERS', cutoffHint);
}

/** Plantilla de pagos a proveedor: vacía (con el ejemplo ficticio) o prellenada con las compras. */
export function supplierTemplate(rows: SupplierTemplateRow[] | null, cutoffHint: string): Buffer {
  const body =
    rows === null
      ? SUPPLIER_EXAMPLE
      : rows.map((r) => [
          r.supplierDoc,
          r.supplier,
          r.document,
          r.issueDate,
          r.currency,
          Number(r.total),
          Number(r.balance),
          '',
          '',
          '',
          '',
          '',
          '',
        ]);
  return workbook('Pagos', SUPPLIER_HEADERS, body, 'SUPPLIERS', cutoffHint);
}
