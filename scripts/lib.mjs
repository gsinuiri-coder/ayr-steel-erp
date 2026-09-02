// Utilidades compartidas por los scripts de operación. Sin bash-isms (D-014).
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const NEON_PROJECT_ID = 'frosty-cherry-97873994';
export const GCP_REGION = 'us-central1';
export const API_SERVICE = 'ayr-steel-erp-api';

/** Lee .env.setup (o el archivo indicado) a un objeto. NUNCA imprime valores. */
export function readEnvFile(path = resolve(ROOT, '.env.setup')) {
  if (!existsSync(path)) throw new Error(`No existe ${path}`);
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

/** Ejecuta un comando y devuelve stdout. En Windows resuelve .cmd (gcloud, vercel, neonctl). */
export function run(cmd, args, { input, env, allowFail = false, quiet = false } = {}) {
  const isWin = process.platform === 'win32';
  const res = spawnSync(
    isWin ? 'cmd.exe' : cmd,
    isWin ? ['/d', '/s', '/c', [cmd, ...args].map(q).join(' ')] : args,
    {
      cwd: ROOT,
      input,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (res.status !== 0 && !allowFail) {
    if (!quiet) console.error(res.stderr || res.stdout);
    throw new Error(
      `Falló: ${cmd} ${args.filter((a) => !/secret|password|token/i.test(a)).join(' ')} (código ${res.status})`,
    );
  }
  return res.stdout ?? '';
}

function q(a) {
  return /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

/** Cadena de conexión de una rama Neon (pooled o directa). */
export function neonConnectionString(branch, { pooled }) {
  const args = [
    'connection-string',
    branch,
    '--project-id',
    NEON_PROJECT_ID,
    '--database-name',
    'neondb',
    '--role-name',
    'neondb_owner',
  ];
  if (pooled) args.push('--pooled');
  return run('neonctl', args, { quiet: true }).trim();
}
