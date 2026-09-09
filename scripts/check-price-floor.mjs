// Diagnóstico SOLO LECTURA: qué SKU activos tienen su precio de lista por debajo del piso
// duro de D-163 (`costo promedio ÷ (1 − margen mínimo)`).
//
// Es el número que falta para decidir si el mostrador lleva aviso de mínimo en el carrito:
// D-163 dejó el POS exento a propósito, y ponerle el piso sin medir antes cuántos SKU quedan
// por debajo rompe ventas que hoy funcionan (el cajero lo descubriría al cobrar, con el
// cliente delante). No escribe nada y no toca el POS.
//
// Uso: node scripts/check-price-floor.mjs [--branch production|demo|dev|local|local-e2e]
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from './lib.mjs';
import { DB_NAME_DEV, DB_NAME_E2E, dbUrl } from './local-docker-env.mjs';

const argv = process.argv;
const branch = argv.includes('--branch') ? argv[argv.indexOf('--branch') + 1] : 'production';

// Las dos bases de Docker se resuelven acá y no por `neonctl`: pedirle una rama llamada
// "local" fallaría con un error que no dice nada de lo que de verdad pasó. `local-e2e` es la
// base que llena la suite de Playwright, y existe como opción para poder **probar este mismo
// guion contra datos reales** —con catálogo, costos y márgenes— sin tocar producción; es de
// solo lectura, así que se puede correr incluso con la suite en curso.
// Regla dura 5: la cadena de conexión viaja por el entorno del proceso hijo, nunca por argv.
const localDb = { local: DB_NAME_DEV, 'local-e2e': DB_NAME_E2E }[branch];
const url = localDb ? dbUrl(localDb) : null;

const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsx', 'prisma/price-floor-report.ts'],
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
