import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Regla dura 8 (AGENTS.md, texto aprobado por el dueño el 2026-10-03, cc15b): todo movimiento
 * de stock pasa por `InventoryService` y solo por sus puertas (`record`, `reverse`,
 * `adjustCost`, `replaceEntry`). Ningún otro código escribe `inventory_movements` ni
 * `inventory_balances`, salvo las excepciones de abajo, cada una con su decisión.
 *
 * Igual que `audit-tx-invariant.spec.ts` (D-222), es una lectura del código fuente: barre el
 * repo entero —no solo el API— y falla si aparece un escritor nuevo. Las excepciones se
 * verifican también en el otro sentido: si un archivo exceptuado desaparece o deja de tener la
 * forma permitida, el test falla, para que la lista no envejezca en silencio.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

/** Dónde se busca. Los specs, las migraciones y lo compilado no son escritores de negocio. */
const SCAN_DIRS = ['apps/api/src', 'apps/api/prisma', 'scripts', 'packages', 'e2e'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-cli', 'migrations', 'coverage']);
const EXTENSIONS = ['.ts', '.mjs', '.js', '.cjs', '.sql'];

// cc57 (A-04 de audit-01): los patrones cubren también `createManyAndReturn`/`updateManyAndReturn`
// (Prisma 5.14+), `UPDATE ONLY`, `DELETE FROM ONLY`, `MERGE INTO` y `TRUNCATE` sin `TABLE`. El SQL
// armado por concatenación (`$executeRawUnsafe`) no se prohíbe: tiene usos legítimos (savepoints de
// los importadores, herramientas de drift) y ninguno nombra el kardex, que los patrones ya ven.
const WRITER_PATTERNS: { name: string; re: RegExp }[] = [
  {
    name: 'Prisma: escritura de inventoryMovement',
    re: /\binventoryMovement\s*\.\s*(create\w*|update\w*|upsert|delete\w*)\s*\(/,
  },
  {
    name: 'Prisma: escritura de inventoryBalance',
    re: /\binventoryBalance\s*\.\s*(create\w*|update\w*|upsert|delete\w*)\s*\(/,
  },
  {
    name: 'SQL: INSERT/UPDATE/DELETE/MERGE sobre las tablas del kardex',
    re: /(INSERT\s+INTO|UPDATE(\s+ONLY)?|DELETE\s+FROM(\s+ONLY)?|MERGE\s+INTO)\s+"?inventory_(movements|balances)"?/i,
  },
  // Un TRUNCATE que arma la lista de tablas al vuelo no nombra las del kardex, pero las vacía:
  // cualquier TRUNCATE cuenta, con o sin `TABLE`.
  { name: 'SQL: TRUNCATE', re: /TRUNCATE\s+(TABLE\s+)?["\w$]/i },
];

interface Exception {
  decision: string;
  what: string;
  /** La forma que el archivo tiene que seguir teniendo para que la excepción valga. */
  mustMatch: RegExp;
}

const EXCEPTIONS = new Map<string, Exception>([
  [
    'apps/api/src/inventory/inventory.service.ts',
    {
      decision: 'regla dura 8',
      what: 'la puerta misma: record, reverse, adjustCost y replaceEntry',
      mustMatch: /async replaceEntry\(/,
    },
  ],
  [
    'apps/api/prisma/reset-test-db.ts',
    {
      decision: 'D-018 (guard D-181)',
      what: 'TRUNCATE de la base de pruebas',
      mustMatch: /TRUNCATE TABLE/,
    },
  ],
  // D-208 (limpia de V-4) ya no es excepción: D-384 retiró `production-cleanup-v4.ts` del repo.
]);

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

describe('regla dura 8 — escritores del kardex (centinela)', () => {
  const files = SCAN_DIRS.flatMap((d) => listFiles(join(REPO_ROOT, d)));

  it('barre el repo de verdad (si no encuentra archivos, el centinela no protege nada)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.map(repoPath)).toContain('apps/api/src/inventory/inventory.service.ts');
  });

  it('solo las puertas de InventoryService y las excepciones nombradas escriben el kardex', () => {
    const offenders: string[] = [];
    for (const abs of files) {
      const path = repoPath(abs);
      if (EXCEPTIONS.has(path)) continue;
      const source = readFileSync(abs, 'utf8');
      for (const { name, re } of WRITER_PATTERNS) {
        if (re.test(source)) offenders.push(`${path}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each([...EXCEPTIONS])(
    'la excepción %s sigue existiendo y con la forma permitida',
    (path, exception) => {
      const abs = join(REPO_ROOT, path);
      expect(existsSync(abs)).toBe(true);
      expect(exception.decision).not.toBe('');
      expect(readFileSync(abs, 'utf8')).toMatch(exception.mustMatch);
    },
  );
});
