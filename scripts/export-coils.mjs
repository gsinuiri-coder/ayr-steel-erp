// Exporta a xlsx las bobinas actuales de una rama (SOLO LECTURA). Wrapper fino: pone las
// credenciales en el entorno del proceso hijo (nunca por argv, regla dura 5) y delega la
// consulta en `apps/api/prisma/export-coils-report.ts`, que corre con `tsx` (sin build: no
// necesita el árbol de Nest, solo Prisma).
//
// Uso:
//   pnpm export:coils --branch production --out local-data/bobinas-produccion.xlsx
//   pnpm export:coils --branch demo   (sin --out, escribe a local-data/bobinas-<rama>-<fecha>.xlsx)
//
// El orden de las filas es PEPS (la bobina más antigua primero), no alfabético por código.
import { resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from './lib.mjs';
import { DB_NAME_DEV, DB_NAME_E2E, dbUrl } from './local-docker-env.mjs';

const BRANCHES = ['production', 'demo', 'dev', 'local', 'local-e2e'];

const argv = process.argv.slice(2);
const branch = argv.includes('--branch') ? argv[argv.indexOf('--branch') + 1] : 'production';
if (!BRANCHES.includes(branch)) {
  console.error(`--branch tiene que ser una de: ${BRANCHES.join(', ')}`);
  process.exit(1);
}

// Regla dura 13: dato real de cliente nunca suelto en la raíz — siempre bajo local-data/
// (ignorada por completo). Una ruta explícita fuera de local-data/ se rechaza acá mismo.
const today = new Date().toISOString().slice(0, 10);
const outArg = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;
const outPath = resolve(ROOT, outArg ?? `local-data/bobinas-${branch}-${today}.xlsx`);
if (!outPath.startsWith(resolve(ROOT, 'local-data') + sep)) {
  console.error('--out tiene que apuntar dentro de local-data/ (regla dura 13).');
  process.exit(1);
}

const localDb = { local: DB_NAME_DEV, 'local-e2e': DB_NAME_E2E }[branch];
const url = localDb ? dbUrl(localDb) : null;

const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsx', 'prisma/export-coils-report.ts', outPath],
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
