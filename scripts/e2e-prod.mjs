// Corre los E2E de autenticación (auth.spec.ts), de Fase 1 (fase1.spec.ts), de las fases
// 2a, 2b, 3, 3b y 4 (fase2a.spec.ts, fase2b.spec.ts, fase3.spec.ts, fase3b.spec.ts,
// fase4.spec.ts, fase4-bordes.spec.ts) y de la Sesión M-2 (m2-reversa-pago.spec.ts)
// contra producción (Vercel + Cloud Run), incluidos los escenarios que crean datos
// (RF-03: usuario desactivado, cambio de rol; Fase 1: acabado, producto, importación,
// margen; Fase 2a: compras, bobinas y kardex; Fase 3: corte tercerizado y flejes;
// Fase 3b: reversa de recepción de corte; Fase 4: órdenes de producción de drywall, con
// sus reportes de piezas y su merma de proceso; M-2: anular un pago a proveedor).
//
// Para no tocar la cuenta real del dueño, crea un ADMINISTRADOR efímero con
// contraseña aleatoria, corre la suite y lo borra junto con los usuarios que la
// suite haya creado — pase lo que pase (también si los tests fallan). Cada test de
// Fase 1 revierte por su cuenta lo que creó/cambió en `finishes`/`products`/
// `pricing_settings` (ver `e2e/tests/fase1.spec.ts`).
//
// Fase 2a solo revierte lo que el modelo permite revertir: proveedores, acabados y
// productos quedan desactivados y la compra creada desde XML queda anulada, pero una
// compra ya recibida (y sus bobinas y movimientos de kardex) no se puede deshacer
// hasta Fase 2b — el kardex es append-only por diseño (§3.2). Todo eso queda bajo
// proveedores desactivados y con nombres `E2E …`, identificable a simple vista.
//
// Uso: pnpm e2e:prod [--base-url https://...]
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ROOT, neonConnectionString, readEnvFile } from './lib.mjs';

const DEFAULT_BASE_URL = 'https://ayr-steel-erp-web.vercel.app';
const E2E_ADMIN_EMAIL = 'e2e-admin@ayr.test';

const idx = process.argv.indexOf('--base-url');
const baseUrl = idx > -1 ? process.argv[idx + 1] : DEFAULT_BASE_URL;

readEnvFile(); // valida que .env.setup exista antes de tocar producción

const apiDir = resolve(ROOT, 'apps/api');
const dbEnv = {
  DATABASE_URL: neonConnectionString('production', { pooled: true }),
  DIRECT_URL: neonConnectionString('production', { pooled: false }),
};
// Contraseña efímera: solo vive en memoria y en el proceso hijo.
const password = `E2E-${randomBytes(18).toString('base64url')}`;

/** Ejecuta un paso y devuelve su código de salida (sin volcar el entorno al log). */
function run(cwd, command, args, extraEnv = {}) {
  const res = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...dbEnv, ...extraEnv },
    stdio: 'inherit',
    shell: true, // `pnpm` es un .cmd en Windows y spawn sin shell falla con EINVAL
  });
  return res.status ?? 1;
}

const cleanup = () =>
  run(apiDir, 'pnpm', ['exec', 'tsx', 'prisma/cleanup-e2e-users.ts'], {
    ALLOW_E2E_CLEANUP: '1',
  });

console.log(`E2E contra ${baseUrl} (admin efímero ${E2E_ADMIN_EMAIL})`);

const created = run(apiDir, 'pnpm', ['exec', 'tsx', 'prisma/e2e-admin.ts'], {
  ALLOW_E2E_ADMIN: '1',
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_PASSWORD: password,
});
if (created !== 0) {
  cleanup();
  throw new Error('No se pudo crear el admin efímero de E2E');
}

let testStatus = 1;
try {
  testStatus = run(
    ROOT,
    'pnpm',
    [
      'exec',
      'playwright',
      'test',
      'e2e/tests/auth.spec.ts',
      'e2e/tests/fase1.spec.ts',
      'e2e/tests/fase2a.spec.ts',
      'e2e/tests/fase2b.spec.ts',
      'e2e/tests/fase3.spec.ts',
      'e2e/tests/fase3b.spec.ts',
      'e2e/tests/fase4.spec.ts',
      'e2e/tests/fase4-bordes.spec.ts',
      'e2e/tests/m2-reversa-pago.spec.ts',
    ],
    {
      E2E_BASE_URL: baseUrl,
      E2E_ALLOW_WRITES: '1',
      E2E_ADMIN_EMAIL,
      E2E_ADMIN_PASSWORD: password,
    },
  );
} finally {
  const cleaned = cleanup();
  if (cleaned !== 0) {
    console.error(
      'ATENCIÓN: la limpieza de usuarios de E2E falló; revisar /usuarios en producción',
    );
    process.exitCode = 1;
  }
}

process.exitCode = testStatus === 0 ? (process.exitCode ?? 0) : testStatus;
