// Verificación post-deploy contra producción: **solo lectura** (D-126).
//
// Reemplaza a `pnpm e2e:prod` como rutina desde que producción tiene datos reales. La suite
// completa crea compras, bobinas, órdenes y despachos, y el kardex es append-only: lo que
// esa suite deja no siempre se puede deshacer (ver el residuo documentado en las fases 7d y
// 7e). Contra una base con inventario real eso ya no es un rastro molesto, es contaminación
// del stock del cliente. La suite completa vive en local y en CI, contra Neon `ci`.
//
// Lo único que este smoke escribe es el ADMINISTRADOR efímero de D-024 (patrón ya existente:
// nunca se usa la cuenta real del dueño), que se borra en `finally` pase lo que pase. De ahí
// en adelante son GET.
//
// Uso: pnpm smoke:prod [--base-url https://...]
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ROOT, neonConnectionString } from './lib.mjs';

const DEFAULT_BASE_URL = 'https://ayr-steel-erp-web.vercel.app';
const E2E_ADMIN_EMAIL = 'e2e-smoke@ayr.test';

const argv = process.argv;
const baseUrl = (
  argv.includes('--base-url') ? argv[argv.indexOf('--base-url') + 1] : DEFAULT_BASE_URL
).replace(/\/+$/, '');

// A esta URL se le manda el usuario y la contraseña del admin efímero de **producción**. Un
// argumento copiado de un chat o un dedo que resbala no puede terminar en un host cualquiera.
const allowed = (() => {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && /(^|\.)vercel\.app$|(^|\.)ayr\b/.test(url.hostname);
  } catch {
    return false;
  }
})();
if (!allowed) {
  throw new Error(
    `--base-url tiene que ser https y del dominio del proyecto (recibido: ${baseUrl})`,
  );
}

const apiDir = resolve(ROOT, 'apps/api');
const dbEnv = {
  DATABASE_URL: neonConnectionString('production', { pooled: true }),
  DIRECT_URL: neonConnectionString('production', { pooled: false }),
};
const password = `E2e-${randomBytes(12).toString('base64url')}`;

function runInApi(args, extraEnv) {
  const res = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
    cwd: apiDir,
    env: { ...process.env, ...dbEnv, ...extraEnv },
    stdio: 'inherit',
    shell: true, // `pnpm` es un .cmd en Windows y spawn sin shell falla con EINVAL
  });
  return res.status ?? 1;
}

const cleanup = () =>
  runInApi(['exec', 'tsx', 'prisma/cleanup-e2e-users.ts'], { ALLOW_E2E_CLEANUP: '1' });

// Un Ctrl+C entre crear el admin efímero y el `finally` lo dejaría vivo en producción. El
// `finally` no corre ante una señal, así que hace falta decirlo explícitamente.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.error(`\nInterrumpido: borrando el admin efímero antes de salir…`);
    cleanup();
    process.exit(130);
  });
}

/** Los GET del smoke. Cada uno tiene que responder 200 y traer JSON parseable. */
const READ_ONLY_CHECKS = [
  { label: 'líneas de negocio', path: '/api/business-lines' },
  { label: 'catálogo', path: '/api/catalog/products?page=1&pageSize=5' },
  { label: 'inventario valorizado', path: '/api/inventory/balances' },
  { label: 'bobinas', path: '/api/coils?page=1&pageSize=5' },
  { label: 'reporte mensual de bobinas', path: '/api/reports/coils' },
];

let failures = 0;
const fail = (label, detail) => {
  failures += 1;
  console.error(`  FALLA  ${label}: ${detail}`);
};
const ok = (label, detail = '') => {
  console.log(`  ok     ${label}${detail ? ` (${detail})` : ''}`);
};

console.log(`Smoke de solo lectura contra ${baseUrl}`);

// 1. Salud del API, sin sesión.
try {
  const res = await fetch(`${baseUrl}/api/health`);
  if (res.ok) ok('health', String(res.status));
  else fail('health', `HTTP ${res.status}`);
} catch (err) {
  fail('health', err instanceof Error ? err.message : String(err));
}

// 2. Login con el admin efímero, y de ahí los GET.
const created = runInApi(['exec', 'tsx', 'prisma/e2e-admin.ts'], {
  ALLOW_E2E_ADMIN: '1',
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_PASSWORD: password,
});
if (created !== 0) {
  cleanup();
  throw new Error('No se pudo crear el admin efímero del smoke');
}

try {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: E2E_ADMIN_EMAIL, password }),
  });
  if (!login.ok) {
    fail('login', `HTTP ${login.status}`);
  } else {
    ok('login');
    // La sesión viaja en cookies httpOnly (D-010); se reenvían tal cual en cada GET.
    const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    for (const check of READ_ONLY_CHECKS) {
      try {
        const res = await fetch(`${baseUrl}${check.path}`, { headers: { cookie } });
        if (!res.ok) {
          fail(check.label, `HTTP ${res.status}`);
          continue;
        }
        const body = await res.json();
        const count = Array.isArray(body)
          ? body.length
          : Array.isArray(body?.items)
            ? body.items.length
            : Array.isArray(body?.rows)
              ? body.rows.length
              : null;
        ok(check.label, count === null ? '' : `${count} fila(s)`);
      } catch (err) {
        fail(check.label, err instanceof Error ? err.message : String(err));
      }
    }
  }
} finally {
  if (cleanup() !== 0) {
    failures += 1;
    console.error('  FALLA  no se pudo borrar el admin efímero: revisá /usuarios en producción');
  }
}

if (failures > 0) {
  console.error(`\nSmoke con ${failures} falla(s).`);
  process.exit(1);
}
console.log('\nSmoke en verde: producción responde y las lecturas principales funcionan.');
