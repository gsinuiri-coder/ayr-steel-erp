// Diagnóstico SOLO LECTURA del catálogo de coberturas antes de aplicar D-127 en una rama.
//
// Responde las dos preguntas que la revisión dejó abiertas: cuántos productos de Metallic
// Roofing quedarían bloqueados por las reglas nuevas (subtipo PLANCHA sin largo fijo, o con
// una unidad que el servicio no admite). Si devuelve filas, hay que corregirlas antes de
// desplegar, no después.
//
// Uso: node scripts/check-roofing-catalog.mjs [--branch production|demo|dev|local|local-e2e]
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from './lib.mjs';
import { DB_NAME_DEV, DB_NAME_E2E, dbUrl } from './local-docker-env.mjs';

const argv = process.argv;
const branch = argv.includes('--branch') ? argv[argv.indexOf('--branch') + 1] : 'production';

// Las dos bases de Docker se resuelven acá y no por `neonctl`, que fallaría pidiendo una rama
// llamada "local" con un error que no dice nada de lo que pasó. `local` es la del dueño
// (`pnpm dev:preview`), que es donde aparecieron los largos en metros de D-166.
// Regla dura 5: la cadena de conexión viaja por el entorno del hijo, nunca por argv.
const localDb = { local: DB_NAME_DEV, 'local-e2e': DB_NAME_E2E }[branch];
const url = localDb ? dbUrl(localDb) : null;

const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsx', 'prisma/roofing-catalog-report.ts'],
  {
    cwd: resolve(ROOT, 'apps/api'),
    env: {
      ...process.env,
      DATABASE_URL: url ?? neonConnectionString(branch, { pooled: true }),
      DIRECT_URL: url ?? neonConnectionString(branch, { pooled: false }),
      AYR_BRANCH_LABEL: branch,
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);
process.exit(res.status ?? 1);
