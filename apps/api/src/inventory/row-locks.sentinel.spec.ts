import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * D-386 — centinela de la puerta única de bloqueos de inventario. Mismo patrón que el de la
 * regla dura 8 (`kardex-writers.sentinel.spec.ts`): una lectura del código fuente que falla si
 * aparece un bloqueo de fila (`FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE`)
 * sobre `coils` o `inventory_balances` fuera de los dos lugares permitidos:
 *
 * - `inventory/row-locks.ts` (`lockCoilRows`): la única sentencia que bloquea bobinas, siempre
 *   el conjunto entero en una sola sentencia y por id;
 * - `inventory/inventory.service.ts` (`lockBalance`): el único que bloquea saldos, al que se
 *   llega por `record`/`reverse`/`adjustCost`/`replaceEntry`/`lockAvailability`/`lockInOrder`.
 *
 * Lo que este centinela no puede ver: el orden en que un llamador usa esas puertas (eso lo
 * prueban `lockInOrder` y los db-spec concurrentes de D-386) y los bloqueos implícitos de un
 * `UPDATE` sobre una fila (una escritura de Prisma). Barre lo mismo que el de la regla dura 8.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const SCAN_DIRS = ['apps/api/src', 'apps/api/prisma', 'scripts', 'packages', 'e2e'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-cli', 'migrations', 'coverage']);
const EXTENSIONS = ['.ts', '.mjs', '.js', '.cjs', '.sql'];

/**
 * Un `FROM`/`JOIN` sobre la tabla y, en la misma sentencia (sin cerrar el template ni pasar un
 * `;`), una cláusula de bloqueo. La ventana de 600 caracteres alcanza para cualquier `SELECT …
 * WHERE … ORDER BY …` del repo y no cruza a la sentencia siguiente.
 */
const lockOn = (table: string): RegExp =>
  new RegExp(
    String.raw`\b(FROM|JOIN)\s+"?${table}"?(?![\w])[^\x60;]{0,600}?\bFOR\s+(NO\s+KEY\s+UPDATE|UPDATE|SHARE|KEY\s+SHARE)\b`,
    'i',
  );

const RULES = [
  {
    table: 'coils',
    re: lockOn('coils'),
    allowed: 'apps/api/src/inventory/row-locks.ts',
    mustMatch: /export async function lockCoilRows\(/,
  },
  {
    table: 'inventory_balances',
    re: lockOn('inventory_balances'),
    allowed: 'apps/api/src/inventory/inventory.service.ts',
    mustMatch: /private async lockBalance\(/,
  },
];

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

describe('D-386 — bloqueos de bobinas y saldos solo por la puerta única (centinela)', () => {
  const files = SCAN_DIRS.flatMap((d) => listFiles(join(REPO_ROOT, d)));

  it('barre el repo de verdad (si no encuentra archivos, el centinela no protege nada)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.map(repoPath)).toContain('apps/api/src/inventory/row-locks.ts');
  });

  it('el patrón reconoce las formas que tiene que reconocer (y no las lecturas sin lock)', () => {
    const coils = lockOn('coils');
    const balances = lockOn('inventory_balances');
    expect(
      coils.test('SELECT "id" FROM "coils" WHERE "id" = ANY($1) ORDER BY "id" FOR UPDATE'),
    ).toBe(true);
    expect(coils.test('SELECT id FROM coils WHERE id = $1 FOR NO KEY UPDATE')).toBe(true);
    expect(coils.test('SELECT c.id FROM x JOIN "coils" c ON c.id = x.coil_id FOR SHARE')).toBe(
      true,
    );
    expect(coils.test('SELECT count(*) AS n FROM "coils" WHERE "finish_id" = $1')).toBe(false);
    expect(coils.test('SELECT 1 FROM "coils_x" FOR UPDATE')).toBe(false);
    expect(
      balances.test('SELECT "id" FROM "inventory_balances"\n WHERE "item_id" = $1\n FOR UPDATE'),
    ).toBe(true);
    expect(balances.test('SELECT * FROM "inventory_balances" b JOIN products p ON true')).toBe(
      false,
    );
  });

  it.each(RULES)('ningún FOR UPDATE sobre $table fuera de su puerta', ({ re, allowed }) => {
    const offenders = files
      .map(repoPath)
      .filter((path) => path !== allowed)
      .filter((path) => re.test(readFileSync(join(REPO_ROOT, path), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it.each(RULES)(
    'la puerta de $table sigue existiendo y bloqueando',
    ({ re, allowed, mustMatch }) => {
      const abs = join(REPO_ROOT, allowed);
      expect(existsSync(abs)).toBe(true);
      const source = readFileSync(abs, 'utf8');
      expect(source).toMatch(mustMatch);
      expect(re.test(source)).toBe(true);
    },
  );
});
