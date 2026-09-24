// Aplica las migraciones pendientes en la rama `production` de Neon. Solo `prisma migrate
// deploy` (nunca reset). El seed del administrador corre únicamente con `--with-seed` (D-262).
// Uso: pnpm db:prod [--with-seed]
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dbProdPlan } from './db-prod-plan.mjs';
import { ROOT, neonConnectionString, readEnvFile } from './lib.mjs';

let plan;
try {
  plan = dbProdPlan(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const env = {
  ...process.env,
  NODE_ENV: 'production',
  DATABASE_URL: neonConnectionString('production', { pooled: true }),
  DIRECT_URL: neonConnectionString('production', { pooled: false }),
};
if (plan.withSeed) {
  // Las credenciales del admin solo viajan al hijo cuando hay seed que las use.
  const setup = readEnvFile();
  env.ADMIN_EMAIL = setup.ADMIN_EMAIL;
  env.ADMIN_PASSWORD = setup.ADMIN_PASSWORD;
}
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

for (const step of plan.steps) pnpm(step);
console.log(
  plan.withSeed
    ? 'Producción: migraciones y seed aplicados.'
    : 'Producción: migraciones aplicadas (sin seed; usar --with-seed para sembrar).',
);
