// One-off SOLO LECTURA (2026-09-22): verifica el saldo e inventario valorizado de los tres SKU
// UPVC tras la carga de inventario inicial contra demo.
//
// Uso: node scripts/oneoff/20260922-verify-upvc-balances.mjs --branch demo
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from '../lib.mjs';

const argv = process.argv;
const branch = argv.includes('--branch') ? argv[argv.indexOf('--branch') + 1] : 'demo';

const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsx', 'prisma/oneoff-verify-upvc-balances.ts'],
  {
    cwd: resolve(ROOT, 'apps/api'),
    env: {
      ...process.env,
      DATABASE_URL: neonConnectionString(branch, { pooled: true }),
      DIRECT_URL: neonConnectionString(branch, { pooled: false }),
      AYR_BRANCH_LABEL: branch,
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);
process.exit(res.status ?? 1);
