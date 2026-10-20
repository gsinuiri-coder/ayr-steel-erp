/**
 * cc63 — **revisión previa de una carga atrasada** (solo lectura):
 *   `pnpm carga:revisar --archivo <plan.xlsx> [--fecha-carga AAAA-MM-DD] [--branch <rama>]`
 *   `pnpm carga:revisar --plantilla <salida.xlsx>`   (escribe la plantilla vacía)
 *
 * Lee el plan de carga (una hoja por tipo, `LOAD_SHEETS`), lee de la base el kardex de los ítems que
 * nombra (en una transacción de solo lectura) y escribe el informe de `reviewBackdatedLoad` en
 * `local-data/carga-atrasada/` (fuera del repo: trae datos del negocio). No escribe nada en la base
 * y no tiene `--execute`.
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import * as XLSX from 'xlsx';
import { businessToday, DEFAULT_HISTORICAL_LOAD_START, isCalendarDate } from '@ayr/shared';
import { assertExecuteAllowed } from './cli-gate';
import { qtyRowsOf } from '../src/inventory/inventory-recost';
import type { QtyRow } from '../src/inventory/recost-engine';
import {
  LOAD_COLUMNS,
  LOAD_ORDER,
  LOAD_SHEET_HEADERS,
  LOAD_SHEETS,
  reviewBackdatedLoad,
  type LoadReview,
  type Sheets,
} from '../src/imports/backdated-load';
import { getField } from '../src/imports/parse-spreadsheet';

const args = process.argv.slice(2);
const ROOT = resolve(__dirname, '../../../..');

function flag(name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requiere un valor`);
  return value;
}

function assertArgs(): void {
  const known = new Set(['--archivo', '--fecha-carga', '--plantilla']);
  for (let i = 0; i < args.length; i += 2) {
    if (!known.has(args[i] ?? '')) throw new Error(`Argumento no reconocido: ${args[i] ?? ''}`);
  }
}

function writeTemplate(out: string): void {
  const book = XLSX.utils.book_new();
  const instructions = [
    ['Plan de carga atrasada (cc63)'],
    ['Una hoja por tipo de operación. Las fechas, en AAAA-MM-DD o DD/MM/AAAA.'],
    ['«Compras» tiene las columnas del importador de compras más FECHA DE RECEPCIÓN.'],
    [
      '«Ventas» es el export del sistema de facturación (el que lee el importador de cotizaciones).',
    ],
    ['«Producción», «Despachos» y «Cobros» se enlazan con la venta por SERIE - NÚMERO.'],
    ['Una bobina nueva se nombra por su CÓDIGO EXTERNO en Compras y en Producción.'],
    [''],
    ['Orden de carga:'],
    ...LOAD_ORDER.map((step, i) => [`${String(i + 1)}. ${step}`]),
  ];
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(instructions), 'Instrucciones');
  for (const [key, name] of Object.entries(LOAD_SHEETS) as [keyof typeof LOAD_SHEETS, string][]) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([LOAD_SHEET_HEADERS[key]]), name);
  }
  XLSX.writeFile(book, out);
}

function readSheets(file: string): Sheets {
  const book = XLSX.read(readFileSync(file), { type: 'buffer', cellDates: true });
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

function markdown(r: LoadReview): string {
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

async function main(): Promise<void> {
  assertArgs();
  assertExecuteAllowed(false);
  const template = flag('--plantilla');
  if (template) {
    writeTemplate(template);
    console.error(`Plantilla escrita en ${template}`);
    return;
  }
  const file = flag('--archivo');
  if (!file) throw new Error('Falta --archivo <plan.xlsx> (o --plantilla <salida.xlsx>)');
  const loadDate = flag('--fecha-carga') ?? businessToday();
  if (!isCalendarDate(loadDate)) throw new Error('--fecha-carga: fecha inválida');
  const branch = process.env.AYR_CLI_BRANCH ?? 'local';
  const sheets = readSheets(file);

  // Los SKU y las bobinas que nombra el plan, para leer solo su kardex.
  const skus = new Set<string>();
  const coilCodes = new Set<string>();
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
    if (external) coilCodes.add(external);
  }
  for (const r of [...sheets.sales, ...sheets.production, ...sheets.dispatches]) {
    sku(r, LOAD_COLUMNS.sku.header);
  }
  for (const r of sheets.production) {
    const c = getField(r, LOAD_COLUMNS.coil);
    if (c) coilCodes.add(c);
  }

  const prisma = new PrismaClient();
  let review: LoadReview;
  try {
    review = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const products = await tx.product.findMany({
          where: { sku: { in: [...skus] } },
          select: { id: true, sku: true },
        });
        const coils = await tx.coil.findMany({
          where: { code: { in: [...coilCodes] } },
          select: { id: true, code: true },
        });
        const kardex = new Map<string, QtyRow[]>();
        for (const p of products) {
          kardex.set(
            `PRODUCT:${p.sku}`,
            await qtyRowsOf(tx, { itemType: 'PRODUCT', itemId: p.id }),
          );
        }
        for (const c of coils) {
          kardex.set(`COIL:${c.code}`, await qtyRowsOf(tx, { itemType: 'COIL', itemId: c.id }));
        }
        return reviewBackdatedLoad(sheets, {
          loadDate,
          historicalFloor: process.env.HISTORICAL_LOAD_START ?? DEFAULT_HISTORICAL_LOAD_START,
          kardex,
          products: new Set(products.map((p) => p.sku)),
          coils: new Set(coils.map((c) => c.code)),
        });
      },
      { timeout: 10 * 60_000, maxWait: 30_000 },
    );
  } finally {
    await prisma.$disconnect();
  }
  const outDir = resolve(ROOT, 'local-data/carga-atrasada');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const base = resolve(outDir, `revision-${branch}-${stamp}`);
  writeFileSync(`${base}.json`, JSON.stringify(review, null, 2));
  writeFileSync(`${base}.md`, markdown(review));
  console.error(markdown(review));
  console.error(`Informe en ${base}.md`);
  if (review.errors.length > 0) process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
