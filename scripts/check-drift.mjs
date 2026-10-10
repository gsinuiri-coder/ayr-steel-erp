// cc42 (D-593): guardián del drift de schema. Crea una base VACÍA en el Postgres local (Docker en
// la máquina, el servicio del runner en CI), le aplica todas las migraciones con `migrate deploy`
// y compara `prisma migrate diff` (base → schema.prisma, en SQL) contra la lista aprobada
// `apps/api/prisma/drift-esperado.sql`. Si aparece una diferencia que no está en la lista, o
// desaparece una que sí estaba, falla con el detalle.
//
// Solo toca la base `ayr_drift_check` en localhost: nunca Neon, nunca `ayr_local` ni las de E2E.
// La URL viaja por el entorno del hijo (regla dura 2), nunca por argv.
//
// Uso: pnpm check:drift            → compara
//      pnpm check:drift --write    → reescribe la lista aprobada (solo con una D-nnn que lo diga)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, run } from './lib.mjs';
import { dbUrl } from './local-docker-env.mjs';

export const DRIFT_DB_NAME = 'ayr_drift_check';
export const EXPECTED_PATH = resolve(ROOT, 'apps/api/prisma/drift-esperado.sql');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * La URL de la base descartable. En GitHub Actions sale del `DATABASE_URL` del job (el Postgres
 * de servicio); en la máquina, del Docker de `local-docker-env.mjs`. En los dos casos se cambia
 * solo el nombre de la base, y el host tiene que ser local.
 */
export function driftDbUrl(env = process.env) {
  const base =
    env.GITHUB_ACTIONS === 'true' && env.DATABASE_URL ? env.DATABASE_URL : dbUrl(DRIFT_DB_NAME);
  const url = new URL(base);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`check:drift solo corre contra un Postgres local (host ${url.hostname}).`);
  }
  url.pathname = `/${DRIFT_DB_NAME}`;
  return url.toString();
}

/** La misma URL apuntada a la base de mantenimiento `postgres`, para crear y borrar. */
export function maintenanceUrl(url) {
  const u = new URL(url);
  u.pathname = '/postgres';
  u.search = '';
  return u.toString();
}

/** Encabezado de la lista aprobada; las líneas `-- #` son notas y no cuentan como diferencia. */
export const EXPECTED_HEADER = [
  '-- # Diferencias APROBADAS entre una base creada desde cero con las migraciones y schema.prisma',
  '-- # (SQL de `prisma migrate diff` base → schema). Las clasifica docs/analisis/drift-schema.md.',
  '-- # Solo se reescribe con `pnpm check:drift --write` y una D-nnn que apruebe la diferencia.',
].join('\n');

/**
 * Normaliza la salida de `migrate diff --script`: fin de línea, espacios al final, líneas en
 * blanco, notas `-- #` y el aviso «This is an empty migration.» que Prisma imprime cuando no hay
 * nada.
 */
export function normalizeDiff(sql) {
  return sql
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(
      (line) =>
        line !== '' && line !== '-- This is an empty migration.' && !line.startsWith('-- #'),
    )
    .join('\n');
}

/** Sentencias SQL (cada una con su comentario previo) para listar qué sobra y qué falta. */
export function statements(normalized) {
  if (normalized === '') return [];
  return normalized
    .split(/;\n?/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export function compareDrift(expectedSql, actualSql) {
  const expected = statements(normalizeDiff(expectedSql));
  const actual = statements(normalizeDiff(actualSql));
  const added = actual.filter((s) => !expected.includes(s));
  const missing = expected.filter((s) => !actual.includes(s));
  return { ok: added.length === 0 && missing.length === 0, added, missing };
}

function apiRequire() {
  return createRequire(resolve(ROOT, 'apps/api/package.json'));
}

async function admin(url, sql) {
  const { PrismaClient } = apiRequire()('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: maintenanceUrl(url) } } });
  try {
    for (const statement of sql) await prisma.$executeRawUnsafe(statement);
  } finally {
    await prisma.$disconnect();
  }
}

/** Base nueva con todas las migraciones y el SQL que la llevaría a `schema.prisma`. */
export async function freshDiff(env = process.env) {
  const url = driftDbUrl(env);
  const dbEnv = { DATABASE_URL: url, DIRECT_URL: url };
  const apiDir = resolve(ROOT, 'apps/api');
  await admin(url, [
    `DROP DATABASE IF EXISTS "${DRIFT_DB_NAME}" WITH (FORCE)`,
    `CREATE DATABASE "${DRIFT_DB_NAME}"`,
  ]);
  try {
    run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: apiDir, env: dbEnv });
    return run(
      'pnpm',
      [
        'exec',
        'prisma',
        'migrate',
        'diff',
        '--from-schema-datasource',
        'prisma/schema.prisma',
        '--to-schema-datamodel',
        'prisma/schema.prisma',
        '--script',
      ],
      { cwd: apiDir, env: dbEnv },
    );
  } finally {
    await admin(url, [`DROP DATABASE IF EXISTS "${DRIFT_DB_NAME}" WITH (FORCE)`]);
  }
}

async function main() {
  const actual = await freshDiff();
  if (process.argv.includes('--write')) {
    writeFileSync(EXPECTED_PATH, `${EXPECTED_HEADER}\n${normalizeDiff(actual)}\n`);
    console.log(`Lista aprobada reescrita: ${EXPECTED_PATH}`);
    return;
  }
  const expected = existsSync(EXPECTED_PATH) ? readFileSync(EXPECTED_PATH, 'utf8') : '';
  const { ok, added, missing } = compareDrift(expected, actual);
  if (ok) {
    console.log(
      `check:drift ok: la base creada desde cero difiere de schema.prisma solo en lo aprobado ` +
        `(${String(statements(normalizeDiff(expected)).length)} sentencias).`,
    );
    return;
  }
  console.error(
    'check:drift FALLÓ: schema.prisma y las migraciones no cuadran con la lista aprobada.',
  );
  for (const s of added) console.error(`\n+ Diferencia nueva (no aprobada):\n${s}`);
  for (const s of missing) console.error(`\n- Diferencia aprobada que ya no aparece:\n${s}`);
  console.error(
    '\nUna diferencia nueva casi siempre es un cambio de schema.prisma sin su migración (o al ' +
      'revés). Corrígelo; si es de las que Prisma no puede expresar, clasifícala en ' +
      'docs/analisis/drift-schema.md y reescribe la lista con `pnpm check:drift --write`.',
  );
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
