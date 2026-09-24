// Qué corre `pnpm db:prod` (D-262): por defecto solo `prisma migrate deploy`. El seed —que hace
// upsert del administrador y deja una fila `seed.admin` en `audit_log`— va detrás de
// `--with-seed`, para que ninguna ventana siembre production sin haberlo pedido.
// Separado de `db-prod.mjs` para poder probarlo sin tocar Neon.

export const MIGRATE_STEP = ['exec', 'prisma', 'migrate', 'deploy'];
export const SEED_STEP = ['exec', 'tsx', 'prisma/seed.ts'];

const KNOWN_FLAGS = new Set(['--with-seed']);

/** Pasos de `pnpm` a correr en `apps/api`. Una bandera desconocida corta antes de leer nada. */
export function dbProdPlan(argv) {
  const unknown = argv.filter((arg) => !KNOWN_FLAGS.has(arg));
  if (unknown.length > 0) {
    throw new Error(
      `Bandera desconocida para db:prod: ${unknown.join(' ')}. Solo acepta --with-seed.`,
    );
  }
  const withSeed = argv.includes('--with-seed');
  return { withSeed, steps: withSeed ? [MIGRATE_STEP, SEED_STEP] : [MIGRATE_STEP] };
}
