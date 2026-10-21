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
import {
  loadReviewContext,
  readLoadSheets,
  reviewMarkdown,
} from '../src/imports/backdated-load-context';
import {
  LOAD_ORDER,
  LOAD_SHEET_HEADERS,
  LOAD_SHEETS,
  reviewBackdatedLoad,
  type LoadReview,
} from '../src/imports/backdated-load';

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
    ['Plan de carga atrasada (cc63, cc64)'],
    ['Una hoja por tipo de operación. Las fechas, en AAAA-MM-DD o DD/MM/AAAA.'],
    ['«Compras» tiene las columnas del importador de compras más FECHA DE RECEPCIÓN.'],
    [
      '«Ventas» es el export del sistema de facturación (el que lee el importador de cotizaciones).',
    ],
    [
      'Ventas, opcionales al final: LARGOS (obligatoria en líneas a medida: «4.5x10; 3x8», metros x piezas), CONDICIÓN DE PAGO (CONTADO o CRÉDITO; vacía = el plazo del cliente) y VENCIMIENTO.',
    ],
    ['«Producción», «Despachos» y «Cobros» se enlazan con la venta por SERIE - NÚMERO.'],
    [
      'Producción: CANTIDAD en planchas, o en metros si es a medida o accesorio. Los partes de drywall se cargan a mano: carga:ejecutar --hasta pedidos, el corte y los partes de drywall en la app con la fecha y la cantidad de esta hoja, y otra vez carga:ejecutar con el mismo --archivo y el mismo --lote.',
    ],
    [
      'Despachos: MODALIDAD RECOJO o ENTREGA (vacía = recojo, con aviso). Con ENTREGA, DIRECCIÓN DESTINO y UBIGEO (6 dígitos).',
    ],
    ['Una bobina nueva se nombra por su CÓDIGO EXTERNO en Compras y en Producción.'],
    [
      'Revísalo con pnpm carga:revisar y cárgalo con pnpm carga:ejecutar (docs/operacion/carga-atrasada.md).',
    ],
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
  const sheets = readLoadSheets(readFileSync(file));

  const prisma = new PrismaClient();
  let review: LoadReview;
  try {
    review = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const ctx = await loadReviewContext(tx, sheets, {
          loadDate,
          historicalFloor: process.env.HISTORICAL_LOAD_START ?? DEFAULT_HISTORICAL_LOAD_START,
        });
        return reviewBackdatedLoad(sheets, ctx);
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
  writeFileSync(`${base}.md`, reviewMarkdown(review));
  console.error(reviewMarkdown(review));
  console.error(`Informe en ${base}.md`);
  if (review.errors.length > 0) process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
