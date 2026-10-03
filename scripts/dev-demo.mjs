// Levanta la app local (api + web) contra la rama Neon `demo` (D-125).
//
// No toca `apps/api/.env`: el override de conexión se inyecta por entorno al proceso, así
// que `pnpm dev` sigue apuntando a `dev` y las dos cosas conviven sin pisarse. Si falta
// `.env.demo`, lo genera primero.
//
// Uso: pnpm dev:demo
import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ROOT, readEnvFile } from './lib.mjs';

const demoPath = resolve(ROOT, '.env.demo');
if (!existsSync(demoPath)) {
  const res = spawnSync(process.execPath, [resolve(ROOT, 'scripts/env-demo.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (res.status !== 0) throw new Error('No se pudo generar .env.demo');
}

// `readEnvFile` es el único lector de archivos de entorno del proyecto y nunca imprime
// valores (regla dura 5); acá lee el archivo que esta misma herramienta escribió.
const demo = readEnvFile(demoPath);
const missing = ['DATABASE_URL', 'DIRECT_URL'].filter((k) => !demo[k]);
if (missing.length) {
  throw new Error(`.env.demo está incompleto (falta ${missing.join(', ')}). Corré pnpm env:demo.`);
}

console.log(
  'Levantando api :3100 + web :3101 contra la rama Neon "demo", solo en 127.0.0.1. Ctrl+C para cortar.',
);
const isWin = process.platform === 'win32';
const pnpm = isWin ? 'pnpm.cmd' : 'pnpm';

// Puertos **propios** de demo, nunca 3000/3001: esos son de `pnpm dev:local` y de Playwright,
// que mata y levanta lo que haya ahí. Con los dos compartiendo puertos, una corrida de E2E
// tumbaba la demo del dueño en pleno UAT (2026-10-02), y un E2E que reusara el API de demo
// escribiría sobre una copia de datos reales. 4000/4001 son del dueño (`dev:preview`).
const DEMO_API_PORT = '3100';
const DEMO_WEB_PORT = '3101';
// El override viaja por entorno y gana sobre `apps/api/.env`: NestJS lee `process.env`.
//
// R2/PSE/jobs apagados mientras `demo` sea copia de datos reales (ajustes antes de UAT
// S2, D-227): `apps/api/.env` (heredado de `pnpm env:local`) puede traer el `R2_BUCKET`
// real de producción, y con `PSE_ENABLED`/`JOBS_ENABLED` en `true` el reintento de envío
// al PSE (`invoicing-send.job.ts`) reenviaría al sandbox de Nubefact comprobantes
// pendientes clonados de producción. Ninguno de los dos hace falta para el guion de UAT.
const env = {
  ...process.env,
  ...demo,
  AYR_ENVIRONMENT: 'demo',
  R2_ACCOUNT_ID: '',
  R2_ACCESS_KEY_ID: '',
  R2_SECRET_ACCESS_KEY: '',
  R2_BUCKET: '',
  R2_ENDPOINT: '',
  PSE_ENABLED: 'false',
  JOBS_ENABLED: 'false',
  PORT: DEMO_API_PORT,
  WEB_ORIGIN: `http://127.0.0.1:${DEMO_WEB_PORT}`,
};

// C06: **solo localhost.** Demo es copia de datos reales y sus usuarios conservan el hash de
// producción (riesgo vigente, D-362): con `0.0.0.0`, cualquiera en la red local entraba como
// cualquier usuario real. El API escucha en `BIND_HOST` y el web con `next dev -H`; el web
// habla con el API por `127.0.0.1` para no depender de cómo resuelva `localhost`. Por eso no
// se usa `pnpm run dev` (turbo), que levanta los dos en todas las interfaces.
const shared = spawnSync(pnpm, ['--filter', '@ayr/shared', 'build'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: isWin,
});
if (shared.status !== 0) process.exit(shared.status ?? 1);

const children = [
  spawn(pnpm, ['--filter', '@ayr/api', 'run', 'dev'], {
    cwd: ROOT,
    env: { ...env, BIND_HOST: '127.0.0.1' },
    stdio: 'inherit',
    shell: isWin,
  }),
  spawn(
    pnpm,
    [
      '--filter',
      '@ayr/web',
      'exec',
      'next',
      'dev',
      '--turbopack',
      '-p',
      DEMO_WEB_PORT,
      '-H',
      '127.0.0.1',
    ],
    {
      cwd: ROOT,
      env: { ...env, API_URL: `http://127.0.0.1:${DEMO_API_PORT}` },
      stdio: 'inherit',
      shell: isWin,
    },
  ),
];
// Si uno de los dos se cae, se corta el otro: una demo a medias confunde más de lo que ayuda.
let exiting = false;
for (const child of children) {
  child.on('exit', (code) => {
    if (exiting) return;
    exiting = true;
    for (const other of children) if (other !== child) other.kill();
    process.exit(code ?? 1);
  });
}
