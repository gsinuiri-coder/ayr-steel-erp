// cc46 (D-610, D-611): CHECK, triggers, funciones, índices parciales o de expresión y vistas de
// `production` contra los que dejan las migraciones. `prisma migrate diff` (`check:drift`, D-593)
// no ve estos objetos: una restricción o un trigger que alguien creó o cambió a mano en producción
// pasaba sin que nada lo dijera.
//
// - Referencia: una base VACÍA `ayr_drift_objetos` en un contenedor `postgres:<major>-alpine`
//   descartable (la misma versión mayor que production), con todas las migraciones aplicadas
//   (`migrate deploy`); el contenedor se borra al terminar.
// - Producción: **solo el catálogo** (`pg_constraint`, `pg_trigger`, `pg_proc`, `pg_index`,
//   `pg_views` con `pg_get_*def`), dentro de una transacción `READ ONLY`. Nunca tablas del negocio.
//   La cadena de conexión sale de `neonConnectionString` (neonctl en silencio) y viaja dentro del
//   proceso, nunca por argv ni impresa (reglas duras 2 y 3 de AGENTS.md).
// - Compara por nombre y por definición normalizada (espacios, mayúsculas, comillas). Deja fuera lo
//   que pertenece a extensiones y lo que no está en el esquema `public` (Neon, catálogos).
// - Exige la misma versión mayor de Postgres en los dos lados.
// - Un trigger deshabilitado, una CHECK `NOT VALID` y un índice inválido cuentan como distintos.
//   Lo que difiere solo en mayúsculas, comillas o espacios se marca como cosmético, no se oculta.
// - No cubre (D-610): vistas materializadas, reglas que no son de vista, políticas RLS, triggers
//   de evento, enums, defaults, permisos ni dueños. Defaults y columnas los ve `check:drift`.
// - Contenedor `ayr-drift-objetos` en 127.0.0.1:5441, nombre fijo: no se corre en dos sesiones a la
//   vez. Si se corta con Ctrl+C, queda arriba y la corrida siguiente lo borra al empezar.
//
// Solo informe: no corrige nada ni escribe migraciones. No va en la CI; se corre a mano.
//
// Uso: pnpm check:drift:objetos [--out local-data/<archivo>.json]
//      (el JSON lleva nombres y definiciones de esquema, nunca filas de datos)
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, neonConnectionString, run } from './lib.mjs';

export const OBJECTS_DB_NAME = 'ayr_drift_objetos';

/**
 * Objetos que no son de una extensión (`pg_depend.deptype = 'e'`). Se filtra también por
 * `classid`: los OID no son únicos entre catálogos (revisión cc46).
 */
const NOT_FROM_EXTENSION = (oid, catalog) =>
  `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${catalog}'::regclass ` +
  `AND d.objid = ${oid} AND d.deptype = 'e')`;

export const CATALOG_QUERIES = Object.freeze({
  // CHECK y exclusión: Prisma no los modela. (PK, UNIQUE, FK y NOT NULL ya los mira
  // `check:drift`.) Una CHECK de dominio no tiene tabla: se nombra por su tipo.
  constraint: `
    SELECT COALESCE(NULLIF(c.conrelid, 0)::regclass::text, 'dominio ' || c.contypid::regtype::text)
             AS "table",
           c.conname AS "name",
           pg_get_constraintdef(c.oid) || CASE WHEN c.convalidated THEN '' ELSE ' NOT VALID' END
             AS "def"
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public' AND c.contype IN ('c', 'x')
      AND ${NOT_FROM_EXTENSION('c.oid', 'pg_constraint')}`,
  // `pg_get_triggerdef` no dice si está deshabilitado: un `DISABLE TRIGGER` a mano pasaba igual.
  trigger: `
    SELECT t.tgrelid::regclass::text AS "table", t.tgname AS "name",
           pg_get_triggerdef(t.oid) || ' -- tgenabled=' || t.tgenabled::text AS "def"
    FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
      AND ${NOT_FROM_EXTENSION('t.oid', 'pg_trigger')}`,
  // Los agregados no tienen `pg_get_functiondef`; se nombran con su firma por si hay sobrecargas.
  function: `
    SELECT '' AS "table",
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS "name",
           pg_get_functiondef(p.oid) AS "def"
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
      AND ${NOT_FROM_EXTENSION('p.oid', 'pg_proc')}`,
  // Solo los índices que Prisma no ve del todo: parciales (WHERE) o de expresión. Un índice
  // inválido (un CREATE INDEX CONCURRENTLY que falló) tiene la misma definición: se marca.
  index: `
    SELECT i.indrelid::regclass::text AS "table", ic.relname AS "name",
           pg_get_indexdef(i.indexrelid) || CASE WHEN i.indisvalid THEN '' ELSE ' -- INVALID' END
             AS "def"
    FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = ic.relnamespace
    WHERE n.nspname = 'public' AND (i.indpred IS NOT NULL OR i.indexprs IS NOT NULL)
      AND ${NOT_FROM_EXTENSION('i.indexrelid', 'pg_class')}`,
  view: `
    SELECT '' AS "table", v.viewname AS "name", pg_get_viewdef(c.oid) AS "def"
    FROM pg_views v JOIN pg_class c ON c.relname = v.viewname
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = v.schemaname
    WHERE v.schemaname = 'public' AND ${NOT_FROM_EXTENSION('c.oid', 'pg_class')}`,
});

