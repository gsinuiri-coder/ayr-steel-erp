// Deja el inventario de producción sin el stock que dejaron los E2E.
//
// Fase 2a no podía hacer esto: el kardex es append-only (§3.2) y deshacer una compra
// recibida exige el movimiento inverso, que es de Fase 2b. Con `reverse` ya construido,
// una compra `RECEIVED` de un proveedor `E2E …` se anula por el mismo endpoint que usa
// el dueño, con motivo y auditoría; el kardex conserva el rastro completo y el
// inventario valorizado (RF-51) deja de sumar bobinas de prueba.
//
// Solo toca lo que cuelga de un proveedor cuyo nombre empieza con `E2E `. No borra
// nada: anula por API, igual que lo haría un administrador desde la pantalla. Corre
// contra el API desplegado, no contra la base, para pasar por las mismas validaciones.
//
// Uso: pnpm prod:purge-e2e [--base-url https://...] [--dry-run]
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ROOT, neonConnectionString, readEnvFile } from './lib.mjs';

const DEFAULT_BASE_URL = 'https://ayr-steel-erp-web.vercel.app';
const E2E_ADMIN_EMAIL = 'e2e-admin@ayr.test';
const REASON = 'Limpieza de datos de prueba E2E';

const idx = process.argv.indexOf('--base-url');
const baseUrl = idx > -1 ? process.argv[idx + 1] : DEFAULT_BASE_URL;
const dryRun = process.argv.includes('--dry-run');

readEnvFile(); // valida que .env.setup exista antes de tocar producción

const apiDir = resolve(ROOT, 'apps/api');
const dbEnv = {
  DATABASE_URL: neonConnectionString('production', { pooled: true }),
  DIRECT_URL: neonConnectionString('production', { pooled: false }),
};
const password = `E2E-${randomBytes(18).toString('base64url')}`;

function run(cwd, command, args, extraEnv = {}) {
  const res = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...dbEnv, ...extraEnv },
    stdio: 'inherit',
    shell: true, // `pnpm` es un .cmd en Windows y spawn sin shell falla con EINVAL
  });
  return res.status ?? 1;
}

const cleanupAdmin = () =>
  run(apiDir, 'pnpm', ['exec', 'tsx', 'prisma/cleanup-e2e-users.ts'], { ALLOW_E2E_CLEANUP: '1' });

/** Cliente HTTP con la cookie de sesión del admin efímero. */
function createClient() {
  let cookie = '';
  const call = async (path, options = {}) => {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    if (setCookie.length > 0) {
      cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { ok: res.ok, status: res.status, body: json };
  };
  return call;
}

console.log(`Limpieza de datos E2E en ${baseUrl}${dryRun ? ' (simulación)' : ''}`);

const created = run(apiDir, 'pnpm', ['exec', 'tsx', 'prisma/e2e-admin.ts'], {
  ALLOW_E2E_ADMIN: '1',
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_PASSWORD: password,
});
if (created !== 0) {
  cleanupAdmin();
  throw new Error('No se pudo crear el admin efímero');
}

let failed = false;
try {
  const call = createClient();
  const login = await call('/auth/login', {
    method: 'POST',
    body: { email: E2E_ADMIN_EMAIL, password },
  });
  if (!login.ok) throw new Error(`Login del admin efímero falló (${login.status})`);

  // `GET /suppliers` devuelve también los desactivados, que es justo donde quedan los
  // proveedores de prueba tras la limpieza que hace cada spec en su `finally`.
  const suppliers = await call('/suppliers');
  const e2eSupplierIds = new Set(
    (Array.isArray(suppliers.body) ? suppliers.body : [])
      .filter((s) => typeof s.name === 'string' && s.name.startsWith('E2E'))
      .map((s) => s.id),
  );
  console.log(`Proveedores E2E: ${e2eSupplierIds.size}`);

  // 0) Órdenes de corte pendientes (Fase 3, D-050): una bobina enviada a un tercero
  //    queda IN_THIRD_PARTY sin movimiento de kardex, así que ni el paso 1 (anular
  //    compra) ni el paso 2 (anular bobina abierta) la alcanzan. Cancelar lo pendiente
  //    la devuelve a OPEN antes de que los pasos siguientes puedan tocarla.
  const cuttingOrders = await call('/cutting');
  const pendingCuttingOrders = (Array.isArray(cuttingOrders.body) ? cuttingOrders.body : []).filter(
    (o) =>
      e2eSupplierIds.has(o.supplierId) &&
      (o.status === 'SENT' || o.status === 'PARTIALLY_RECEIVED'),
  );
  console.log(`Órdenes de corte E2E pendientes: ${pendingCuttingOrders.length}`);
  for (const order of pendingCuttingOrders) {
    if (dryRun) {
      console.log(`  [simulado] cancelar lo pendiente de la orden ${order.id}`);
      continue;
    }
    const res = await call(`/cutting/${order.id}/cancel`, {
      method: 'POST',
      body: { reason: REASON },
    });
    console.log(
      res.ok
        ? `  orden de corte ${order.id} — lo pendiente quedó cancelado`
        : `  orden de corte ${order.id} NO se pudo cancelar: ${res.body?.message ?? res.status}`,
    );
  }

  // 1) Compras recibidas: anularlas revierte su kardex y anula sus bobinas de una vez.
  const purchases = await call('/purchases');
  const received = (Array.isArray(purchases.body) ? purchases.body : []).filter(
    (p) => e2eSupplierIds.has(p.supplierId) && p.status === 'RECEIVED',
  );
  for (const purchase of received) {
    if (dryRun) {
      console.log(`  [simulado] anular compra ${purchase.documentLabel}`);
      continue;
    }
    const res = await call(`/purchases/${purchase.id}/cancel`, {
      method: 'POST',
      body: { reason: REASON },
    });
    console.log(
      res.ok
        ? `  compra ${purchase.documentLabel} anulada`
        : `  compra ${purchase.documentLabel} NO se pudo anular: ${res.body?.message ?? res.status}`,
    );
  }

  // 2) Bobinas que quedaron con saldo y no cuelgan de una compra (alta por planilla,
  //    RF-12): se anulan una por una con el mismo endpoint de RF-21.
  const coils = await call('/coils?status=OPEN');
  const orphans = (Array.isArray(coils.body) ? coils.body : []).filter(
    (c) => e2eSupplierIds.has(c.supplierId) && Number.parseFloat(c.availableKg) > 0,
  );
  for (const coil of orphans) {
    if (dryRun) {
      console.log(`  [simulado] anular bobina ${coil.code}`);
      continue;
    }
    const res = await call(`/coils/${coil.id}/cancel`, {
      method: 'POST',
      body: { reason: REASON },
    });
    console.log(
      res.ok
        ? `  bobina ${coil.code} anulada`
        : `  bobina ${coil.code} NO se pudo anular: ${res.body?.message ?? res.status}`,
    );
  }

  // 3) Estado final del valorizado, para dejarlo por escrito en el log.
  const remaining = await call('/coils?status=OPEN');
  const withStock = (Array.isArray(remaining.body) ? remaining.body : []).filter(
    (c) => Number.parseFloat(c.availableKg) > 0,
  );
  console.log(`Bobinas abiertas con saldo tras la limpieza: ${withStock.length}`);
  for (const coil of withStock) {
    console.log(`  ${coil.code} — ${coil.supplierName} — ${coil.availableKg} kg`);
  }
} catch (err) {
  failed = true;
  console.error(err instanceof Error ? err.message : err);
} finally {
  cleanupAdmin();
}

process.exit(failed ? 1 : 0);
