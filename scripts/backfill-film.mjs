// D-328: wrapper seguro del backfill del film de protección de las bobinas. Credenciales siempre
// por entorno (regla dura 5: nunca por argv); dry-run por defecto.
//
// Uso:
//   pnpm backfill:film [--branch local|local-e2e|dev|demo|ensayo-*|production]
//   pnpm backfill:film --branch ensayo-corr04b-20260926 --execute
//   pnpm backfill:film --branch production --execute --confirm-production
//
// Sin `--execute` el script solo lee y reporta: el dry-run contra `production` está permitido
// porque no escribe una sola fila, y deja la lista completa en
// `local-data/corr04b/film-dry-run-<rama>.txt` para que el dueño la revise. `--execute` contra
// `production` exige además `--confirm-production` — sin ese flag aborta — y, por AGENTS.md §3.3,
// la aprobación explícita del dueño después de ver esa lista.
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from './lib.mjs';
import { localTestDbUrls } from './local-docker-env.mjs';

const argv = process.argv.slice(2);
const branch = argv.includes('--branch') ? argv[argv.indexOf('--branch') + 1] : 'local';
if (!branch || branch.startsWith('--')) {
  throw new Error('--branch necesita un nombre de rama (ej. --branch ensayo-corr04b-20260926).');
}

const willExecute = argv.includes('--execute');
if (branch === 'production' && willExecute && !argv.includes('--confirm-production')) {
  throw new Error(
    '--execute contra production escribe eventos de film sobre las bobinas reales — ' +
      'agregá --confirm-production si es justo lo que querés hacer. Sin ese flag, no se ' +
      'ejecuta. El dry-run (sin --execute) no lo pide: no escribe nada.',
  );
}

const childArgs = argv.filter(
  (arg, index) =>
    arg !== '--branch' && argv[index - 1] !== '--branch' && arg !== '--confirm-production',
);

// `local`/`local-e2e` resuelven contra el Docker local o el Postgres de servicio del runner
// (D-202); cualquier otro nombre es una rama de Neon y la cadena la arma `neonConnectionString`,
// que la entrega por el entorno del hijo y nunca la imprime.
const localUrls = localTestDbUrls(branch);
const env = {
  ...process.env,
  DATABASE_URL: localUrls ? localUrls.databaseUrl : neonConnectionString(branch, { pooled: true }),
  DIRECT_URL: localUrls ? localUrls.directUrl : neonConnectionString(branch, { pooled: false }),
  AYR_BRANCH_LABEL: branch,
};
if (localUrls) console.log(`Base de pruebas: ${branch} (desde el ${localUrls.source})`);

const result = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsx', 'prisma/backfill-film.ts', ...childArgs],
  {
    cwd: resolve(ROOT, 'apps/api'),
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);
process.exit(result.status ?? 1);
