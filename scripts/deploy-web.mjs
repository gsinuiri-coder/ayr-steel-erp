// Despliega apps/web a Vercel con build remoto (el build local falla en Windows por symlinks).
// 1) Asegura el proyecto y su rootDirectory=apps/web (API REST con el token del CLI).
// 2) Variables de entorno (API_URL). 3) `vercel deploy --prod` desde la raíz del monorepo.
// Uso: pnpm deploy:web --api-url https://<cloud-run-url>
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ROOT, run } from './lib.mjs';

const PROJECT = 'ayr-steel-erp-web';
const idx = process.argv.indexOf('--api-url');
const apiUrl = idx > -1 ? process.argv[idx + 1] : process.env.API_URL;
if (!apiUrl) throw new Error('Falta --api-url');

const vercel = (args, opts = {}) => run('vercel', ['--cwd', ROOT, ...args], opts);

/** Token del CLI de Vercel (nunca se imprime). */
function cliToken() {
  const candidates = [
    resolve(process.env.APPDATA ?? '', 'xdg.data/com.vercel.cli/auth.json'),
    resolve(homedir(), '.local/share/com.vercel.cli/auth.json'),
    resolve(homedir(), 'Library/Application Support/com.vercel.cli/auth.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const token = JSON.parse(readFileSync(p, 'utf8')).token;
      if (token) return token;
    }
  }
  throw new Error('No se encontró el token del CLI de Vercel; ejecuta `vercel login`');
}

async function api(path, init = {}) {
  const res = await fetch(`https://api.vercel.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cliToken()}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(`Vercel API ${path}: ${res.status} ${JSON.stringify(body.error ?? body)}`);
  return body;
}

// 1) Proyecto + rootDirectory.
let project = await api(`/v9/projects/${PROJECT}`).catch(() => null);
if (!project) {
  project = await api('/v11/projects', {
    method: 'POST',
    body: JSON.stringify({ name: PROJECT, framework: 'nextjs', rootDirectory: 'apps/web' }),
  });
  console.log(`Proyecto ${PROJECT} creado`);
}
if (project.rootDirectory !== 'apps/web' || project.framework !== 'nextjs') {
  await api(`/v9/projects/${PROJECT}`, {
    method: 'PATCH',
    body: JSON.stringify({ rootDirectory: 'apps/web', framework: 'nextjs' }),
  });
  console.log('rootDirectory=apps/web configurado');
}

// 2) Link del monorepo (escribe .vercel/repo.json en la raíz) y variables de entorno.
vercel(['link', '--repo', '--yes'], { quiet: true });
const webCwd = resolve(ROOT, 'apps/web');
const vercelWeb = (args, opts = {}) => run('vercel', ['--cwd', webCwd, ...args], opts);
if (!existsSync(resolve(webCwd, '.vercel/project.json'))) {
  vercelWeb(['link', '--yes', '--project', PROJECT], { quiet: true });
}
for (const target of ['production', 'preview']) {
  vercelWeb(['env', 'rm', 'API_URL', target, '--yes'], { allowFail: true, quiet: true });
  vercelWeb(['env', 'add', 'API_URL', target], { input: apiUrl, quiet: true });
}
console.log(`API_URL=${apiUrl} en production y preview`);

// 3) Deploy de producción con build remoto desde la raíz (Vercel usa rootDirectory).
const out = vercel(['deploy', '--prod', '--yes']);
const url = out
  .trim()
  .split(/\s+/)
  .filter((s) => s.startsWith('https://'))
  .map((s) => s.replace(/["',)]+$/, ''))
  .pop();
console.log(`Web desplegado: ${url ?? out.trim()}`);
