import { createHash } from 'node:crypto';
import { PURCHASE_IMPORT_COLUMNS, QUOTATION_IMPORT_COLUMNS } from '@ayr/shared';
import {
  dispatchModeOf,
  LOAD_COLUMNS,
  LOAD_SHEETS,
  paymentTermsOf,
  type LoadProductInfo,
  type Sheets,
} from './backdated-load';
import { getField, parseCalendarDate, rawToString } from './parse-spreadsheet';

/**
 * cc64 (D-705) — **las operaciones de una carga atrasada**, en el orden en que el cargador
 * (`pnpm carga:ejecutar`) las ejecuta: el de D-704 y, dentro de cada paso, de la fecha más antigua a
 * la más nueva. Cada operación tiene una **clave estable** sacada de los datos del plan (no de la
 * posición de la fila): la usa el manifiesto del lote para saltar lo ya hecho, la clave de
 * idempotencia de cada llamada y la reversa. Pura: no lee la base.
 */

export const LOAD_STEPS = [
  'purchases',
  'sales',
  'orders',
  'production',
  'dispatches',
  'invoices',
  'collections',
  'supplierPayments',
] as const;
export type LoadStep = (typeof LOAD_STEPS)[number];

export const LOAD_STEP_LABELS: Record<LoadStep, string> = {
  purchases: 'Compras (alta y recepción)',
  sales: 'Ventas: importar la cotización',
  orders: 'Ventas: confirmar el pedido',
  production: 'Producción (parte y cierre)',
  dispatches: 'Despachos',
  invoices: 'Comprobantes manuales',
  collections: 'Cobros',
  supplierPayments: 'Pagos a proveedores',
};

interface Base {
  key: string;
  date: string;
  /** Filas del Excel que la componen (hoja y número de fila), para el informe. */
  rows: { sheet: string; row: number }[];
}

export type LoadOp =
  | (Base & {
      step: 'purchases';
      supplierRuc: string;
      document: string;
      receivedDate: string;
      raws: Record<string, unknown>[];
    })
  | (Base & { step: 'sales'; document: string; raws: Record<string, unknown>[] })
  | (Base & { step: 'orders'; document: string })
  | (Base & {
      step: 'production';
      document: string;
      sku: string;
      qty: string;
      coil: string;
    })
  | (Base & {
      step: 'dispatches';
      document: string;
      items: { sku: string; qty: string }[];
      mode: 'PICKUP' | 'DELIVERY';
      destination: string;
      ubigeo: string;
    })
  | (Base & {
      step: 'invoices';
      document: string;
      docType: 'FACTURA' | 'BOLETA';
      paymentTerms: 'CONTADO' | 'CREDITO' | null;
      dueDate: string | null;
    })
  | (Base & {
      step: 'collections';
      document: string;
      amount: string;
      method: string;
      reference: string;
    })
  | (Base & {
      step: 'supplierPayments';
      supplierRuc: string;
      document: string;
      amount: string;
      method: string;
      reference: string;
    });

export interface PlannedLoad {
  ops: LoadOp[];
  /** Partes que se cargan a mano (drywall, D-705). */
  manual: { sheet: string; row: number; reason: string }[];
}

const cell = (raw: Record<string, unknown>, header: string) =>
  getField(raw, { key: header, header, required: false });
const dateOf = (raw: Record<string, unknown>, header: string) =>
  parseCalendarDate(cell(raw, header)) ?? '';
const rowNumber = (i: number) => i + 2;
const norm = (s: string) => s.trim().toUpperCase().replaceAll(/\s/g, '');

/**
 * La clave de idempotencia de una operación: cabe en 100 caracteres y lleva el lote, así una
 * reversa y una carga corregida con otro lote no reciben el recurso viejo (D-182).
 */
export function idempotencyKeyOf(batchId: string, opKey: string, part = ''): string {
  const hash = createHash('sha256').update(`${opKey}#${part}`).digest('hex').slice(0, 32);
  return `carga-${batchId.slice(0, 40)}-${hash}`;
}

