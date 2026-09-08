// Levanta Postgres local (Docker) y luego api+web contra localhost: entorno de desarrollo
// que no depende de Neon ni de `.env.setup` (nueva sesión, entorno local completo).
//
// No toca `apps/api/.env` (Neon `dev`): el override de conexión viaja por entorno al proceso
// hijo, igual que `dev-demo.mjs` (D-125), así que `pnpm dev` sigue disponible en paralelo y
// las dos cosas conviven sin pisarse.
//
// Uso: pnpm dev:local
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib.mjs';
import {
  DB_NAME_DEV,
  LOCAL_ADMIN_EMAIL,
  LOCAL_ADMIN_PASSWORD,
  LOCAL_JWT_SECRET,
  dbUrl,
} from './local-docker-env.mjs';

const apiDir = resolve(ROOT, 'apps/api');

// Sin `shell: true`: con args en array, Node lo advierte como inseguro desde la 18.x (no
// escapa los argumentos) y no hace falta — spawnSync ya resuelve `docker`/`pnpm` por PATHEXT
// en Windows sin pasar por cmd.exe.
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (res.status !== 0) throw new Error(`Falló: ${cmd} ${args.join(' ')} (código ${res.status})`);
}

console.log('1/3 Levantando Postgres local (docker compose)…');
run('docker', ['compose', 'up', '-d', '--wait', 'db']);

const env = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: dbUrl(DB_NAME_DEV),
  DIRECT_URL: dbUrl(DB_NAME_DEV),
  JWT_SECRET: LOCAL_JWT_SECRET,
  WEB_ORIGIN: 'http://localhost:3001',
  ADMIN_EMAIL: LOCAL_ADMIN_EMAIL,
  ADMIN_PASSWORD: LOCAL_ADMIN_PASSWORD,
  AYR_ENVIRONMENT: 'local-docker',
};

console.log('2/3 Migraciones + seed…');
run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: apiDir, env });
run('pnpm', ['exec', 'tsx', 'prisma/seed.ts'], { cwd: apiDir, env });

console.log('3/3 Levantando api+web contra Postgres local. Ctrl+C para cortar.');
const res = spawnSync('pnpm', ['run', 'dev'], { cwd: ROOT, env, stdio: 'inherit' });
process.exit(res.status ?? 1);
