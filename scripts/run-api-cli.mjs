// RF-S4b: el arranque común de los CLI de dominio que corren contra una rama (normalización de
// SKU de bobina y barrido de lo importado). Mismo esquema que `import-initial-inventory.mjs`
// (D-206): la credencial de la rama viaja por el entorno del hijo, nunca por argv (regla dura
// 5); dry-run por defecto; `--execute` contra production exige además `--confirm-production`
// (regla dura 5 de AGENTS.md §3); compila con `tsc -p tsconfig.cli.json` porque el CLI levanta
// Nest entero y esbuild no emite bien `emitDecoratorMetadata`.
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString, readEnvFile } from './lib.mjs';
import { localTestDbUrls, LOCAL_ADMIN_EMAIL } from './local-docker-env.mjs';

const NEON_BRANCHES = new Set(['dev', 'demo', 'production']);
const LOCAL_BRANCHES = new Set(['local', 'local-e2e']);

/**
 * @param {object} options
 * @param {string} options.compiled ruta del JS compilado dentro de `apps/api/dist-cli`
 * @param {string} options.what qué escribe el `--execute`, para el mensaje del gate de producción
 * @param {Set<string>} [options.pathFlags] flags cuyo valor es una ruta relativa a quien invoca
 */
export function runApiCli({ compiled, what, pathFlags = new Set() }) {
  const argv = process.argv.slice(2);
  const branch = argv.includes('--branch') ? argv[argv.indexOf('--branch') + 1] : 'local';
  if (!NEON_BRANCHES.has(branch) && !LOCAL_BRANCHES.has(branch)) {
    throw new Error(
      `--branch tiene que ser "dev", "demo", "production", "local" o "local-e2e" (recibido: "${branch}").`,
    );
  }
  if (
    branch === 'production' &&
    argv.includes('--execute') &&
    !argv.includes('--confirm-production')
  ) {
    throw new Error(
      `--execute contra production ${what} — agregá --confirm-production si es justo lo que querés hacer. Sin ese flag, no se ejecuta.`,
    );
  }

  const passthroughArgs = argv
    .filter(
      (a, i) => a !== '--branch' && argv[i - 1] !== '--branch' && a !== '--confirm-production',
    )
    .map((a, i, arr) => (pathFlags.has(arr[i - 1]) ? resolve(process.cwd(), a) : a));

  const apiDir = resolve(ROOT, 'apps/api');
  const localUrls = localTestDbUrls(branch);
  const env = {
    ...process.env,
    DATABASE_URL: localUrls
      ? localUrls.databaseUrl
      : neonConnectionString(branch, { pooled: true }),
    DIRECT_URL: localUrls ? localUrls.directUrl : neonConnectionString(branch, { pooled: false }),
    ADMIN_EMAIL: localUrls
      ? (process.env.ADMIN_EMAIL ?? LOCAL_ADMIN_EMAIL)
      : readEnvFile().ADMIN_EMAIL,
  };
  if (localUrls) console.error(`Base de pruebas: ${branch} (desde el ${localUrls.source})`);

  const build = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsc', '-p', 'tsconfig.cli.json'],
    // La salida del compilador va a stderr: stdout queda para el `--json` del CLI.
    { cwd: apiDir, env, stdio: ['ignore', process.stderr, 'inherit'], shell: true },
  );
  if ((build.status ?? 1) !== 0) process.exit(build.status ?? 1);

  const res = spawnSync('node', [compiled, ...passthroughArgs], {
    cwd: apiDir,
    env,
    stdio: 'inherit',
  });
  process.exit(res.status ?? 1);
}
