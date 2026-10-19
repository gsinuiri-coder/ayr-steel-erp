import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import { CLOSE_PREVIEW_TIMEOUT_MS, COMMIT_PREVIEW_TIMEOUT_MS } from '../production/close-preview';
import { KARDEX_TX_OPTIONS, RECOST_TX_OPTIONS } from './transaction-options';

/**
 * cc53 (hotfix) — **el tope de las transacciones que tocan kardex.** Registrar una NC de devolución
 * (D-646) daba 500 contra Neon porque su transacción usaba los 5 s por defecto de Prisma. Este
 * centinela fija:
 *
 * 1. los caminos corregidos en el hotfix usan `KARDEX_TX_OPTIONS`;
 * 2. toda transacción interactiva cuyo cuerpo llama al kardex (`inventory.record/reverse/adjustCost/
 *    replaceEntry/recostForward`), a una devolución (`salesReturns.…InTx`) o a un despacho
 *    (`dispatches.…InTx`) lleva un tope propio de al menos 30 s;
 * 3. cc57 (B-06 de audit-01): también toda transacción que toma filas por la puerta de bloqueos
 *    (`lockDocuments`, `lockInOrder`): bloquea varias filas y consulta por fila, y con los 5 s por
 *    defecto de Prisma era el `P2028` intermitente contra Neon.
 */
const SRC = join(__dirname, '..');
const MIN_TIMEOUT_MS = 30_000;
const KNOWN: Record<string, number> = {
  KARDEX_TX_OPTIONS: KARDEX_TX_OPTIONS.timeout,
  RECOST_TX_OPTIONS: RECOST_TX_OPTIONS.timeout,
  REACTIVATION_TX_TIMEOUT_MS: 30_000,
  COMMIT_PREVIEW_TIMEOUT_MS,
  // cc57: el parámetro de `previewPlantClose`; sus llamadores pasan CLOSE_PREVIEW_TIMEOUT_MS o
  // COMMIT_PREVIEW_TIMEOUT_MS (120 s). Para el piso se cuenta el menor.
  timeoutMs: Math.min(CLOSE_PREVIEW_TIMEOUT_MS, COMMIT_PREVIEW_TIMEOUT_MS),
};
/**
 * cc54 (P2-5 de la revisión de cc53): con o sin `this.` (un auxiliar que recibe `inventory` como
 * parámetro también llega al kardex).
 */
const KARDEX_CALL =
  /\b(inventory\.(record|reverse|adjustCost|replaceEntry|recostForward)|salesReturns\.[a-zA-Z]+InTx|dispatches\.[a-zA-Z]+InTx|lockDocuments|lockInOrder)\(/;

interface FnDecl {
  name: string;
  body: string;
}

/**
 * cc54 (P2-5): las funciones sueltas (no métodos) del código que llegan al kardex, directo o por
 * otra función suelta que llega. Una transacción que llama a una de estas también necesita tope.
 */
function kardexHelpers(): Set<string> {
  const fns: FnDecl[] = [];
  for (const path of sources(SRC)) {
    const text = readFileSync(path, 'utf8');
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        fns.push({ name: node.name.getText(sf), body: node.body.getText(sf) });
      }
      // `const helper = async (…) => …` también es una función suelta.
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        fns.push({ name: node.name.getText(sf), body: node.initializer.body.getText(sf) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const found = new Set(fns.filter((f) => KARDEX_CALL.test(f.body)).map((f) => f.name));
  for (let grew = true; grew;) {
    grew = false;
    for (const f of fns) {
      if (found.has(f.name)) continue;
      if ([...found].some((h) => new RegExp(`\\b${h}\\(`).test(f.body))) {
        found.add(f.name);
        grew = true;
      }
    }
  }
  return found;
}

/** Si el cuerpo llama al kardex directo o por un auxiliar que llega a él. */
function reachesKardex(body: string, helpers: ReadonlySet<string>): boolean {
  return KARDEX_CALL.test(body) || [...helpers].some((h) => new RegExp(`\\b${h}\\(`).test(body));
}

/** Los caminos del hotfix: registrar y anular NC, merma, anular merma, anular bobina, soltar bobina. */
const HOTFIX: [string, string][] = [
  ['invoicing/invoicing.service.ts', 'registerManual'],
  ['invoicing/fiscal-import.service.ts', 'annulExternal'],
  ['coils/coil-operations.service.ts', 'registerScrap'],
  ['coils/coil-operations.service.ts', 'cancelScrap'],
  ['coils/coil-operations.service.ts', 'cancel'],
  ['production/roofing-production.service.ts', 'releaseCoil'],
];

interface TxCall {
  file: string;
  method: string;
  options: string | null;
  body: string;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('spec.ts') ? [p] : [];
  });
}

function transactions(): TxCall[] {
  const out: TxCall[] = [];
  for (const path of sources(SRC)) {
    const text = readFileSync(path, 'utf8');
    if (!text.includes('$transaction')) continue;
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node, method: string) => {
      const name =
        ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)
          ? (node.name?.getText(sf) ?? method)
          : method;
      if (ts.isCallExpression(node) && node.expression.getText(sf).endsWith('$transaction')) {
        const [body, options] = node.arguments;
        if (body && !ts.isArrayLiteralExpression(body)) {
          out.push({
            file: relative(SRC, path).replace(/\\/g, '/'),
            method: name,
            options: options ? options.getText(sf) : null,
            body: body.getText(sf),
          });
        }
      }
      ts.forEachChild(node, (c) => {
        visit(c, name);
      });
    };
    visit(sf, '');
  }
  return out;
}

