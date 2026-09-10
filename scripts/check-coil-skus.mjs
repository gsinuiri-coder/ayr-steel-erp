// Diagnóstico SOLO LECTURA del SKU de venta directa de bobina (D-037, D-168).
//
// Contesta si algún typeKey de bobina quedó sin su producto de `trading` —lo que la venta
// directa rechaza con "no existe el producto de venta directa"— y si hay productos `BOB…` que
// ninguna bobina nombra, que es lo que la forma vieja del SKU pudo dejar. No migra ni borra
// nada: eso lo decide el dueño mirando la lista.
//
// Uso: node scripts/check-coil-skus.mjs [--branch production|demo|dev|local|local-e2e]
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from './lib.mjs';
import { DB_NAME_DEV, DB_NAME_E2E, dbUrl } from './local-docker-env.mjs';

const BRANCHES = ['production', 'demo', 'dev', 'local', 'local-e2e'];

const argv = process.argv;
const branch = argv.includes('--branch') ? argv[argv.indexOf('--branch') + 1] : 'production';
// `--branch` sin valor deja `undefined` y el error salía desde `neonctl`, pidiendo una rama
// vacía con un mensaje que no nombra el argumento que falta.
if (!BRANCHES.includes(branch)) {
  console.error(`--branch tiene que ser una de: ${BRANCHES.join(', ')}`);
  process.exit(1);
}

// Las dos bases de Docker se resuelven acá y no por `neonctl`, que fallaría pidiendo una rama
// llamada "local". Regla dura 5: la cadena de conexión viaja por el entorno del hijo, jamás
// por argv — un argumento se imprime en el mensaje de error cuando el comando falla (D-128).
const localDb = { local: DB_NAME_DEV, 'local-e2e': DB_NAME_E2E }[branch];
const url = localDb ? dbUrl(localDb) : null;

const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsx', 'prisma/coil-sku-report.ts'],
  {
    cwd: resolve(ROOT, 'apps/api'),
    env: {
      ...process.env,
      DATABASE_URL: url ?? neonConnectionString(branch, { pooled: true }),
      DIRECT_URL: url ?? neonConnectionString(branch, { pooled: false }),
      AYR_BRANCH_LABEL: branch,
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);
process.exit(res.status ?? 1);