/**
 * Definición comparable. Con la misma versión mayor, `pg_get_*def` devuelve texto canónico: solo
 * se quitan fin de línea CRLF y espacios al final de línea (los cuerpos de función son el texto
 * de la migración tal cual). Nada de minúsculas ni comillas: `'ACTIVE'` y `'Active'` son reglas
 * distintas (revisión cc46).
 */
export function normalizeDef(def) {
  return String(def)
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/** Lo que solo cambia en mayúsculas, comillas o espacios: se informa como cosmético, no se oculta. */
export function looseDef(def) {
  return String(def).replaceAll('"', '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Clave estable de un objeto: clase, tabla y nombre. */
export function objectKey(kind, row) {
  return row.table ? `${kind} ${row.table}.${row.name}` : `${kind} ${row.name}`;
}

/** `{ kind: rows[] }` → `Map<clave, { kind, table, name, def }>`. Una clave repetida corta. */
export function indexCatalog(catalog) {
  const map = new Map();
  for (const [kind, rows] of Object.entries(catalog)) {
    for (const row of rows) {
      const key = objectKey(kind, row);
      if (map.has(key)) throw new Error(`Clave repetida en el catálogo: ${key}`);
      map.set(key, { kind, ...row });
    }
  }
  return map;
}

/**
 * Las diferencias entre la referencia (migraciones) y producción: lo que solo está en un lado y lo
 * que está en los dos con otra definición. Una diferencia de solo mayúsculas, comillas o espacios
 * va marcada `cosmetic` (D-611), pero se informa igual. Cada lista va ordenada por clave.
 */
export function compareCatalogs(reference, production) {
  const ref = indexCatalog(reference);
  const prod = indexCatalog(production);
  const onlyProduction = [...prod.keys()].filter((k) => !ref.has(k)).sort();
  const onlyReference = [...ref.keys()].filter((k) => !prod.has(k)).sort();
  const changed = [...ref.keys()]
    .filter((k) => prod.has(k))
    .filter((k) => normalizeDef(ref.get(k).def) !== normalizeDef(prod.get(k).def))
    .sort()
    .map((k) => ({
      key: k,
      cosmetic: looseDef(ref.get(k).def) === looseDef(prod.get(k).def),
      reference: ref.get(k).def,
      production: prod.get(k).def,
    }));
  const counts = {};
  for (const kind of Object.keys(CATALOG_QUERIES)) {
    counts[kind] = {
      reference: (reference[kind] ?? []).length,
      production: (production[kind] ?? []).length,
    };
  }
  return {
    ok: onlyProduction.length === 0 && onlyReference.length === 0 && changed.length === 0,
    counts,
    onlyProduction,
    onlyReference,
    changed,
  };
}

/** Major de `server_version_num` (170004 → 17). */
export function majorOf(versionNum) {
  return Math.floor(Number(versionNum) / 10000);
}

function apiRequire() {
  return createRequire(resolve(ROOT, 'apps/api/package.json'));
}

/** Lee el catálogo en una transacción `READ ONLY`. La URL nunca se imprime. */
export async function readCatalog(url) {
  const { PrismaClient } = apiRequire()('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe('SET LOCAL search_path = public');
        const [{ v, ro }] = await tx.$queryRawUnsafe(
          "SELECT current_setting('server_version_num') AS v, current_setting('transaction_read_only') AS ro",
        );
        if (ro !== 'on') throw new Error('La transacción del catálogo no quedó READ ONLY.');
        const catalog = {};
        for (const [kind, sql] of Object.entries(CATALOG_QUERIES)) {
          catalog[kind] = (await tx.$queryRawUnsafe(sql)).map((r) => ({
            table: r.table,
            name: r.name,
            def: r.def,
          }));
        }
        return { major: majorOf(v), catalog };
      },
      // `maxWait`: una compute de Neon suspendida tarda en dar la primera conexión.
      { maxWait: 30_000, timeout: 120_000 },
    );
  } finally {
    await prisma.$disconnect();
  }
}

/** Contenedor descartable de la referencia: solo en 127.0.0.1, sin contraseña (`trust`). */
export const REFERENCE_CONTAINER = 'ayr-drift-objetos';
export const REFERENCE_PORT = 5441;

export function referenceUrl(port = REFERENCE_PORT) {
  return `postgresql://ayr@127.0.0.1:${String(port)}/${OBJECTS_DB_NAME}?schema=public`;
}

function waitMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Base vacía con todas las migraciones, en un Postgres de la **misma versión mayor** que
 * production (`postgres:<major>-alpine`), leída y borrada con su contenedor. El Docker del repo
 * (`ayr-local-db`) no sirve de referencia si su versión no coincide.
 */
export async function referenceCatalog(major) {
  run('docker', ['rm', '-f', REFERENCE_CONTAINER], { allowFail: true, quiet: true });
  run(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--name',
      REFERENCE_CONTAINER,
      '-e',
      'POSTGRES_USER=ayr',
      '-e',
      `POSTGRES_DB=${OBJECTS_DB_NAME}`,
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-p',
      `127.0.0.1:${String(REFERENCE_PORT)}:5432`,
      `postgres:${String(major)}-alpine`,
    ],
    { quiet: true },
  );
  try {
    for (let i = 0; ; i += 1) {
      // Por TCP (`-h 127.0.0.1`): el servidor temporal del `initdb` de la imagen solo escucha por
      // el socket y contesta antes de reiniciarse; el definitivo es el que abre TCP.
      const ready = run(
        'docker',
        [
          'exec',
          REFERENCE_CONTAINER,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-p',
          '5432',
          '-U',
          'ayr',
          '-d',
          OBJECTS_DB_NAME,
        ],
        { allowFail: true, quiet: true },
      );
      if (ready.includes('accepting connections')) break;
      if (i >= 60) throw new Error('El Postgres de referencia no arrancó en 60 s.');
      waitMs(1000);
    }
    const url = referenceUrl();
    // La URL de referencia es local y sin contraseña: si `migrate deploy` falla, se muestra.
    run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: resolve(ROOT, 'apps/api'),
      env: { DATABASE_URL: url, DIRECT_URL: url },
    });
    return await readCatalog(url);
  } finally {
    run('docker', ['rm', '-f', REFERENCE_CONTAINER], { allowFail: true, quiet: true });
  }
}

