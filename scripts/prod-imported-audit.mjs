// Auditoría de solo LECTURA de los comprobantes importados (RF-71) en la rama `production`
// de Neon. No escribe nada: lista qué hay, cuáles llevan marca de prueba y cuánto saldo
// vivo sostienen. Uso: node scripts/prod-imported-audit.mjs [--branch dev]
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from './lib.mjs';

const branchArg = process.argv.indexOf('--branch');
const branch = branchArg >= 0 ? process.argv[branchArg + 1] : 'production';

console.warn(`Rama de Neon: ${branch}`);

const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsx', 'prisma/imported-audit.ts'],
  {
    cwd: resolve(ROOT, 'apps/api'),
    env: {
      ...process.env,
      DATABASE_URL: neonConnectionString(branch, { pooled: true }),
      DIRECT_URL: neonConnectionString(branch, { pooled: false }),
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);
process.exit(res.status ?? 1);
