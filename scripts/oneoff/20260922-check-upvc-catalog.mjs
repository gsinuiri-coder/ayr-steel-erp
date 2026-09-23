// One-off SOLO LECTURA (2026-09-22): verifica en el catálogo si existen los SKU UPVC36MT,
// UPVC6MT y UPVC36MTAZUL antes del inventario inicial de productos (D-207). No escribe nada.
//
// Uso: node scripts/oneoff/20260922-check-upvc-catalog.mjs --branch demo
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from '../lib.mjs';
import { DB_NAME_DEV, DB_NAME_E2E, dbUrl } from '../local-docker-env.mjs';

const BRANCHES = ['production', 'demo', 'dev', 'local', 'local-e2e'];
const argv = process.argv;
const branch = argv.includes('--branch') ? argv[argv.indexOf('--branch') + 1] : 'demo';
if (!BRANCHES.includes(branch)) {
  console.error(`--branch tiene que ser una de: ${BRANCHES.join(', ')}`);
  process.exit(1);
}

const localDb = { local: DB_NAME_DEV, 'local-e2e': DB_NAME_E2E }[branch];
const url = localDb ? dbUrl(localDb) : null;

const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsx', 'prisma/oneoff-upvc-catalog-report.ts'],
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
