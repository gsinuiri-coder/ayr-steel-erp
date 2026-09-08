// CLI de importación de ventas (D-142). Wrapper fino: pone las credenciales de la rama de
// Neon en el entorno del proceso hijo (nunca por argv, regla dura 5) y delega toda la lógica
// en `apps/api/prisma/import-ventas-cli.ts`, que reusa `ImportsService`/`SalesHistoryImportAdapter`
// — el mismo servicio del botón «Importar ventas (Excel)» de `/comprobantes`.
//
// Dry-run por defecto (solo lectura de negocio — sube el archivo y valida, nunca confirma).
// `--execute` aplica el archivo de decisiones y confirma de verdad.
//
// Uso:
//   pnpm import:ventas --file "Ventas.xlsx" [--branch dev|demo|production] [--out reporte.json]
//   pnpm import:ventas --file "Ventas.xlsx" --decisions decisiones.json --execute [--branch demo]
//   pnpm import:ventas --file "Ventas.xlsx" --decisions decisiones.json --execute \
//     --branch production --confirm-production
//
// `production` es una rama válida (el dueño decidió correr esto contra sus datos reales,
// no un ensayo), pero `--execute` contra ella exige además `--confirm-production` — sin el
// flag, aborta con el mensaje de abajo. El dry-run **no** lo pide: solo sube el archivo y
// valida, nunca toca `sales_orders`/`fiscal_documents`/`reservations`/`production_orders`.
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from './lib.mjs';

const argv = process.argv.slice(2);
const branch = argv.includes('--branch') ? argv[argv.indexOf('--branch') + 1] : 'dev';
if (branch !== 'dev' && branch !== 'demo' && branch !== 'production') {
  throw new Error(`--branch tiene que ser "dev", "demo" o "production" (recibido: "${branch}").`);
}
const willExecute = argv.includes('--execute');
if (branch === 'production' && willExecute && !argv.includes('--confirm-production')) {
  throw new Error(
    '--execute contra production crea comprobantes, pedidos, reservas y OP reales — agregá ' +
      '--confirm-production si es justo lo que querés hacer. Sin ese flag, no se ejecuta.',
  );
}
// El wrapper solo necesita decidir la rama; el resto de los flags (--file, --decisions,
// --execute, --out) van al script real, con las tres rutas resueltas contra el directorio
// **desde el que se invocó este comando** — el script real corre con `cwd: apps/api`, así
// que una ruta relativa como "Ventas.xlsx" (relativa a la raíz del repo) se resolvía contra
// el lugar equivocado y el archivo "no existía". `--confirm-production` es un gate de este
// wrapper, no un flag que el script real conozca — no se reenvía.
const PATH_FLAGS = new Set(['--file', '--decisions', '--out']);
const passthroughArgs = argv
  .filter((a, i) => a !== '--branch' && argv[i - 1] !== '--branch' && a !== '--confirm-production')
  .map((a, i, arr) => (PATH_FLAGS.has(arr[i - 1]) ? resolve(process.cwd(), a) : a));

const apiDir = resolve(ROOT, 'apps/api');
const env = {
  ...process.env,
  DATABASE_URL: neonConnectionString(branch, { pooled: true }),
  DIRECT_URL: neonConnectionString(branch, { pooled: false }),
};

// Compila con `tsc` real (`tsconfig.cli.json`), no `tsx`/esbuild: el CLI levanta el árbol de
// dependencias completo de Nest (`NestFactory.createApplicationContext`) para reusar
// `ImportsService` tal cual, y esbuild no emite bien `emitDecoratorMetadata` en ese grafo —
// sale un `UndefinedDependencyException` en tiempo de ejecución, sin ningún aviso al compilar.
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
// `cmd.exe` es lo que le comía el espacio de "Ventas Detalladas.xlsx" — `--file` le llegaba
// partido en dos argumentos. Sin shell, `spawnSync` respeta el array tal cual.
const res = spawnSync('node', ['dist-cli/prisma/import-ventas-cli.js', ...passthroughArgs], {
  cwd: apiDir,
  env,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
