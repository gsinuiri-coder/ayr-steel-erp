// Foto de solo lectura de los reportes que una ventana tiene que dejar iguales al centavo:
// Inventario valorizado, Ventas y margen (agosto y año) y el catálogo `BOB…` activo/inactivo.
// Nació del ensayo de RF-S4b en demo y quedó como herramienta de ventana.
//
// Uso:
//   node scripts/snapshot-reports.mjs snapshot <etiqueta> --out <dir> [opciones]
//   node scripts/snapshot-reports.mjs quotation <COT-nnnnnn> --out <dir> [opciones]
//   node scripts/snapshot-reports.mjs compare <a.json> <b.json>
// Opciones: --base-url URL (por defecto v2.mareliac.pe/api), --env-file F, --ephemeral-admin.
//
// Solo hace GET, salvo el POST de login. Entra con ADMIN_EMAIL / ADMIN_PASSWORD del archivo de
// entorno (por defecto `.env.setup`), o con `--ephemeral-admin` usa el mismo patrón que
// `smoke:prod` (D-024): crea un ADMINISTRADOR `e2e-...@ayr.test` con contraseña al azar en
// production y lo borra al terminar, pase lo que pase. Nunca imprime contraseñas ni cookies.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, neonConnectionString, readEnvFile } from './lib.mjs';

const DEFAULT_BASE_URL = 'https://v2.mareliac.pe/api';

function option(args, name, fallback) {
  const i = args.indexOf(name);
  return i > -1 && args[i + 1] ? args[i + 1] : fallback;
}

const EPHEMERAL_EMAIL = 'e2e-snapshot@ayr.test';

function runInApi(args, extraEnv) {
  const res = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
    cwd: resolve(ROOT, 'apps/api'),
    env: {
      ...process.env,
      DATABASE_URL: neonConnectionString('production', { pooled: true }),
      DIRECT_URL: neonConnectionString('production', { pooled: false }),
      ...extraEnv,
    },
    stdio: 'inherit',
    shell: true, // `pnpm` es un .cmd en Windows y spawn sin shell falla con EINVAL
  });
  return res.status ?? 1;
}

/** Credenciales de entrada: las del archivo de entorno o las del admin efímero recién creado. */
function credentials({ envFile, ephemeral }) {
  if (ephemeral) {
    const password = `E2e-${randomBytes(12).toString('base64url')}`;
    const created = runInApi(['exec', 'tsx', 'prisma/e2e-admin.ts'], {
      ALLOW_E2E_ADMIN: '1',
      E2E_ADMIN_EMAIL: EPHEMERAL_EMAIL,
      E2E_ADMIN_PASSWORD: password,
    });
    if (created !== 0) throw new Error('No se pudo crear el admin efímero');
    return { email: EPHEMERAL_EMAIL, password };
  }
  const env = readEnvFile(envFile ? resolve(ROOT, envFile) : undefined);
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    throw new Error('Faltan ADMIN_EMAIL o ADMIN_PASSWORD en el archivo de entorno.');
  }
  return { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD };
}

const cleanupEphemeral = () =>
  runInApi(['exec', 'tsx', 'prisma/cleanup-e2e-users.ts'], { ALLOW_E2E_CLEANUP: '1' });

async function login(baseUrl, creds) {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: creds.email, password: creds.password }),
  });
  if (!res.ok) throw new Error(`Login falló: HTTP ${res.status}`);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

async function get(baseUrl, cookie, path) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function write(out, name, data) {
  const dir = resolve(ROOT, out);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, name);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  return path;
}

async function snapshot(label, { baseUrl, out, creds }) {
  const cookie = await login(baseUrl, creds);
  const valuation = await get(baseUrl, cookie, '/reports/inventory-valuation');
  const august = await get(baseUrl, cookie, '/reports/sales-margin?from=2026-08-01&to=2026-08-31');
  const year = await get(baseUrl, cookie, '/reports/sales-margin?from=2026-01-01&to=2026-12-31');
  const catalog = await get(baseUrl, cookie, '/catalog');
  const bob = catalog.filter((p) => p.sku.toUpperCase().startsWith('BOB'));
  const result = {
    label,
    at: new Date().toISOString(),
    baseUrl,
    inventoryValuation: valuation.totals,
    salesMarginAugust: august.totals,
    salesMarginYear: year.totals,
    bobActive: bob.filter((p) => p.isActive).length,
    bobInactive: bob.filter((p) => !p.isActive).length,
    bobActiveSkus: bob
      .filter((p) => p.isActive)
      .map((p) => p.sku)
      .sort(),
  };
  const path = write(out, `snapshot-${label}.json`, result);
  const { bobActiveSkus: _skus, ...shown } = result;
  console.log(JSON.stringify(shown, null, 2));
  console.log(`Guardado en ${path}`);
}