function printReport(result, majors) {
  console.log(
    `Postgres ${String(majors.reference)} (referencia) y ${String(majors.production)} (production)`,
  );
  console.log('\n| Clase | Referencia | production |\n|---|---|---|');
  for (const [kind, c] of Object.entries(result.counts)) {
    console.log(`| ${kind} | ${String(c.reference)} | ${String(c.production)} |`);
  }
  for (const k of result.onlyProduction) console.log(`\n+ Solo en production: ${k}`);
  for (const k of result.onlyReference) console.log(`\n- Solo en las migraciones: ${k}`);
  for (const c of result.changed) {
    console.log(
      `\n~ Distinta${c.cosmetic ? ' (solo mayúsculas, comillas o espacios)' : ''}: ${c.key}` +
        `\n  migraciones: ${c.reference}\n  production:  ${c.production}`,
    );
  }
  console.log(
    result.ok
      ? '\ncheck:drift:objetos ok: production tiene los mismos objetos que las migraciones.'
      : '\ncheck:drift:objetos: hay diferencias; clasifícalas (REAL, esperada o cosmética).',
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : undefined;
  if (argv.includes('--out') && (out === undefined || out.startsWith('--'))) {
    throw new Error('--out necesita la ruta del archivo (sugerida: local-data/…).');
  }
  const production = await readCatalog(neonConnectionString('production', { pooled: false }));
  const reference = await referenceCatalog(production.major);
  if (reference.major !== production.major) {
    throw new Error(
      `Versión mayor distinta: referencia ${String(reference.major)}, production ${String(production.major)}.`,
    );
  }
  const result = compareCatalogs(reference.catalog, production.catalog);
  printReport(result, { reference: reference.major, production: production.major });
  if (out) {
    writeFileSync(
      resolve(process.cwd(), out),
      `${JSON.stringify({ takenAt: new Date().toISOString(), major: production.major, ...result }, null, 2)}\n`,
    );
  }
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
