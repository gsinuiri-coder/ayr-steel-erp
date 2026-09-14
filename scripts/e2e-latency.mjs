// Corre la suite E2E contra el Postgres local **a través del proxy de latencia** y con builds
// de producción, para comparar commits en condiciones parecidas a CI (F8-R1).
//
// Por qué no `pnpm e2e` a secas:
//   - Docker responde en ~0 ms: una regresión de round-trips no se ve (ver latency-proxy.mjs).
//   - `pnpm e2e` levanta `next dev` sobre `apps/web/.next`, la misma carpeta que usa
//     `pnpm dev:preview` del dueño en :4001 (regla dura 15). Acá se usa `next start` desde un
//     **worktree** propio, así cada commit tiene su build y nada toca el repo principal.
//   - El pool se limita a 5 conexiones (`connection_limit=5`), el que Prisma calcula para el
//     runner de GitHub (2 vCPU). En la máquina local el pool por defecto es mucho más grande y
//     tapa cualquier contención de conexiones.
//
// Requisitos:
//   1. `node scripts/latency-proxy.mjs --listen 5435 --delay 1 --stats-port 5499` corriendo.
//   2. El worktree con `pnpm install` y los builds hechos (shared, api, web).
//   3. :3000 y :3001 libres (Playwright reusa lo que encuentre ahí).
//
// Uso: node scripts/e2e-latency.mjs --worktree ../wt-x --out local-data/r1/x.jsonl [-- <args de playwright>]
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  DB_NAME_E2E,
  LOCAL_ADMIN_EMAIL,
  LOCAL_ADMIN_PASSWORD,
  LOCAL_JWT_SECRET,
  dbUrl,
} from './local-docker-env.mjs';
import { ROOT } from './lib.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const worktree = resolve(ROOT, arg('worktree') ?? '.');
const out = resolve(ROOT, arg('out') ?? 'local-data/r1/roundtrips.jsonl');
const proxyPort = arg('proxy-port') ?? '5435';
const passthrough = process.argv.includes('--')
  ? process.argv.slice(process.argv.indexOf('--') + 1)
  : [];
mkdirSync(dirname(out), { recursive: true });
const isWin = process.platform === 'win32';

const viaProxy = `${dbUrl(DB_NAME_E2E).replace(/:\d+\//, `:${proxyPort}/`)}&connection_limit=5`;
const env = {
  ...process.env,
  DATABASE_URL: viaProxy,
  DIRECT_URL: viaProxy,
  JWT_SECRET: LOCAL_JWT_SECRET,
  ADMIN_EMAIL: LOCAL_ADMIN_EMAIL,
  ADMIN_PASSWORD: LOCAL_ADMIN_PASSWORD,
  E2E_RESET_DB: '1',
};

async function waitFor(url, label) {
  for (let i = 0; i < 180; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* todavía no */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label} no respondió en ${url}`);
}

for (const [port, label] of [
  ['3000', 'api'],
  ['3001', 'web'],
]) {
  const busy = await fetch(`http://localhost:${port}/`).then(
    () => true,
    () => false,
  );
  if (busy) throw new Error(`:${port} ya está ocupado; Playwright reusaría ese ${label}`);
}

// La base se recrea vacía: dos commits con distinto esquema no pueden compartirla (el reset de
// la suite solo vacía tablas y migra hacia adelante; un commit viejo correría sobre el esquema
// nuevo). Es "ayr_local_e2e", que es de la suite y se vacía en cada corrida igual.
const recreate = spawnSync(
  'docker',
  [
    'exec',
    'ayr-local-db',
    'psql',
    '-U',
    'ayr',
    '-d',
    'postgres',
    '-c',
    `DROP DATABASE IF EXISTS ${DB_NAME_E2E} WITH (FORCE)`,
    '-c',
    `CREATE DATABASE ${DB_NAME_E2E}`,
  ],
  { stdio: 'inherit' },
);
if (recreate.status !== 0) throw new Error(`No se pudo recrear ${DB_NAME_E2E}`);
const migrate = spawnSync(isWin ? 'pnpm.cmd' : 'pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
  cwd: resolve(worktree, 'apps/api'),
  env,
  stdio: ['ignore', 'ignore', 'inherit'],
  shell: isWin,
});
if (migrate.status !== 0) throw new Error('Falló prisma migrate deploy en el worktree');

const children = [];
function start(cmd, args, extraEnv) {
  const child = spawn(cmd, args, {
    cwd: worktree,
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: isWin,
  });
  children.push(child);
  return child;
}
function stopAll() {
  for (const c of children) {
    if (isWin) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
}
process.on('exit', stopAll);
process.on('SIGINT', () => process.exit(130));

// Primero la base: el API se conecta al arrancar y el reset lo hace el global-setup.
start('node', ['apps/api/dist/main.js'], {
  PORT: '3000',
  WEB_ORIGIN: 'http://localhost:3001',
  JOBS_ENABLED: 'false',
  THROTTLE_DISABLED: 'true',
  APIS_NET_PE_BASE_URL: 'http://127.0.0.1:3002',
  APIS_NET_PE_TOKEN: 'e2e-padron-stub',
});
start('pnpm', ['--filter', '@ayr/web', 'start'], { API_URL: 'http://localhost:3000' });
await waitFor('http://localhost:3000/health', 'api');
await waitFor('http://localhost:3001/login', 'web');

const started = Date.now();
const res = spawnSync(
  isWin ? 'pnpm.cmd' : 'pnpm',
  [
    'exec',
    'playwright',
    'test',
    `--reporter=list,${resolve(ROOT, 'scripts/e2e-roundtrips-reporter.mjs').replace(/\\/g, '/')}`,
    ...passthrough,
  ],
  {
    cwd: worktree,
    env: { ...env, E2E_ROUNDTRIPS_OUT: out },
    stdio: 'inherit',
    shell: isWin,
  },
);
console.log(`Suite terminada en ${((Date.now() - started) / 60000).toFixed(1)} min → ${out}`);
process.exit(res.status ?? 1);
