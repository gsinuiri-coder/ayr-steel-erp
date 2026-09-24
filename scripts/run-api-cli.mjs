// RF-S4b: el arranque común de los CLI de dominio que corren contra una rama (normalización de
// SKU de bobina y barrido de lo importado). Mismo esquema que `import-initial-inventory.mjs`
// (D-206): la credencial de la rama viaja por el entorno del hijo, nunca por argv (regla dura
// 5); dry-run por defecto; `--execute` contra production exige además `--confirm-production`
// (regla dura 5 de AGENTS.md §3); compila con `tsc -p tsconfig.cli.json` porque el CLI levanta
// Nest entero y esbuild no emite bien `emitDecoratorMetadata`.
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ROOT, neonConnectionString, readEnvFile } from './lib.mjs';
import { localTestDbUrls, LOCAL_ADMIN_EMAIL } from './local-docker-env.mjs';

/**
 * Revisión cruzada RF-S4b (P1-2): la CLI levanta la aplicación entera (`AppModule`), y con ella
 * todo lo que arranca solo: la cola (pg-boss), el reintento de envíos al PSE —que al arrancar
 * barre los pendientes— y el cliente de R2. Heredados de `apps/api/.env`, que puede traer la
 * configuración de otra rama, eso actuaba sobre la base de la CLI sin que nadie lo pidiera.
 * Van **después** de `process.env`, así ninguna variable del entorno los vuelve a encender, y
 * vacías (no ausentes) para que `dotenv` no las complete desde el archivo.
 *
 * Sin R2, la cotización que el barrido corrige no puede regenerar su PDF: queda sin `pdfKey` y
 * la descarga lo arma al vuelo con los datos vigentes (decisión 1 del dueño).
 */
export const EXTERNAL_OUTPUTS_OFF = Object.freeze({
  JOBS_ENABLED: 'false',
  PSE_ENABLED: 'false',
  R2_ACCOUNT_ID: '',
  R2_ACCESS_KEY_ID: '',
  R2_SECRET_ACCESS_KEY: '',
  R2_BUCKET: '',
  R2_ENDPOINT: '',
  // Cerradura extra sobre el PSE: sin credenciales, aunque algo lo llamara no tendría a quién.
  NUBEFACT_URL: '',
  NUBEFACT_TOKEN: '',
});

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
  // Repaso de RF-S4b (P1-B): contra production no corre nada sin la confirmación, ni el
  // dry-run. La CLI lo vuelve a comprobar por dentro (`src/common/cli-branch-gate.ts`).
  if (branch === 'production' && !argv.includes('--confirm-production')) {
    throw new Error(
      argv.includes('--execute')
        ? `--execute contra production ${what} — agregá --confirm-production si es justo lo que querés hacer. Sin ese flag, no se ejecuta.`
        : 'Contra production la CLI no corre sin --confirm-production, tampoco en dry-run.',
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
    // El gate de producción vive también **dentro** de la CLI (autorrevisión RF-S4b): el JS
    // compilado se niega a `--execute` si no sabe la rama o si es production sin confirmar, así
    // que correrlo a mano con un DATABASE_URL no se salta este wrapper.
    AYR_CLI_BRANCH: branch,
    AYR_CLI_CONFIRMED_PRODUCTION: argv.includes('--confirm-production') ? '1' : '0',
    DATABASE_URL: localUrls
      ? localUrls.databaseUrl
      : neonConnectionString(branch, { pooled: true }),
    DIRECT_URL: localUrls ? localUrls.directUrl : neonConnectionString(branch, { pooled: false }),
    ADMIN_EMAIL: localUrls
      ? (process.env.ADMIN_EMAIL ?? LOCAL_ADMIN_EMAIL)
      : readEnvFile().ADMIN_EMAIL,
    ...EXTERNAL_OUTPUTS_OFF,
    // `AppModule` valida el entorno y exige `JWT_SECRET`, pero la CLI no emite ni verifica
    // tokens: uno al azar por corrida, nunca el de la rama. Sin esto, contra Neon la CLI moría
    // en silencio al arrancar (lo mostró el ensayo en demo de RF-S4b).
    JWT_SECRET: randomBytes(32).toString('hex'),
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
