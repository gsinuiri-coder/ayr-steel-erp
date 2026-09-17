// `prisma migrate diff` SOLO LECTURA contra una rama Neon (base real) vs. schema.prisma local.
// Uso: node scripts/migrations-diff.mjs --branch production
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from './lib.mjs';

const branch = process.argv.includes('--branch')
  ? process.argv[process.argv.indexOf('--branch') + 1]
  : 'production';

const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  [
    'exec',
    'prisma',
    'migrate',
    'diff',
    '--from-schema-datasource',
    'prisma/schema.prisma',
    '--to-schema-datamodel',
    'prisma/schema.prisma',
  ],
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
