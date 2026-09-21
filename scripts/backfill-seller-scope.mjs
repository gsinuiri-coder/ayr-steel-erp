// RF-S3c: wrapper seguro. Credenciales siempre por entorno; dry-run por defecto.
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from './lib.mjs';

const args = process.argv.slice(2);
const branch = args.includes('--branch') ? args[args.indexOf('--branch') + 1] : 'local';
if (branch === 'production') {
  throw new Error(
    'Este backfill no se ejecuta contra production desde la sesión; ensayar en la rama clon.',
  );
}
const childArgs = args.filter((arg, index) => arg !== '--branch' && args[index - 1] !== '--branch');
const env = {
  ...process.env,
  ...(branch === 'local'
    ? {}
    : {
        DATABASE_URL: neonConnectionString(branch, { pooled: true }),
        DIRECT_URL: neonConnectionString(branch, { pooled: false }),
      }),
  AYR_BRANCH_LABEL: branch,
};
const result = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsx', 'prisma/backfill-seller-scope.ts', ...childArgs],
  {
    cwd: resolve(ROOT, 'apps/api'),
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);
process.exit(result.status ?? 1);
