// Dry-run SOLO LECTURA del paso a color comercial en producción y reservas
// (docs/diseno/color-comercial-produccion.md §4). No escribe nada: la lectura corre en una
// transacción READ ONLY. La salida completa queda en local-data/color-comercial/.
//
// Uso: node scripts/color-comercial-dry-run.mjs --branch production|demo|dev|local|local-e2e
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from './lib.mjs';
import { DB_NAME_DEV, DB_NAME_E2E, dbUrl } from './local-docker-env.mjs';

const BRANCHES = ['production', 'demo', 'dev', 'local', 'local-e2e'];

const argv = process.argv;
const branch = argv.includes('--branch') ? argv[argv.indexOf('--branch') + 1] : undefined;
// Sin default: un dry-run contra production tiene que pedirse con nombre.
if (!BRANCHES.includes(branch)) {
  console.error(`--branch es obligatorio y tiene que ser una de: ${BRANCHES.join(', ')}`);
  process.exit(1);
}

// Regla dura 5: la cadena de conexión viaja por el entorno del hijo, jamás por argv.
const localDb = { local: DB_NAME_DEV, 'local-e2e': DB_NAME_E2E }[branch];
const url = localDb ? dbUrl(localDb) : null;

const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsx', 'prisma/color-comercial-dry-run.ts'],
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
