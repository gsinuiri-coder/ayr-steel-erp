import type { Prisma } from '@prisma/client';
import { detailsLengths, QUOTATION_IMPORT_COLUMNS } from '@ayr/shared';
import { qtyRowsOf } from '../inventory/inventory-recost';
import type { QtyRow } from '../inventory/recost-engine';
import * as XLSX from 'xlsx';
import {
  LOAD_COLUMNS,
  LOAD_SHEETS,
  type LoadContext,
  type LoadProductInfo,
  type LoadReview,
  type Sheets,
} from './backdated-load';
import { getField } from './parse-spreadsheet';

/** Los SKU y las bobinas que nombra el plan (para leer solo su kardex). */
export function namedItems(sheets: Sheets): { skus: Set<string>; coils: Set<string> } {
  const skus = new Set<string>();
  const coils = new Set<string>();
  const sku = (raw: Record<string, unknown>, header: string) => {
    const v = getField(raw, { key: header, header, required: false });
    if (v) skus.add(v);
  };
  for (const r of sheets.purchases) {
    sku(r, 'SKU');
    // Revisión de cc63 (H-4): una bobina nueva que ya existe en la base tiene que verse como tal.
    const external = getField(r, {
      key: 'externalCode',
      header: 'CÓDIGO EXTERNO',
      required: false,
    });
    if (external) coils.add(external);
  }
  for (const r of [...sheets.sales, ...sheets.production, ...sheets.dispatches]) {
    sku(r, LOAD_COLUMNS.sku.header);
  }
  for (const r of sheets.production) {
    const c = getField(r, LOAD_COLUMNS.coil);
    if (c) coils.add(c);
  }
  return { skus, coils };
}

/**
 * cc63/cc64: lo que la revisión necesita de la base (solo lecturas): el kardex en cantidades de cada
 * ítem que el plan nombra, los SKU y bobinas que existen y, desde cc64 (D-705), si cada producto es
 * de drywall o lleva largos. Una bobina se reconoce por su código o por su código externo.
 */
export async function loadReviewContext(
  tx: Prisma.TransactionClient,
  sheets: Sheets,
  opts: { loadDate: string; historicalFloor: string },
): Promise<LoadContext> {
  const named = namedItems(sheets);
  const products = await tx.product.findMany({
    where: { sku: { in: [...named.skus] } },
    select: {
      id: true,
      sku: true,
      unit: true,
      roofingKind: true,
      businessLine: { select: { code: true } },
    },
  });
  const coils = await tx.coil.findMany({
    where: {
      status: { not: 'CANCELLED' },
      OR: [{ code: { in: [...named.coils] } }, { externalCode: { in: [...named.coils] } }],
    },
    select: { id: true, code: true, externalCode: true },
  });
  const kardex = new Map<string, QtyRow[]>();
  const productInfo = new Map<string, LoadProductInfo>();
  for (const p of products) {
    kardex.set(`PRODUCT:${p.sku}`, await qtyRowsOf(tx, { itemType: 'PRODUCT', itemId: p.id }));
    productInfo.set(p.sku, {
      drywall: p.businessLine.code === 'DRYWALL',
      needsLengths: detailsLengths({ unit: p.unit, roofingKind: p.roofingKind }),
    });
  }
  const coilNames = new Set<string>();
  for (const c of coils) {
    const rows = await qtyRowsOf(tx, { itemType: 'COIL', itemId: c.id });
    for (const name of [c.code, c.externalCode]) {
      if (name && named.coils.has(name)) {
        kardex.set(`COIL:${name}`, rows);
        coilNames.add(name);
      }
    }
  }
  const customerDocs = sheets.sales.flatMap((r) => {
    const m = /^(\d{8,11})\s*-/.exec(
      getField(r, { key: 'customer', header: QUOTATION_IMPORT_COLUMNS.customer, required: false }),
    );
    return m?.[1] ? [m[1]] : [];
  });
  const customers = await tx.customer.findMany({
    where: { docNumber: { in: [...new Set(customerDocs)] } },
    select: { docNumber: true },
  });
  return {
    loadDate: opts.loadDate,
    historicalFloor: opts.historicalFloor,
    customers: new Set(customers.map((c) => c.docNumber)),
    kardex,
    products: new Set(products.map((p) => p.sku)),
    coils: coilNames,
    productInfo,
  };
}

/** El plan de carga: una lista de filas por hoja (las hojas que faltan, vacías). */
export function readLoadSheets(buffer: Buffer): Sheets {
  const book = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const out = {} as Sheets;
  for (const [key, name] of Object.entries(LOAD_SHEETS) as [keyof typeof LOAD_SHEETS, string][]) {
    const sheet = book.Sheets[name];
    out[key] = sheet
      ? XLSX.utils
          .sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
          .filter((r) => Object.values(r).some((v) => String(v).trim() !== ''))
      : [];
  }
  return out;
}

/** El informe de la revisión, en markdown. */
export function reviewMarkdown(r: LoadReview): string {
  const lines = [
    `# Revisión previa de la carga atrasada`,
    '',
    `Fecha de carga simulada: ${r.loadDate}. Movimientos de kardex: ${String(r.movements.planned)} (${String(r.movements.rejected)} rechazados por D-652).`,
    '',
    `Hojas: ${Object.entries(r.counts)
      .map(([k, v]) => `${k} ${String(v)}`)
      .join(' · ')}`,
    r.oldestIssue
      ? `Comprobante más antiguo: ${r.oldestIssue.document} del ${r.oldestIssue.issueDate}; se puede registrar hasta el ${r.oldestIssue.lastLoadDate}.`
      : 'Sin comprobantes.',
    '',
    // cc65: los clientes que se crearán desde el padrón, al inicio, para revisarlos antes.
    `## Clientes que se crearán desde el padrón (${String(r.newCustomers.length)})`,
    '',
    ...(r.newCustomers.length === 0
      ? ['Ninguno: todos los clientes ya existen.']
      : r.newCustomers.map(
          (c) =>
            `- ${c.document} · ${c.name === '' ? '(sin nombre en el export)' : c.name} · Ventas fila${c.rows.length === 1 ? '' : 's'} ${c.rows.join(', ')}`,
        )),
    '',
    '## Orden de carga',
    '',
    ...r.order.map((s, i) => `${String(i + 1)}. ${s}`),
    '',
    `## Errores (${String(r.errors.length)})`,
    '',
    ...r.errors.map((e) => `- ${e.sheet}${e.row ? ` fila ${String(e.row)}` : ''}: ${e.message}`),
    '',
    `## Avisos (${String(r.warnings.length)})`,
    '',
    ...r.warnings.map((e) => `- ${e.sheet}${e.row ? ` fila ${String(e.row)}` : ''}: ${e.message}`),
    '',
    `## Recosteos (${String(r.recosts.length)}; máximo ${String(Math.max(0, ...r.recosts.map((x) => x.rowsAfter)))} filas)`,
    '',
    ...r.recosts
      .slice()
      .sort((a, b) => b.rowsAfter - a.rowsAfter)
      .slice(0, 50)
      .map(
        (x) =>
          `- ${x.item} el ${x.date} (${x.sheet} fila ${String(x.row)}): ${String(x.rowsAfter)} filas${x.overLimit ? ' — PASA EL TOPE' : ''}`,
      ),
  ];
  return `${lines.join('\n')}\n`;
}
