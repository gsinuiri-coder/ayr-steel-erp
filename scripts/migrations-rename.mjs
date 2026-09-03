// Sincroniza `_prisma_migrations.migration_name` en una rama Neon tras renombrar
// una carpeta de migración ya aplicada. Uso:
// node scripts/migrations-rename.mjs --branch production|dev <viejo> <nuevo>
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from './lib.mjs';

const args = process.argv.slice(2);
const branchIdx = args.indexOf('--branch');
const branch = branchIdx !== -1 ? args[branchIdx + 1] : 'production';
const rest = args.filter((_, i) => i !== branchIdx && i !== branchIdx + 1);
const [oldName, newName] = rest;
if (!oldName || !newName) {
  console.error('Uso: node scripts/migrations-rename.mjs --branch production|dev <viejo> <nuevo>');
  process.exit(1);
}

const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsx', 'prisma/migrations-rename.ts', oldName, newName],
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
