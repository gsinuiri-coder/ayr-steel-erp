// Aplica migraciones pendientes y el seed del administrador en la rama `production` de Neon.
// Solo `prisma migrate deploy` (nunca reset). Uso: pnpm db:prod
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString, readEnvFile } from './lib.mjs';

const setup = readEnvFile();
const env = {
  ...process.env,
  NODE_ENV: 'production',
  DATABASE_URL: neonConnectionString('production', { pooled: true }),
  DIRECT_URL: neonConnectionString('production', { pooled: false }),
  ADMIN_EMAIL: setup.ADMIN_EMAIL,
  ADMIN_PASSWORD: setup.ADMIN_PASSWORD,
};
const apiDir = resolve(ROOT, 'apps/api');
const isWin = process.platform === 'win32';

function pnpm(args) {
  const res = spawnSync(isWin ? 'pnpm.cmd' : 'pnpm', args, {
    cwd: apiDir,
    env,
    stdio: 'inherit',
    shell: isWin,
  });
  if (res.status !== 0) throw new Error(`Falló pnpm ${args.join(' ')}`);
}

pnpm(['exec', 'prisma', 'migrate', 'deploy']);
pnpm(['exec', 'tsx', 'prisma/seed.ts']);
console.log('Producción: migraciones y seed aplicados.');
