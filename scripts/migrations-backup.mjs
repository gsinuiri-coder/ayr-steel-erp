// Backup SOLO LECTURA de `_prisma_migrations` a docs/backup/ antes de tocar el historial.
// Uso: node scripts/migrations-backup.mjs --branch production|dev
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from './lib.mjs';

const branch = process.argv.includes('--branch')
  ? process.argv[process.argv.indexOf('--branch') + 1]
  : 'production';

const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsx', 'prisma/migrations-backup.ts'],
  {
    cwd: resolve(ROOT, 'apps/api'),
    env: {
      ...process.env,
      DATABASE_URL: neonConnectionString(branch, { pooled: true }),
      DIRECT_URL: neonConnectionString(branch, { pooled: false }),
    },
    encoding: 'utf8',
    shell: process.platform === 'win32',
  },
);
if (res.status !== 0) {
  console.error(res.stderr);
  process.exit(res.status ?? 1);
}

const outDir = resolve(ROOT, 'docs/backup');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = resolve(outDir, `prisma-migrations-${branch}-${stamp}.json`);
writeFileSync(outPath, res.stdout);
console.log(`Backup escrito: ${outPath}`);
