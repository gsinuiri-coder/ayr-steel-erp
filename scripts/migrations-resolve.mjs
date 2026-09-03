// `prisma migrate resolve --rolled-back <nombre>` contra una rama Neon (Sesión M-1).
// Uso: node scripts/migrations-resolve.mjs --branch ci <migration_name>
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from './lib.mjs';

const args = process.argv.slice(2);
const branchIdx = args.indexOf('--branch');
const branch = branchIdx !== -1 ? args[branchIdx + 1] : 'production';
const rest = args.filter((_, i) => i !== branchIdx && i !== branchIdx + 1);
const [migrationName] = rest;
if (!migrationName) {
  console.error('Uso: node scripts/migrations-resolve.mjs --branch ci <migration_name>');
  process.exit(1);
}

const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'prisma', 'migrate', 'resolve', '--rolled-back', migrationName],
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
