// Borra una fila de `_prisma_migrations` de un intento fallido (steps=0, sin finished_at).
// Uso: node scripts/migrations-delete-failed.mjs --branch ci <migration_name>
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from './lib.mjs';

const args = process.argv.slice(2);
const branchIdx = args.indexOf('--branch');
const branch = branchIdx !== -1 ? args[branchIdx + 1] : 'production';
const rest = args.filter((_, i) => i !== branchIdx && i !== branchIdx + 1);
const [migrationName] = rest;
if (!migrationName) {
  console.error('Uso: node scripts/migrations-delete-failed.mjs --branch ci <migration_name>');
  process.exit(1);
}

const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsx', 'prisma/migrations-delete-failed.ts', migrationName],
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