/** El tope en ms que declara el segundo argumento, o `null` si no declara uno. */
function timeoutOf(options: string | null): number | null {
  if (options === null) return null;
  const known = KNOWN[options.trim()];
  if (known !== undefined) return known;
  const product = /timeout:\s*(\d+)\s*\*\s*([\d_]+)/.exec(options);
  if (product?.[1] && product[2]) return Number(product[1]) * Number(product[2].replace(/_/g, ''));
  const literal = /timeout:\s*([\d_]+)/.exec(options);
  if (literal?.[1]) return Number(literal[1].replace(/_/g, ''));
  const named = /timeout:\s*([A-Za-z_]+)/.exec(options);
  if (named?.[1]) return KNOWN[named[1]] ?? null;
  return null;
}

describe('cc53 (hotfix): tope de las transacciones del kardex', () => {
  const all = transactions();

  it('el criterio es el de las reactivaciones: 30 s, con espera de conexión', () => {
    expect(KARDEX_TX_OPTIONS).toEqual({ timeout: 30_000, maxWait: 10_000 });
  });

  it.each(HOTFIX)('%s · %s usa KARDEX_TX_OPTIONS', (file, method) => {
    const calls = all.filter((t) => t.file === file && t.method === method);
    expect(calls.length).toBeGreaterThan(0);
    for (const t of calls) expect(t.options?.trim()).toBe('KARDEX_TX_OPTIONS');
  });

  it('toda transacción que llama al kardex, a una devolución o a un despacho tiene tope ≥ 30 s', () => {
    const helpers = kardexHelpers();
    const offenders = all
      .filter((t) => reachesKardex(t.body, helpers))
      .filter((t) => (timeoutOf(t.options) ?? 0) < MIN_TIMEOUT_MS)
      .map((t) => `${t.file} · ${t.method} (${t.options ?? 'sin opciones'})`);
    expect(offenders).toEqual([]);
  });

  it('ve los auxiliares que llegan al kardex sin `this.` (P2-5 de cc53)', () => {
    const helpers = kardexHelpers();
    expect(helpers).toContain('undoCoilRestoreBatch');
    expect(helpers).toContain('executePurchaseReceivedDates');
    expect(reachesKardex('await undoCoilRestoreBatch(tx, inventory, x)', helpers)).toBe(true);
    expect(reachesKardex('await inventory.record(tx, input)', helpers)).toBe(true);
    expect(reachesKardex('await tx.product.findMany()', helpers)).toBe(false);
  });

  it('timeoutOf lee las formas del repo', () => {
    expect(timeoutOf(null)).toBeNull();
    expect(timeoutOf('KARDEX_TX_OPTIONS')).toBe(30_000);
    expect(timeoutOf('{ timeout: 120_000 }')).toBe(120_000);
    expect(timeoutOf('{ timeout: REACTIVATION_TX_TIMEOUT_MS }')).toBe(30_000);
    expect(timeoutOf('{ timeout: 30 * 60_000 }')).toBe(1_800_000);
  });
});

/**
 * cc58 (D-683, B-03 de audit-01) — **el techo.** Decisión del dueño: una operación del día tiene
 * 30 s; la que recostea en bloque, 60 s. Los importadores de Excel y las herramientas de una vez
 * quedan como excepciones con nombre (una carga grande no se parte por un tope). Un tope nuevo por
 * encima de 30 s exige entrar a una de estas dos listas, con su motivo.
 */
