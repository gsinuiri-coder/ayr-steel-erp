// Inventario de go-live, SOLO LECTURA (D-129): qué hay en una rama que no debería existir el
// día que el cliente empieza a trabajar. Más ancho que `prod-e2e-leftovers`, que solo mira el
// prefijo `E2E`: acá entran también los ensayos hechos a mano, que no llevan ningún prefijo.
//
// Ninguna credencial viaja por argv (regla dura 5, D-128).
//
// Uso: node scripts/go-live-inventory.mjs [--branch production|demo|dev]
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from './lib.mjs';

const argv = process.argv;
const branch = argv.includes('--branch') ? argv[argv.indexOf('--branch') + 1] : 'production';

const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsx', 'prisma/go-live-inventory.ts'],
  {
    cwd: resolve(ROOT, 'apps/api'),
    env: {
      ...process.env,
      DATABASE_URL: neonConnectionString(branch, { pooled: true }),
      DIRECT_URL: neonConnectionString(branch, { pooled: false }),
      AYR_BRANCH_LABEL: branch,
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);
process.exit(res.status ?? 1);
