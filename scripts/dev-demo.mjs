// Levanta la app local (api + web) contra la rama Neon `demo` (D-125).
//
// No toca `apps/api/.env`: el override de conexión se inyecta por entorno al proceso, así
// que `pnpm dev` sigue apuntando a `dev` y las dos cosas conviven sin pisarse. Si falta
// `.env.demo`, lo genera primero.
//
// Uso: pnpm dev:demo
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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

console.log('Levantando api+web contra la rama Neon "demo". Ctrl+C para cortar.');
const isWin = process.platform === 'win32';
const res = spawnSync(isWin ? 'pnpm.cmd' : 'pnpm', ['run', 'dev'], {
  cwd: ROOT,
  // El override viaja por entorno y gana sobre `apps/api/.env`: NestJS lee `process.env`.
  env: { ...process.env, ...demo, AYR_ENVIRONMENT: 'demo' },
  stdio: 'inherit',
  shell: isWin,
});
process.exit(res.status ?? 1);
