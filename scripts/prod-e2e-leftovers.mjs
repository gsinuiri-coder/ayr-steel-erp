// Inventario de lo que los E2E de escritura dejan en la rama `production` de Neon.
// Solo LECTURA: cuenta y lista entidades con marcas de prueba (`E2E`, `EE`, `BOB`),
// para poder documentarlo tras cada `pnpm e2e:prod` (D-024) y revisarlo a simple vista.
// No imprime credenciales ni datos del negocio real. Uso: node scripts/prod-e2e-leftovers.mjs
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from './lib.mjs';

const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsx', 'prisma/e2e-leftovers.ts'],
  {
    cwd: resolve(ROOT, 'apps/api'),
    env: {
      ...process.env,
      DATABASE_URL: neonConnectionString('production', { pooled: true }),
      DIRECT_URL: neonConnectionString('production', { pooled: false }),
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);
process.exit(res.status ?? 1);
