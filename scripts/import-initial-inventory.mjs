// CLI de carga de inventario inicial (D-206, excepción única a D-150). Wrapper fino: pone las
// credenciales de la rama en el entorno del proceso hijo (nunca por argv, regla dura 5) y
// delega toda la lógica en `apps/api/prisma/import-initial-inventory-cli.ts`, que reusa
// `CoilsService`/`InventoryService` — el mismo servicio que la recepción de una compra.
//
// Dry-run por defecto (valida y reporta, nunca escribe). `--execute` confirma de verdad, y solo
// si TODAS las filas del archivo pasaron su validación.
//
// Uso:
//   pnpm import:initial-inventory --file "Inventario.xlsx" [--branch dev|demo|production|local|local-e2e]
//   pnpm import:initial-inventory --file "Inventario.xlsx" --execute [--branch local]
//   pnpm import:initial-inventory --file "Inventario.xlsx" --execute --branch production --confirm-production
//
// `--kind coils` (default) carga bobinas; `--kind products` carga productos UPVC/reventa por
// unidades (F8-S6a2) — dos archivos y dos servicios de dominio distintos, mismo wrapper:
//   pnpm import:initial-inventory --file "Productos.xlsx" --kind products [--execute]
//
// `production` es una rama válida (D-206 es exactamente para el arranque real), pero `--execute`
// contra ella exige además `--confirm-production` — sin el flag, aborta con el mensaje de abajo.
// El dry-run **no** lo pide: solo lee el archivo y valida, nunca toca `coils`/`products`/`inventory_movements`.
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString, readEnvFile } from './lib.mjs';
import { DB_NAME_DEV, DB_NAME_E2E, dbUrl, LOCAL_ADMIN_EMAIL } from './local-docker-env.mjs';

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
    '--execute contra production crea bobinas reales y mueve kardex real — agregá ' +
      '--confirm-production si es justo lo que querés hacer. Sin ese flag, no se ejecuta.',
  );
}

// El wrapper solo decide la rama y el gate de producción; el resto de los flags (--file,
// --execute, --operation-date, --actor-email) van al script real, con `--file` resuelto contra
// el directorio **desde el que se invocó este comando** — el script real corre con
// `cwd: apps/api`, así que una ruta relativa se resolvía contra el lugar equivocado.
const PATH_FLAGS = new Set(['--file']);
const passthroughArgs = argv
  .filter((a, i) => a !== '--branch' && argv[i - 1] !== '--branch' && a !== '--confirm-production')
  .map((a, i, arr) => (PATH_FLAGS.has(arr[i - 1]) ? resolve(process.cwd(), a) : a));

const apiDir = resolve(ROOT, 'apps/api');
const localDb = LOCAL_DB_BY_BRANCH[branch];
const env = {
  ...process.env,
  DATABASE_URL: localDb ? dbUrl(localDb) : neonConnectionString(branch, { pooled: true }),
  DIRECT_URL: localDb ? dbUrl(localDb) : neonConnectionString(branch, { pooled: false }),
  // Local: el admin que siembra `pnpm dev:local`/el reset de pruebas. Neon: el que ya declaró
  // `.env.setup` — `readEnvFile` nunca imprime valores (regla dura 5) y esto tampoco los repite.
  ADMIN_EMAIL: localDb ? LOCAL_ADMIN_EMAIL : readEnvFile().ADMIN_EMAIL,
};

// Compila con `tsc` real (`tsconfig.cli.json`), no `tsx`/esbuild: el CLI levanta el árbol de
// dependencias completo de Nest (`NestFactory.createApplicationContext`) para reusar
// `CoilsService` tal cual, y esbuild no emite bien `emitDecoratorMetadata` en ese grafo — sale
// un `UndefinedDependencyException` en tiempo de ejecución, sin ningún aviso al compilar.
const build = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsc', '-p', 'tsconfig.cli.json'],
  {
    cwd: apiDir,
    env,
    stdio: 'inherit',
    shell: true, // pnpm es un .cmd en Windows y spawn sin shell falla con EINVAL
  },
);
if ((build.status ?? 1) !== 0) process.exit(build.status ?? 1);

// Sin `shell: true`: `node` es un binario real (no un shim `.cmd` de Windows), y pasarlo por
// `cmd.exe` es lo que le come el espacio de un nombre de archivo con espacios — sin shell,
// `spawnSync` respeta el array tal cual.
const res = spawnSync(
  'node',
  ['dist-cli/prisma/import-initial-inventory-cli.js', ...passthroughArgs],
  { cwd: apiDir, env, stdio: 'inherit' },
);
process.exit(res.status ?? 1);
