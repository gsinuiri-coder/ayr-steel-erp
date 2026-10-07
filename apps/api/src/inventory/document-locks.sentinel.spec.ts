import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DOCUMENT_LOCK_TABLES } from './document-locks';

/**
 * cc30 — centinela de la puerta de documentos (grupo C de D-386). Mismo patrón que
 * `row-locks.sentinel.spec.ts`: una lectura del código fuente que falla si aparece un bloqueo de
 * fila (`FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE`) sobre una tabla de
 * documento fuera de `inventory/document-locks.ts` (`lockDocuments`), que las toma en el orden
 * canónico.
 *
 * Lo que no puede ver: el orden en que un llamador usa la puerta (lo prueban los pares de
 * `lock-order.db-spec.ts` y la puerta misma, que pide con `NOWAIT` lo que llega fuera de orden) y
 * los bloqueos implícitos de un `UPDATE` de Prisma.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const SCAN_DIRS = ['apps/api/src', 'apps/api/prisma', 'scripts', 'packages', 'e2e'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-cli', 'migrations', 'coverage']);
const EXTENSIONS = ['.ts', '.mjs', '.js', '.cjs', '.sql'];
const GATE = 'apps/api/src/inventory/document-locks.ts';

/** Igual que el de bobinas: `FROM`/`JOIN` sobre la tabla y, en la misma sentencia, el bloqueo. */
const lockOn = (table: string): RegExp =>
  new RegExp(
    String.raw`\b(FROM|JOIN)\s+"?${table}"?(?![\w])[^\x60;]{0,600}?\bFOR\s+(NO\s+KEY\s+UPDATE|UPDATE|SHARE|KEY\s+SHARE)\b`,
    'i',
  );

function listFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...listFiles(abs));
    } else if (
      EXTENSIONS.some((ext) => entry.endsWith(ext)) &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.db-spec.ts') &&
      !entry.endsWith('.d.ts')
    ) {
      out.push(abs);
    }
  }
  return out;
}

function repoPath(abs: string): string {
  return relative(REPO_ROOT, abs).split(sep).join('/');
}

describe('cc30 — bloqueos de documentos solo por la puerta (centinela)', () => {
  const files = SCAN_DIRS.flatMap((d) => listFiles(join(REPO_ROOT, d)));
  const tables = Object.values(DOCUMENT_LOCK_TABLES);

  it('barre el repo de verdad y cubre las tablas de la puerta', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.map(repoPath)).toContain(GATE);
    expect(tables).toEqual(
      expect.arrayContaining([
        'fiscal_documents',
        'dispatches',
        'quotations',
        'sales_orders',
        'production_orders',
        'quotation_reservations',
        'reservations',
      ]),
    );
  });

  it('el patrón reconoce las formas que tiene que reconocer (y no las lecturas sin lock)', () => {
    const re = lockOn('sales_orders');
    expect(re.test('SELECT "id" FROM "sales_orders" WHERE "id" = $1 FOR UPDATE')).toBe(true);
    expect(re.test('SELECT id FROM sales_orders WHERE id = $1\n  FOR NO KEY UPDATE')).toBe(true);
    expect(re.test('SELECT "status" FROM "sales_orders" WHERE "id" = $1')).toBe(false);
    expect(re.test('SELECT 1 FROM "sales_orders_x" FOR UPDATE')).toBe(false);
  });

  it.each(Object.values(DOCUMENT_LOCK_TABLES))(
    'ningún FOR UPDATE sobre %s fuera de la puerta',
    (table) => {
      const re = lockOn(table);
      const offenders = files
        .map(repoPath)
        .filter((path) => path !== GATE)
        .filter((path) => re.test(readFileSync(join(REPO_ROOT, path), 'utf8')));
      expect(offenders).toEqual([]);
    },
  );

  it.each(Object.values(DOCUMENT_LOCK_TABLES))('la puerta sigue bloqueando %s', (table) => {
    const source = readFileSync(join(REPO_ROOT, GATE), 'utf8');
    expect(source).toMatch(/export async function lockDocuments\(/);
    expect(lockOn(table).test(source)).toBe(true);
  });
});
