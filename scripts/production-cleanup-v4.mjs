// Wrapper de la limpia total de la ventana V-4 (F8-V4prep). Pone las credenciales de la rama
// en el entorno del proceso hijo (nunca por argv, regla dura 5) y delega toda la lógica en
// `apps/api/prisma/production-cleanup-v4.ts`.
//
// Dry-run por defecto (cuenta y reporta, nunca escribe). `--execute` trunca de verdad.
//
// Uso:
//   pnpm limpia:v4 [--branch dev|demo|production|local|local-e2e]
//   pnpm limpia:v4 --execute [--branch local]
//   pnpm limpia:v4 --execute --branch production --confirm-production
//
// `production` es una rama válida (esta limpia es justo para preparar la carga real), pero
// `--execute` contra ella exige además `--confirm-production` — sin el flag, aborta.
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString, readEnvFile } from './lib.mjs';
import {
  DB_NAME_DEV,
  DB_NAME_E2E,
  LOCAL_ADMIN_EMAIL,
  LOCAL_ADMIN_PASSWORD,
  dbUrl,
} from './local-docker-env.mjs';

const argv = process.argv.slice(2);
const branch = argv.includes('--branch') ? argv[argv.indexOf('--branch') + 1] : 'local';
const NEON_BRANCHES = new Set(['dev', 'demo', 'production']);
const LOCAL_DB_BY_BRANCH = { local: DB_NAME_DEV, 'local-e2e': DB_NAME_E2E };
if (!NEON_BRANCHES.has(branch) && !(branch in LOCAL_DB_BY_BRANCH)) {
  throw new Error(
    `--branch tiene que ser "dev", "demo", "production", "local" o "local-e2e" (recibido: "${branch}").`,
  );
}

const willExecute = argv.includes('--execute');
if (branch === 'production' && willExecute && !argv.includes('--confirm-production')) {
  throw new Error(
    '--execute contra production vacía cotizaciones, pedidos, OPs, comprobantes, compras, ' +
      'bobinas y su kardex — agregá --confirm-production si es justo lo que querés hacer. ' +
      'Sin ese flag, no se ejecuta.',
  );
}

// El wrapper solo decide la rama y el gate de producción; el resto de los flags (--execute) van
// al script real tal cual.
const passthroughArgs = argv.filter(
  (a, i) => a !== '--branch' && argv[i - 1] !== '--branch' && a !== '--confirm-production',
);

const apiDir = resolve(ROOT, 'apps/api');
const localDb = LOCAL_DB_BY_BRANCH[branch];
// El truncate deja `users` intacto, pero el seed que corre al final (`production-cleanup-v4.ts`
// → `pnpm db:seed`) exige ADMIN_EMAIL/ADMIN_PASSWORD en el entorno y, sin esto, `dotenv/config`
// del propio seed cargaría `apps/api/.env` (el admin de desarrollo local) — contra una rama
// Neon eso upsertea por el email equivocado y puede crear un administrador de más en
// producción. Mismo criterio que `db-prod.mjs`/`import-initial-inventory.mjs`: real desde
// `.env.setup` para Neon, el fijo de Docker para local/local-e2e.
const adminCreds = localDb
  ? { ADMIN_EMAIL: LOCAL_ADMIN_EMAIL, ADMIN_PASSWORD: LOCAL_ADMIN_PASSWORD }
  : (() => {
      const setup = readEnvFile();
      return { ADMIN_EMAIL: setup.ADMIN_EMAIL, ADMIN_PASSWORD: setup.ADMIN_PASSWORD };
    })();
const env = {
  ...process.env,
  DATABASE_URL: localDb ? dbUrl(localDb) : neonConnectionString(branch, { pooled: true }),
  DIRECT_URL: localDb ? dbUrl(localDb) : neonConnectionString(branch, { pooled: false }),
  AYR_BRANCH_LABEL: branch,
  ...adminCreds,
  // Defensa redundante (hallazgo de revisión, F8-V4prep): `production-cleanup-v4.ts` también se
  // puede invocar directo con `DATABASE_URL`/`DIRECT_URL` copiadas a mano, sin pasar por este
  // wrapper — ahí el gate de arriba no corre. Esta variable solo se setea acá, justo después de
  // haber exigido `--confirm-production`, así que un `--execute` directo contra production sin
  // este wrapper se sigue negando del otro lado.
  ...(branch === 'production' && willExecute ? { AYR_LIMPIA_V4_CONFIRMED: '1' } : {}),
};

// Sin build con `tsc`: a diferencia del importador de inventario inicial, este script no usa
// `NestFactory.createApplicationContext` (es PrismaClient liso, mismo patrón que
// `reset-test-db.ts`), así que `tsx` alcanza.
const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsx', 'prisma/production-cleanup-v4.ts', ...passthroughArgs],
  {
    cwd: apiDir,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32', // pnpm es un .cmd en Windows y spawn sin shell falla con EINVAL
  },
);
process.exit(res.status ?? 1);