/** Las operaciones del plan, ordenadas. */
export function planLoadOps(
  sheets: Sheets,
  productInfo: ReadonlyMap<string, LoadProductInfo> = new Map(),
): PlannedLoad {
  const ops: LoadOp[] = [];
  const manual: PlannedLoad['manual'] = [];
  const seq = new Map<string, number>();
  const nth = (prefix: string) => {
    const n = (seq.get(prefix) ?? 0) + 1;
    seq.set(prefix, n);
    return n;
  };

  // 1. Compras: una operación por comprobante (proveedor y serie-número).
  const purchases = new Map<string, Extract<LoadOp, { step: 'purchases' }>>();
  sheets.purchases.forEach((raw, i) => {
    const ruc = rawToString(cell(raw, PURCHASE_IMPORT_COLUMNS.supplierRuc.header));
    const doc = norm(cell(raw, PURCHASE_IMPORT_COLUMNS.document.header));
    const key = `compra|${ruc}|${doc}`;
    const op = purchases.get(key) ?? {
      step: 'purchases' as const,
      key,
      date: dateOf(raw, LOAD_COLUMNS.receivedDate.header),
      supplierRuc: ruc,
      document: doc,
      receivedDate: dateOf(raw, LOAD_COLUMNS.receivedDate.header),
      raws: [],
      rows: [],
    };
    op.raws.push(raw);
    op.rows.push({ sheet: LOAD_SHEETS.purchases, row: rowNumber(i) });
    purchases.set(key, op);
  });
  ops.push(...purchases.values());

  // 2. Ventas: importar la cotización y confirmar el pedido; sus datos del comprobante.
  const sales = new Map<string, Extract<LoadOp, { step: 'sales' }>>();
  const invoices = new Map<string, Extract<LoadOp, { step: 'invoices' }>>();
  sheets.sales.forEach((raw, i) => {
    const docType = cell(raw, QUOTATION_IMPORT_COLUMNS.docType).toLowerCase();
    if (docType.includes('nota') || cell(raw, QUOTATION_IMPORT_COLUMNS.adjustedDocument) !== '') {
      return; // una NC del export no es una venta (como en el importador, D-152)
    }
    const doc = norm(cell(raw, QUOTATION_IMPORT_COLUMNS.documentKey));
    const date = dateOf(raw, QUOTATION_IMPORT_COLUMNS.issueDate);
    const row = { sheet: LOAD_SHEETS.sales, row: rowNumber(i) };
    const sale = sales.get(doc) ?? {
      step: 'sales' as const,
      key: `venta|${doc}`,
      date,
      document: doc,
      raws: [],
      rows: [],
    };
    sale.raws.push(raw);
    sale.rows.push(row);
    sales.set(doc, sale);
    const terms = paymentTermsOf(cell(raw, LOAD_COLUMNS.paymentTerms.header));
    const invoice = invoices.get(doc) ?? {
      step: 'invoices' as const,
      key: `comprobante|${doc}`,
      date,
      document: doc,
      docType: docType.includes('boleta') ? ('BOLETA' as const) : ('FACTURA' as const),
      paymentTerms: terms === 'INVALID' ? null : terms,
      dueDate: parseCalendarDate(cell(raw, LOAD_COLUMNS.dueDate.header)) ?? null,
      rows: [],
    };
    invoice.rows.push(row);
    invoices.set(doc, invoice);
  });
  for (const sale of sales.values()) {
    ops.push(sale);
    ops.push({
      step: 'orders',
      key: `pedido|${sale.document}`,
      date: sale.date,
      document: sale.document,
      rows: sale.rows,
    });
  }

  // 3. Producción: un parte por fila; drywall se carga a mano.
  sheets.production.forEach((raw, i) => {
    const doc = norm(cell(raw, LOAD_COLUMNS.saleDocument.header));
    const sku = cell(raw, LOAD_COLUMNS.sku.header);
    const row = { sheet: LOAD_SHEETS.production, row: rowNumber(i) };
    if (productInfo.get(sku)?.drywall) {
      manual.push({ ...row, reason: `${sku} es de drywall: el parte se carga a mano` });
      return;
    }
    ops.push({
      step: 'production',
      key: `parte|${doc}|${sku}|${String(nth(`parte|${doc}|${sku}`))}`,
      date: dateOf(raw, LOAD_COLUMNS.date.header),
      document: doc,
      sku,
      qty: cell(raw, LOAD_COLUMNS.qty.header),
      coil: cell(raw, LOAD_COLUMNS.coil.header),
      rows: [row],
    });
  });

  // 4. Despachos: las filas de una venta, fecha y destino van en un solo despacho.
  const dispatches = new Map<string, Extract<LoadOp, { step: 'dispatches' }>>();
  sheets.dispatches.forEach((raw, i) => {
    const doc = norm(cell(raw, LOAD_COLUMNS.saleDocument.header));
    const date = dateOf(raw, LOAD_COLUMNS.date.header);
    const mode = dispatchModeOf(cell(raw, LOAD_COLUMNS.mode.header)) ?? 'PICKUP';
    const destination = cell(raw, LOAD_COLUMNS.destination.header);
    const ubigeo = cell(raw, LOAD_COLUMNS.ubigeo.header);
    const group = `${doc}|${date}|${mode}|${destination}|${ubigeo}`;
    let op = dispatches.get(group);
    if (!op) {
      op = {
        step: 'dispatches',
        key: `despacho|${doc}|${date}|${String(nth(`despacho|${doc}|${date}`))}`,
        date,
        document: doc,
        items: [],
        mode,
        destination,
        ubigeo,
        rows: [],
      };
      dispatches.set(group, op);
    }
    op.items.push({
      sku: cell(raw, LOAD_COLUMNS.sku.header),
      qty: cell(raw, LOAD_COLUMNS.qty.header),
    });
    op.rows.push({ sheet: LOAD_SHEETS.dispatches, row: rowNumber(i) });
  });
  ops.push(...dispatches.values());

  // 5. Comprobantes manuales.
  ops.push(...invoices.values());

  // 6. Cobros y pagos.
  sheets.collections.forEach((raw, i) => {
    const doc = norm(cell(raw, LOAD_COLUMNS.saleDocument.header));
    ops.push({
      step: 'collections',
      key: `cobro|${doc}|${String(nth(`cobro|${doc}`))}`,
      date: dateOf(raw, LOAD_COLUMNS.date.header),
      document: doc,
      amount: cell(raw, LOAD_COLUMNS.amount.header),
      method: cell(raw, LOAD_COLUMNS.method.header),
      reference: cell(raw, LOAD_COLUMNS.reference.header),
      rows: [{ sheet: LOAD_SHEETS.collections, row: rowNumber(i) }],
    });
  });
  sheets.supplierPayments.forEach((raw, i) => {
    const ruc = rawToString(cell(raw, LOAD_COLUMNS.supplierRuc.header));
    const doc = norm(cell(raw, LOAD_COLUMNS.purchaseDocument.header));
    ops.push({
      step: 'supplierPayments',
      key: `pago|${ruc}|${doc}|${String(nth(`pago|${ruc}|${doc}`))}`,
      date: dateOf(raw, LOAD_COLUMNS.date.header),
      supplierRuc: ruc,
      document: doc,
      amount: cell(raw, LOAD_COLUMNS.amount.header),
      method: cell(raw, LOAD_COLUMNS.method.header),
      reference: cell(raw, LOAD_COLUMNS.reference.header),
      rows: [{ sheet: LOAD_SHEETS.supplierPayments, row: rowNumber(i) }],
    });
  });

  // El orden: paso; dentro del paso, fecha; a igual fecha, el orden del archivo. La venta va
  // antes que su pedido aunque los dos pasos se intercalen por fecha.
  const stepIndex = (s: LoadStep) => LOAD_STEPS.indexOf(s);
  const indexed = ops.map((op, i) => ({ op, i }));
  indexed.sort(
    (a, b) =>
      stepIndex(a.op.step) - stepIndex(b.op.step) ||
      a.op.date.localeCompare(b.op.date) ||
      a.i - b.i,
  );
  return { ops: indexed.map((x) => x.op), manual };
}
