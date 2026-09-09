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

/**
 * Ejecuta un comando y devuelve stdout. En Windows resuelve .cmd (gcloud, vercel, neonctl).
 *
 * `inherit: true` deja la salida del hijo en la terminal en vivo y devuelve `''`: es para los
 * comandos largos y ruidosos —`docker compose up --wait`, `prisma migrate deploy`— donde el
 * silencio de varios minutos parece un cuelgue. El mensaje de error sigue siendo el mismo, y
 * sigue **sin repetir** los argumentos sensibles (regla dura 5, D-128), que es la razón por la
 * que un script no debe escribirse su propio `run`.
 *
 * `cwd` por defecto es la raíz del repo (regla dura 8: los comandos se corren desde la raíz).
 * Los pocos que necesitan otra —`prisma`, que busca su schema relativo— la piden explícita;
 * hasta que existió esta opción, pasarla se ignoraba en silencio.
 */
export function run(
  cmd,
  args,
  { input, env, cwd = ROOT, allowFail = false, quiet = false, inherit = false } = {},
) {
  const isWin = process.platform === 'win32';
  const res = spawnSync(
    isWin ? 'cmd.exe' : cmd,
    isWin ? ['/d', '/s', '/c', [cmd, ...args].map(q).join(' ')] : args,
    {
      cwd,
      input,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
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
