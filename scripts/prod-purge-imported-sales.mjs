// Borra físicamente los comprobantes importados (RF-71) y lo que cuelga de ellos — ver
// `apps/api/prisma/purge-imported-sales.ts` para las guardas y el detalle. Dry-run por
// defecto; `--execute` borra de verdad. Por defecto corre contra `production`, igual que
// `prod-imported-audit.mjs`; `--branch` la cambia (p. ej. para ensayar en `dev`).
//
// Uso: node scripts/prod-purge-imported-sales.mjs [--branch dev] [--execute]
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from './lib.mjs';

const branchArg = process.argv.indexOf('--branch');
const branch = branchArg >= 0 ? process.argv[branchArg + 1] : 'production';
const execute = process.argv.includes('--execute');

console.warn(`Rama de Neon: ${branch}`);

const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsx', 'prisma/purge-imported-sales.ts', ...(execute ? ['--execute'] : [])],
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
