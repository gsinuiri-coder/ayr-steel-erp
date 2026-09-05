// Corre los E2E de autenticación (auth.spec.ts), de Fase 1 (fase1.spec.ts), de las fases
// 2a, 2b, 3, 3b y 4 (fase2a.spec.ts, fase2b.spec.ts, fase3.spec.ts, fase3b.spec.ts,
// fase4.spec.ts, fase4-bordes.spec.ts), de la Sesión M-2 (m2-reversa-pago.spec.ts), de
// la Fase 5a (fase5a.spec.ts, fase5a-bordes.spec.ts), de la Fase 5b (fase5b.spec.ts,
// fase5b-bordes.spec.ts), de la Fase 6 (fase6.spec.ts, fase6-bordes.spec.ts) y de la
// Fase 7 (fase7.spec.ts, fase7-bordes.spec.ts: cola de producción, RF-37/RF-38) contra
// producción (Vercel + Cloud Run), incluidos los escenarios que crean datos (RF-03:
// usuario desactivado, cambio de rol; Fase 1: acabado, producto, importación, margen;
// Fase 2a: compras, bobinas y kardex; Fase 3: corte tercerizado y flejes; Fase 3b:
// reversa de recepción de corte; Fase 4: órdenes de producción de drywall, con sus
// reportes de piezas y su merma de proceso; M-2: anular un pago a proveedor; Fase 6:
// producción de coberturas y maestro de colores; Fase 7: cola derivada, prioridad y
// fecha prometida).
//
// D-081 (Sesión M-3): desde que producción puede llevar credenciales reales del PSE,
// `E2E_FISCAL_EMISSION` se fuerza a `'0'` más abajo sin importar qué traiga el entorno de
// quien invoca este script. Los tests de facturación que emiten (fase5b*.spec.ts) se
// saltan siempre contra producción; el resto de la suite (despacho, borradores, cobranza
// sobre lo ya emitido) sigue corriendo igual. Habilitarlo aquí sería emitir comprobantes
// reales contra SUNAT en cada corrida de E2E — no hay ningún escenario en el que eso sea
// correcto.
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

/**
 * Todo lo que no sea `--base-url` y su valor se le pasa tal cual a Playwright. La lista de
 * suites **no** es negociable —es lo que se verifica contra producción— pero acotarla con un
 * `--grep` sí, y tener que editar el guion para eso invitaba a editarlo mal.
 */
function extraPlaywrightArgs(argv) {
  const out = [];
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--base-url') {
      i += 1;
      continue;
    }
    // `run()` lanza con `shell: true` (pnpm es un .cmd en Windows), así que un argumento
    // con espacios se parte en dos si no viaja entrecomillado: `--grep "Fase 7b"` llegaba a
    // Playwright como `--grep Fase` más un filtro de archivo `7b`, y la corrida acotada
    // terminaba ejecutando casi toda la suite.
    out.push(/s/.test(argv[i]) ? JSON.stringify(argv[i]) : argv[i]);
  }
  return out;
}
const extraArgs = extraPlaywrightArgs(process.argv);

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
      'e2e/tests/fase5a.spec.ts',
      'e2e/tests/fase5a-bordes.spec.ts',
      'e2e/tests/fase5b.spec.ts',
      'e2e/tests/fase5b-bordes.spec.ts',
      'e2e/tests/fase6.spec.ts',
      'e2e/tests/fase6-bordes.spec.ts',
      'e2e/tests/fase7.spec.ts',
      'e2e/tests/fase7-bordes.spec.ts',
      'e2e/tests/fase7b.spec.ts',
      'e2e/tests/fase7b-bordes.spec.ts',
      // Cualquier bandera extra que se le pase a `pnpm e2e:prod` viaja a Playwright. Sirve
      // para acotar una corrida —`pnpm e2e:prod --grep "Fase 7b"`— cuando lo que se quiere
      // verificar es una fase concreta y no las dos horas de suite entera. Va **después** de
      // la lista de archivos: una bandera de Playwright puede ir en cualquier posición, y
      // así ningún argumento del usuario puede desplazar a un archivo de la lista.
      ...extraArgs,
    ],
    {
      E2E_BASE_URL: baseUrl,
      E2E_ALLOW_WRITES: '1',
      E2E_ADMIN_EMAIL,
      E2E_ADMIN_PASSWORD: password,
      // D-081: nunca emitir contra el PSE real desde e2e:prod (ver nota arriba).
      E2E_FISCAL_EMISSION: '0',
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
