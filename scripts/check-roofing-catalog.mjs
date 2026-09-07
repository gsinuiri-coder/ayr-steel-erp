// Diagnóstico SOLO LECTURA del catálogo de coberturas antes de aplicar D-127 en una rama.
//
// Responde las dos preguntas que la revisión dejó abiertas: cuántos productos de Metallic
// Roofing quedarían bloqueados por las reglas nuevas (subtipo PLANCHA sin largo fijo, o con
// una unidad que el servicio no admite). Si devuelve filas, hay que corregirlas antes de
// desplegar, no después.
//
// Uso: node scripts/check-roofing-catalog.mjs [--branch production|demo|dev]
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString } from './lib.mjs';

const argv = process.argv;
const branch = argv.includes('--branch') ? argv[argv.indexOf('--branch') + 1] : 'production';

const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsx', 'prisma/roofing-catalog-report.ts'],
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
