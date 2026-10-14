import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import { KARDEX_TX_OPTIONS } from './transaction-options';

/**
 * cc53 (hotfix) — **el tope de las transacciones que tocan kardex.** Registrar una NC de devolución
 * (D-646) daba 500 contra Neon porque su transacción usaba los 5 s por defecto de Prisma. Este
 * centinela fija:
 *
 * 1. los caminos corregidos en el hotfix usan `KARDEX_TX_OPTIONS`;
 * 2. toda transacción interactiva cuyo cuerpo llama al kardex (`inventory.record/reverse/adjustCost/
 *    replaceEntry/recostForward`), a una devolución (`salesReturns.…InTx`) o a un despacho
 *    (`dispatches.…InTx`) lleva un tope propio de al menos 30 s.
 */
const SRC = join(__dirname, '..');
const MIN_TIMEOUT_MS = 30_000;
const KNOWN: Record<string, number> = {
  KARDEX_TX_OPTIONS: KARDEX_TX_OPTIONS.timeout,
  REACTIVATION_TX_TIMEOUT_MS: 30_000,
  COMMIT_PREVIEW_TIMEOUT_MS: 30_000,
};
const KARDEX_CALL =
  /this\.(inventory\.(record|reverse|adjustCost|replaceEntry|recostForward)|salesReturns\.[a-zA-Z]+InTx|dispatches\.[a-zA-Z]+InTx)\(/;

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
  const named = /timeout:\s*([A-Z_]+)/.exec(options);
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
    const offenders = all
      .filter((t) => KARDEX_CALL.test(t.body))
      .filter((t) => (timeoutOf(t.options) ?? 0) < MIN_TIMEOUT_MS)
      .map((t) => `${t.file} · ${t.method} (${t.options ?? 'sin opciones'})`);
    expect(offenders).toEqual([]);
  });

  it('timeoutOf lee las formas del repo', () => {
    expect(timeoutOf(null)).toBeNull();
    expect(timeoutOf('KARDEX_TX_OPTIONS')).toBe(30_000);
    expect(timeoutOf('{ timeout: 120_000 }')).toBe(120_000);
    expect(timeoutOf('{ timeout: REACTIVATION_TX_TIMEOUT_MS }')).toBe(30_000);
    expect(timeoutOf('{ timeout: 30 * 60_000 }')).toBe(1_800_000);
  });
});