async function quotation(code, { baseUrl, out, creds }) {
  const cookie = await login(baseUrl, creds);
  const list = await get(
    baseUrl,
    cookie,
    `/sales/quotations?pageSize=200&q=${encodeURIComponent(code)}`,
  );
  const hit = (list.items ?? []).find((q) => q.code === code);
  if (!hit) throw new Error(`${code} no está`);
  const q = await get(baseUrl, cookie, `/sales/quotations/${hit.id}`);
  const summary = {
    code: q.code,
    status: q.status,
    notes: q.notes ?? null,
    subtotalPen: q.subtotalPen,
    igvPen: q.igvPen,
    totalPen: q.totalPen,
    items: q.items.map((i) => ({
      productSku: i.productSku,
      qty: i.qty,
      unitPricePen: i.unitPricePen,
      reserveItemType: i.reserveItemType,
      reserveItemLabel: i.reserveItemLabel,
      subtotalPen: i.subtotalPen,
      igvPen: i.igvPen,
      totalPen: i.totalPen,
    })),
  };
  const path = write(out, `${code}.json`, summary);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Guardado en ${path}`);
}

/** Compara dos fotos campo por campo; exit 1 si algún total o el catálogo `BOB…` difiere. */
function compare(a, b) {
  const left = JSON.parse(readFileSync(resolve(ROOT, a), 'utf8'));
  const right = JSON.parse(readFileSync(resolve(ROOT, b), 'utf8'));
  const diffs = [];
  for (const section of ['inventoryValuation', 'salesMarginAugust', 'salesMarginYear']) {
    const keys = new Set([...Object.keys(left[section]), ...Object.keys(right[section])]);
    for (const k of keys) {
      if (left[section][k] !== right[section][k]) {
        diffs.push(`${section}.${k}: ${left[section][k]} → ${right[section][k]}`);
      }
    }
  }
  for (const k of ['bobActive', 'bobInactive']) {
    if (left[k] !== right[k]) diffs.push(`${k}: ${left[k]} → ${right[k]}`);
  }
  const gone = left.bobActiveSkus.filter((s) => !right.bobActiveSkus.includes(s));
  const added = right.bobActiveSkus.filter((s) => !left.bobActiveSkus.includes(s));
  if (gone.length) diffs.push(`BOB… activos que ya no están: ${gone.join(', ')}`);
  if (added.length) diffs.push(`BOB… activos nuevos: ${added.join(', ')}`);
  console.log(`${left.label} → ${right.label}`);
  if (diffs.length === 0) {
    console.log('Idénticos: totales y catálogo BOB… activo.');
    return 0;
  }
  for (const d of diffs) console.log(`  ${d}`);
  return 1;
}

const [mode, arg, arg2] = process.argv.slice(2);
const args = process.argv.slice(2);
const opts = {
  baseUrl: option(args, '--base-url', DEFAULT_BASE_URL).replace(/\/$/, ''),
  out: option(args, '--out'),
  envFile: option(args, '--env-file'),
  ephemeral: args.includes('--ephemeral-admin'),
};
try {
  if (mode === 'compare' && arg && arg2) {
    process.exitCode = compare(arg, arg2);
  } else if ((mode === 'snapshot' || mode === 'quotation') && arg && opts.out) {
    // El Ctrl+C no pasa por el `finally`: sin esto, el admin efímero quedaría vivo.
    if (opts.ephemeral) {
      for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
          cleanupEphemeral();
          process.exit(130);
        });
      }
    }
    try {
      opts.creds = credentials(opts);
      await (mode === 'snapshot' ? snapshot(arg, opts) : quotation(arg, opts));
    } finally {
      if (opts.ephemeral && cleanupEphemeral() !== 0) {
        console.error('No se pudo borrar el admin efímero: revisá /usuarios en producción.');
        process.exitCode = 1;
      }
    }
  } else {
    console.error(
      'Uso: snapshot <etiqueta> --out <dir> | quotation <COT-nnnnnn> --out <dir> | compare <a.json> <b.json>',
    );
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
