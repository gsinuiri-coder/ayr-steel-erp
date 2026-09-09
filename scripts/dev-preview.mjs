// Segundo api+web contra el MISMO Postgres local que "pnpm dev:local" (ayr_local), en los
// puertos **del dueño**: api :4000, web :4001. Sirve para mirar la app en el navegador sin
// tocar los procesos del agente, que vive en :3000/:3001 junto con Playwright.
//
// Comparte base con dev-local.mjs a propósito: es la misma data, no una copia. `migrate
// deploy` y el seed son idempotentes (ver prisma/seed.ts), así que correr los dos pares de
// procesos a la vez contra la misma base es seguro.
//
// **Nunca contra `ayr_local_e2e`**: esa base la vacía cada corrida de Playwright, así que un
// navegador apuntado ahí muestra datos que desaparecen a mitad de sesión. Por eso el nombre
// de la base es `DB_NAME_DEV` y no un parámetro.
//
// Uso: pnpm dev:preview
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, run } from './lib.mjs';
import {
  DB_NAME_DEV,
  LOCAL_ADMIN_EMAIL,
  LOCAL_ADMIN_PASSWORD,
  LOCAL_JWT_SECRET,
  LOCAL_VIEWER_EMAIL,
  LOCAL_VIEWER_PASSWORD,
  dbUrl,
} from './local-docker-env.mjs';

const apiDir = resolve(ROOT, 'apps/api');
const webDir = resolve(ROOT, 'apps/web');

const API_PORT = 4000;
const WEB_PORT = 4001;

console.log('1/4 Levantando Postgres local (docker compose)…');
// `run` de lib.mjs y no un helper propio: el suyo compone el mensaje de error con
// `args.join(' ')`, que es la forma exacta que la regla dura 5 nombra como el escape de
// D-128 —un argumento que aparece impreso cuando el comando falla—. Hoy no viaja ninguna
// credencial por `argv` acá, y precisamente por eso se cierra ahora y no el día que sí.
run('docker', ['compose', 'up', '-d', '--wait', 'db'], { inherit: true });

const sharedEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: dbUrl(DB_NAME_DEV),
  DIRECT_URL: dbUrl(DB_NAME_DEV),
  JWT_SECRET: LOCAL_JWT_SECRET,
  ADMIN_EMAIL: LOCAL_ADMIN_EMAIL,
  ADMIN_PASSWORD: LOCAL_ADMIN_PASSWORD,
  AYR_ENVIRONMENT: 'local-docker-preview',
};

console.log('2/4 Migraciones + seed (misma base que "pnpm dev:local": ayr_local)…');
run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
  cwd: apiDir,
  env: sharedEnv,
  inherit: true,
});
run('pnpm', ['exec', 'tsx', 'prisma/seed.ts'], { cwd: apiDir, env: sharedEnv, inherit: true });

// Cuenta propia de esta vista, distinta de admin@ayr.local (ver local-docker-env.mjs): su
// contraseña se reafirma en cada arranque, así el login de :4001 nunca depende de si alguien
// cambió la del admin compartido desde el flujo de cambio obligatorio (RF-03).
console.log('3/4 Reafirmando el usuario de esta vista (no toca admin@ayr.local)…');
run('pnpm', ['exec', 'tsx', 'prisma/seed-view.ts'], {
  cwd: apiDir,
  env: { ...sharedEnv, VIEWER_EMAIL: LOCAL_VIEWER_EMAIL, VIEWER_PASSWORD: LOCAL_VIEWER_PASSWORD },
  inherit: true,
});

console.log(
  `4/4 Levantando api :${String(API_PORT)} + web :${String(WEB_PORT)} contra ayr_local. ` +
    `Entra con ${LOCAL_VIEWER_EMAIL}; la contraseña está en scripts/local-docker-env.mjs. ` +
    'Ctrl+C para cortar.',
);

const isWin = process.platform === 'win32';
const pnpmCmd = isWin ? 'pnpm.cmd' : 'pnpm';
const childEnv = { ...process.env, ...sharedEnv };

// `child_process.spawn` (async, a diferencia de `spawnSync`) no resuelve `.cmd` en Windows
// sin `shell: true` — mismo ajuste que dev-demo.mjs. Los args van igual en array: pnpm/cmd
// los arma sin reinterpretarlos.
const apiProc = spawn(pnpmCmd, ['exec', 'nest', 'start', '--watch'], {
  cwd: apiDir,
  env: { ...childEnv, PORT: String(API_PORT), WEB_ORIGIN: `http://localhost:${String(WEB_PORT)}` },
  stdio: 'inherit',
  shell: isWin,
});
const webProc = spawn(pnpmCmd, ['exec', 'next', 'dev', '--turbopack', '-p', String(WEB_PORT)], {
  cwd: webDir,
  env: { ...childEnv, API_URL: `http://localhost:${String(API_PORT)}` },
  stdio: 'inherit',
  shell: isWin,
});

let exiting = false;
function shutdown(code) {
  if (exiting) return;
  exiting = true;
  apiProc.kill();
  webProc.kill();
  process.exit(code ?? 0);
}

apiProc.on('exit', (code) => shutdown(code ?? 1));
webProc.on('exit', (code) => shutdown(code ?? 1));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
