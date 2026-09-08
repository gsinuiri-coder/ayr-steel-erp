// Borra físicamente los comprobantes importados (RF-71) y lo que cuelga de ellos — ver
// `apps/api/prisma/purge-imported-sales.ts` para las guardas y el detalle. Dry-run por
// defecto; `--execute` borra de verdad. Por defecto corre contra `production`, igual que
// `prod-imported-audit.mjs`; `--branch` la cambia (p. ej. para ensayar en `dev`).
//
// `--batch=<uuid>` (D-142): acota la purga a un solo lote del CLI de importación de ventas
// en vez de a todo `origin = IMPORTED` — ver el comentario de cabecera del script real.
// Con `--batch`, `--execute` contra `production` exige además `--confirm-production` (mismo
// gate que `import-ventas.mjs`); la purga general (sin `--batch`) no lo pedía antes de esta
// sesión y sigue sin pedirlo, para no cambiarle el contrato a una herramienta que ya se usó.
//
// `--exclude-touched` (D-142-ii): con `--batch`, si alguna OP del lote tocó producción real
// alguna vez (bobina montada o reporte de piezas) aunque ya esté revertida, por defecto
// aborta el lote entero — con este flag, excluye del borrado físico al pedido dueño de esa
// OP (y su comprobante) y sigue con el resto. Ver el comentario de cabecera del script real.
//
// Uso: node scripts/prod-purge-imported-sales.mjs [--branch dev] [--batch=<uuid>] [--execute]
//      node scripts/prod-purge-imported-sales.mjs --batch=<uuid> [--exclude-touched] \
//        --execute --confirm-production
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from './lib.mjs';

const branchArg = process.argv.indexOf('--branch');
const branch = branchArg >= 0 ? process.argv[branchArg + 1] : 'production';
const execute = process.argv.includes('--execute');
const batchArg = process.argv.find((a) => a.startsWith('--batch='));
const excludeTouched = process.argv.includes('--exclude-touched');

if (
  batchArg &&
  branch === 'production' &&
  execute &&
  !process.argv.includes('--confirm-production')
) {
  throw new Error(
    '--execute --batch=... contra production borra comprobantes, pedidos, reservas y OP ' +
      'reales — agregá --confirm-production si es justo lo que querés hacer.',
  );
}

console.warn(`Rama de Neon: ${branch}`);

const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  [
    'exec',
    'tsx',
    'prisma/purge-imported-sales.ts',
    ...(execute ? ['--execute'] : []),
    ...(batchArg ? [batchArg] : []),
    ...(excludeTouched ? ['--exclude-touched'] : []),
  ],
  {
    cwd: resolve(ROOT, 'apps/api'),
    env: {
      ...process.env,
      DATABASE_URL: neonConnectionString(branch, { pooled: true }),
      DIRECT_URL: neonConnectionString(branch, { pooled: false }),
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);
process.exit(res.status ?? 1);