const DAY_MAX_MS = KARDEX_TX_OPTIONS.timeout;
const RECOST_MAX_MS = RECOST_TX_OPTIONS.timeout;
/** Las que recostean en bloque: hasta 60 s. */
const RECOST_PATHS: readonly (readonly [string, string])[] = [
  ['production/production.service.ts', 'close'],
  ['production/production.service.ts', 'reopen'],
  ['production/roofing-production.service.ts', 'close'],
  ['production/roofing-production.service.ts', 'reportAndClose'],
  ['production/roofing-production.service.ts', 'reopen'],
  ['invoicing/invoicing.service.ts', 'updateManualIssueDateInTx'],
  ['invoicing/invoice-dispatch.service.ts', 'executeForInvoice'],
  // cc58 (D-686): recibir un flete que llega tarde recostea lo que ya salió.
  ['purchases/purchases.service.ts', 'receive'],
];
/** Importadores y herramientas de una vez: sin techo, con su motivo. */
const BULK_EXCEPTIONS: readonly (readonly [string, string, string])[] = [
  ['imports/purchase-import.service.ts', 'confirm', 'importador de compras (Excel)'],
  ['imports/quotation-import.service.ts', 'confirm', 'importador de cotizaciones (Excel)'],
  ['imports/initial-inventory-import.service.ts', 'run', 'inventario inicial de bobinas'],
  ['imports/initial-inventory-product-import.service.ts', 'run', 'inventario inicial de productos'],
  ['imports/imported-documents-sweep.service.ts', 'fixDocument', 'barrido de importados'],
  ['catalog/price-list-import.service.ts', 'confirm', 'carga de precios (Excel)'],
  ['catalog/price-list-import.service.ts', 'revert', 'deshacer una carga de precios'],
  ['catalog/coil-sku-normalization.service.ts', 'plan', 'normalización de SKU'],
  ['catalog/coil-sku-normalization.service.ts', 'execute', 'normalización de SKU'],
  ['catalog/coil-sku-normalization.service.ts', 'planRevert', 'normalización de SKU'],
  ['catalog/coil-sku-normalization.service.ts', 'executeRevert', 'normalización de SKU'],
  ['invoicing/invoice-dispatch.service.ts', 'planAll', 'plan de D-288 para todos los comprobantes'],
  [
    'production/roofing-production.service.ts',
    'mountCoil',
    '30 s + 3 s por bobina extra (hasta 20)',
  ],
  // Recostean, pero por tamaño quedan en 120 s: con menos, una compra de 200 líneas no se podía
  // anular nunca (Fase 2b) y un borrador grande fallaba en su vista previa (SM-1 de cc28).
  ['purchases/purchases.service.ts', 'cancel', 'hasta 200 líneas, cada una con su reversa'],
  ['purchases/purchase-received-edit.service.ts', 'commit', 'hasta 200 líneas, como anular'],
  ['production/roofing-drafts.service.ts', 'commit', 'un borrador grande (SM-1 de cc28)'],
  ['production/close-preview.ts', 'previewPlantClose', 'toma el tope de su acción (60 o 120 s)'],
  ['colors/colors.service.ts', 'planRetirement', 'retiro de un color comercial'],
  ['colors/colors.service.ts', 'retire', 'retiro de un color comercial'],
];

describe('cc58 (D-683): techo de las transacciones', () => {
  const all = transactions();
  const key = (file: string, method: string) => `${file} · ${method}`;
  const recost = new Set(RECOST_PATHS.map(([f, m]) => key(f, m)));
  const bulk = new Set(BULK_EXCEPTIONS.map(([f, m]) => key(f, m)));

  it('los topes con nombre son los de la decisión: 30 s el día, 60 s el recosteo', () => {
    expect(RECOST_TX_OPTIONS).toEqual({ timeout: 60_000, maxWait: 15_000 });
    expect([CLOSE_PREVIEW_TIMEOUT_MS, COMMIT_PREVIEW_TIMEOUT_MS]).toEqual([60_000, 120_000]);
  });

  it('ninguna transacción pasa de 30 s salvo las que recostean (60 s) y las excepciones con nombre', () => {
    const offenders = all
      .filter((t) => t.options !== null && !bulk.has(key(t.file, t.method)))
      .flatMap((t) => {
        const ms = timeoutOf(t.options);
        const max = recost.has(key(t.file, t.method)) ? RECOST_MAX_MS : DAY_MAX_MS;
        return ms !== null && ms <= max ? [] : [`${key(t.file, t.method)} (${t.options ?? ''})`];
      });
    expect(offenders).toEqual([]);
  });

  it('las listas no nombran caminos que ya no existen', () => {
    const present = new Set(all.map((t) => key(t.file, t.method)));
    expect([...recost, ...bulk].filter((k) => !present.has(k))).toEqual([]);
  });
});
