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
// D-636: antes de probar nada espera a que la web publique el commit esperado, en los dos
// dominios (`/version`), y muestra el de la API (`/api/health`). El esperado de la web es
// `--expect-sha` o, sin él, `origin/main`. El de la API solo se compara con `--expect-api-sha`
// (la API no se despliega en cada merge).
//
// Uso: pnpm smoke:prod [--base-url https://...] [--expect-sha <sha>] [--expect-api-sha <sha>]
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ROOT, neonConnectionString, run } from './lib.mjs';
import { PRODUCTION_WEB_HOSTS, isAllowedSmokeBaseUrl } from './smoke-prod-guard.mjs';
import {
  VERSION_TIMEOUT_MS,
  argValue,
  fetchShaField,
  gitContains,
  mismatchMessage,
  waitForSha,
} from './smoke-version.mjs';

const DEFAULT_BASE_URL = 'https://ayr-steel-erp-web.vercel.app';
const E2E_ADMIN_EMAIL = 'e2e-smoke@ayr.test';

const argv = process.argv;
const baseUrl = (
  argv.includes('--base-url') ? argv[argv.indexOf('--base-url') + 1] : DEFAULT_BASE_URL
).replace(/\/+$/, '');

// A esta URL se le manda el usuario y la contraseña del admin efímero de **producción**: ver
// `smoke-prod-guard.mjs`.
if (!isAllowedSmokeBaseUrl(baseUrl)) {
  throw new Error(
    `--base-url tiene que ser https y del dominio del proyecto (recibido: ${baseUrl})`,
  );
}

// D-636: el commit que tiene que estar publicado. Se valida antes de tocar producción.
const expectedApiSha = argValue(argv, '--expect-api-sha');
let expectedWebSha = argValue(argv, '--expect-sha');
if (expectedWebSha === null) {
  run('git', ['fetch', '--quiet', 'origin', 'main']);
  expectedWebSha = run('git', ['rev-parse', 'origin/main']).trim();
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
  { label: 'catálogo', path: '/api/catalog' },
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

// 0. D-636: el commit publicado. La web, en los dos dominios, hasta que coincida o hasta el tope;
// la API, con su sha a la vista y comparado solo si se pidió. Los dos dominios comparten un solo
// tope de 10 minutos, y vale también un commit posterior que ya trae el esperado.
const webDeadline = Date.now() + VERSION_TIMEOUT_MS;
const contains = gitContains(ROOT);
for (const host of PRODUCTION_WEB_HOSTS) {
  const url = `https://${host}/version`;
  const label = `web publicada (${host})`;
  const result = await waitForSha({
    expected: expectedWebSha,
    deadline: webDeadline,
    contains,
    readSha: () => fetchShaField(fetch, url, 'sha'),
    onAttempt: ({ attempts, published, error }) =>
      console.log(
        `  …      ${label}: intento ${attempts}, publicado ${published ?? '—'}${error ? ` (${error})` : ''}; esperado ${expectedWebSha.slice(0, 8)}`,
      ),
  });
  if (result.ok)
    ok(
      label,
      result.newer
        ? `sha ${result.published.slice(0, 8)}, posterior a ${expectedWebSha.slice(0, 8)} y lo contiene`
        : `sha ${result.published.slice(0, 8)}`,
    );
  else
    fail(
      label,
      mismatchMessage({
        where: url,
        expected: expectedWebSha,
        published: result.published,
        error: result.error,
        timeoutMs: VERSION_TIMEOUT_MS,
      }),
    );
}

// 1. Salud del API, sin sesión, con el commit desplegado.
const healthUrl = `${baseUrl}/api/health`;
if (expectedApiSha === null) {
  try {
    const sha = await fetchShaField(fetch, healthUrl, 'sha');
    ok('health', `API en ${sha ?? '(sin sha)'}; sin --expect-api-sha no se compara`);
  } catch (err) {
    fail('health', err instanceof Error ? err.message : String(err));
  }
} else {
  const result = await waitForSha({
    expected: expectedApiSha,
    readSha: () => fetchShaField(fetch, healthUrl, 'sha'),
    onAttempt: ({ attempts, published, error }) =>
      console.log(
        `  …      health: intento ${attempts}, API en ${published ?? '—'}${error ? ` (${error})` : ''}; esperado ${expectedApiSha}`,
      ),
  });
  if (result.ok) ok('health', `API en ${result.published}, el esperado`);
  else
    fail(
      'health',
      mismatchMessage({
        where: healthUrl,
        expected: expectedApiSha,
        published: result.published,
        error: result.error,
        timeoutMs: VERSION_TIMEOUT_MS,
      }),
    );
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

    // D-216: `PSE_ENABLED` tiene que quedar apagado con solo desplegar — nadie lo setea a
    // mano en Cloud Run. Si algún día aparece encendido en `production`, es una fuga de
    // configuración y el smoke tiene que decirlo, no un lector del panel de Comprobantes.
    try {
      const res = await fetch(`${baseUrl}/api/invoicing/settings`, { headers: { cookie } });
      if (!res.ok) {
        fail('emisión electrónica apagada (D-216)', `HTTP ${res.status}`);
      } else {
        const settings = await res.json();
        if (settings.pseEnabled === false) {
          ok('emisión electrónica apagada (D-216)');
        } else {
          fail(
            'emisión electrónica apagada (D-216)',
            `PSE_ENABLED quedó encendido en production (pseEnabled=${String(settings.pseEnabled)})`,
          );
        }
      }
    } catch (err) {
      fail('emisión electrónica apagada (D-216)', err instanceof Error ? err.message : String(err));
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
