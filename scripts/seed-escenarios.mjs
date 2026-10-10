// cc42 (D-592, D-595): siembra en el Postgres local `ayr_local` los casos de prueba de planta de
// demo-cc38 (plancha P1/P2, a medida M1/M2, accesorio A1/A2) y un drywall completo, para mirarlos
// con `pnpm dev:preview` (4000/4001).
//
// - Solo contra una base llamada exactamente `ayr_local` en localhost (el Docker de
//   `local-docker-env.mjs`). Cualquier otra —Neon, `ayr_local_e2e`, otro nombre u otro host— se
//   rechaza **antes de conectar**. `ESCENARIOS_DATABASE_URL` mueve el puerto o las credenciales
//   (la prueba de la CI usa el Postgres del runner), nunca el host ni el nombre de la base.
// - Todo pasa por la API (compra → recepción → cotización → pedido → OP → borrador o parte), que
//   este script levanta en su propio puerto (3200) y apaga al terminar: kardex, reservas y estados
//   cuadran porque los escriben los mismos servicios que usa la pantalla. Nada de SQL.
// - Idempotente por anulación (D-592): el kardex y la auditoría no admiten DELETE, así que lo DEMO
//   de una corrida anterior se **anula** por los mismos caminos de un administrador (reversa de
//   reportes, anular OP, pedido, cotización, corte, compra y bobina) y se crea un juego nuevo.
//   Lo DEMO es lo de «Proveedor Demo Aceros», «Proveedor Demo Corte», «Cliente Demo» y los SKU
//   de `DEMO_SKUS`; nada más se toca.
//
// Uso: pnpm seed:escenarios
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, run } from './lib.mjs';
import {
  DB_NAME_DEV,
  LOCAL_ADMIN_EMAIL,
  LOCAL_ADMIN_PASSWORD,
  LOCAL_VIEWER_EMAIL,
  LOCAL_VIEWER_PASSWORD,
  dbUrl,
} from './local-docker-env.mjs';
import { EXTERNAL_OUTPUTS_OFF } from './run-api-cli.mjs';

export const ESCENARIOS_DB_NAME = DB_NAME_DEV; // 'ayr_local'
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
/** Puertos que no son de este script: dueño, agente, E2E y demo (AGENTS.md §3.5). */
const RESERVED_PORTS = new Set([3000, 3001, 3002, 3100, 3101, 4000, 4001]);
const PREVIEW_WEB = 'http://127.0.0.1:4001';

export const DEMO = Object.freeze({
  steelSupplier: { code: 'DEMACE', name: 'Proveedor Demo Aceros', docNumber: '20999990001' },
  cuttingSupplier: { code: 'DEMCOR', name: 'Proveedor Demo Corte', docNumber: '20999990002' },
  customer: { name: 'Cliente Demo', docNumber: '99999901' },
});
export const REASON = 'seed:escenarios reemplaza los casos DEMO por un juego nuevo (D-592)';

const COLORS = {
  red: { code: 'DEMOROJO', name: 'Demo rojo', hexColor: '#b22222' },
  white: { code: 'DEMOBLANCO', name: 'Demo blanco', hexColor: '#f4f4f4' },
};
// Densidad 8: una bobina de 1220 × 0,40 da 3,94304 kg/m con el 1 % de D-165 (los números de la
// guía de demo-cc38).
const FINISHES = {
  red: { code: 'DEMO-ALZ-ROJO', name: 'DEMO aluzinc prepintado rojo', densityFactor: '8' },
  white: { code: 'DEMO-ALZ-BLANCO', name: 'DEMO aluzinc prepintado blanco', densityFactor: '8' },
  galv: { code: 'DEMO-GALV', name: 'DEMO galvanizado', densityFactor: '7.85' },
};
export const DEMO_SKUS = Object.freeze({
  sheet: 'DEMO-PL040-ROJO-4M',
  custom: 'DEMO-COB040-BLANCO',
  // D-343: el SKU de un accesorio es canónico (ACCES + espesor + color comercial).
  accessory: 'ACCES025DEMOBLANCO',
  stud: 'DEMO-PARANTE-89',
  track: 'DEMO-RIEL-90',
});

// ---------------------------------------------------------------------------
// Guard de base: corre antes de cualquier conexión
// ---------------------------------------------------------------------------

/** La URL de la base: `ESCENARIOS_DATABASE_URL` o el `ayr_local` del Docker. */
export function escenariosDbUrl(env = process.env) {
  const override = (env.ESCENARIOS_DATABASE_URL ?? '').trim();
  return override === '' ? dbUrl(ESCENARIOS_DB_NAME) : override;
}

/** Rechaza todo lo que no sea `ayr_local` en localhost. No conecta: solo mira la URL. */
export function assertEscenariosDb(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('seed:escenarios: la URL de la base no es válida.');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('seed:escenarios: solo corre contra Postgres.');
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      `seed:escenarios solo corre contra el Postgres local (host ${url.hostname}): nunca Neon ni otra máquina.`,
    );
  }
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (name !== ESCENARIOS_DB_NAME) {
    throw new Error(
      `seed:escenarios solo corre contra la base "${ESCENARIOS_DB_NAME}" (recibió "${name}"); ` +
        'ayr_local_e2e la vacía la suite E2E y cualquier otra no es de la vista previa.',
    );
  }
  return url.toString();
}

export function apiPort(env = process.env) {
  const raw = (env.ESCENARIOS_API_PORT ?? '').trim();
  const port = raw === '' ? 3200 : Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || RESERVED_PORTS.has(port)) {
    throw new Error(
      `ESCENARIOS_API_PORT=${raw} no sirve: usa uno libre fuera de ${[...RESERVED_PORTS].join(', ')}.`,
    );
  }
  return port;
}

// ---------------------------------------------------------------------------
// La API propia
// ---------------------------------------------------------------------------

function apiEnv(url, port) {
  return {
    NODE_ENV: 'development',
    DATABASE_URL: url,
    DIRECT_URL: url,
    JWT_SECRET: randomBytes(32).toString('hex'),
    ADMIN_EMAIL: LOCAL_ADMIN_EMAIL,
    ADMIN_PASSWORD: LOCAL_ADMIN_PASSWORD,
    AYR_ENVIRONMENT: 'local-escenarios',
    PORT: String(port),
    BIND_HOST: '127.0.0.1',
    WEB_ORIGIN: `http://127.0.0.1:${String(port)}`,
    THROTTLE_DISABLED: 'true',
    ...EXTERNAL_OUTPUTS_OFF,
  };
}

/** Migraciones, seed y la cuenta de la vista previa: lo mismo que hace `pnpm dev:preview`. */
export function prepareDatabase(url) {
  const apiDir = resolve(ROOT, 'apps/api');
  const env = {
    DATABASE_URL: url,
    DIRECT_URL: url,
    ADMIN_EMAIL: LOCAL_ADMIN_EMAIL,
    ADMIN_PASSWORD: LOCAL_ADMIN_PASSWORD,
  };
  run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: apiDir, env });
  run('pnpm', ['exec', 'tsx', 'prisma/seed.ts'], { cwd: apiDir, env });
  run('pnpm', ['exec', 'tsx', 'prisma/seed-view.ts'], {
    cwd: apiDir,
    env: { ...env, VIEWER_EMAIL: LOCAL_VIEWER_EMAIL, VIEWER_PASSWORD: LOCAL_VIEWER_PASSWORD },
  });
}

/**
 * Compila la API con `tsc` a `dist-cli` (no a `dist`, que es del `nest start --watch` de
 * `dev:preview`) y la levanta en `port`. Devuelve una función que la apaga.
 */
export async function startApi(url, port, { compile = true } = {}) {
  const apiDir = resolve(ROOT, 'apps/api');
  if (compile) run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.cli.json'], { cwd: apiDir });
  const base = `http://127.0.0.1:${String(port)}`;
  const busy = await fetch(`${base}/health`).then(
    () => true,
    () => false,
  );
  if (busy) throw new Error(`El puerto ${String(port)} ya está ocupado: apaga lo que escucha ahí.`);
  const child = spawn(process.execPath, ['dist-cli/src/main.js'], {
    cwd: apiDir,
    env: { ...process.env, ...apiEnv(url, port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4000);
  });
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`La API se cayó al arrancar:\n${stderr}`);
    const up = await fetch(`${base}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) break;
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`La API no respondió en 2 minutos:\n${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return {
    base,
    stop: () =>
      new Promise((done) => {
        if (child.exitCode !== null) return done();
        child.once('exit', () => done());
        child.kill();
      }),
  };
}

/** Cliente HTTP con la sesión (cookies) de la cuenta de la vista previa. */
export function createClient(base) {
  const cookies = new Map();
  async function call(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: base,
        cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok) {
      const message = typeof json === 'object' && json !== null ? json.message : json;
      const err = new Error(
        `${method} ${path} → ${String(res.status)}: ${JSON.stringify(message)}`,
      );
      err.status = res.status;
      throw err;
    }
    return json;
  }
  const api = {
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    del: (p, b) => call('DELETE', p, b),
    /** Listados: unos devuelven un arreglo y otros `{ items }`. */
    list: async (p) => {
      const r = await call('GET', `${p}${p.includes('?') ? '&' : '?'}pageSize=200`);
      return Array.isArray(r) ? r : (r?.items ?? []);
    },
    login: () =>
      call('POST', '/auth/login', { email: LOCAL_VIEWER_EMAIL, password: LOCAL_VIEWER_PASSWORD }),
  };
  return api;
}

export function limaToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
}

// ---------------------------------------------------------------------------
// Catálogo y maestros DEMO (se crean una vez y se reusan)
// ---------------------------------------------------------------------------

async function findOrCreate(api, listPath, match, createPath, body) {
  const found = (await api.list(listPath)).find(match);
  return found ?? api.post(createPath, body);
}

export async function ensureMasters(api) {
  const lines = await api.get('/business-lines');
  const lineId = (code) => {
    const line = lines.find((l) => l.code === code);
    if (!line) throw new Error(`Falta la línea ${code}: ¿corrió el seed?`);
    return line.id;
  };
  const roofingLine = lineId('metallic-roofing');
  const drywallLine = lineId('drywall');

  const red = await findOrCreate(
    api,
    '/colors',
    (c) => c.code === COLORS.red.code,
    '/colors',
    COLORS.red,
  );
  const white = await findOrCreate(
    api,
    '/colors',
    (c) => c.code === COLORS.white.code,
    '/colors',
    COLORS.white,
  );
  const finish = (spec, extra) =>
    findOrCreate(api, '/finishes', (f) => f.code === spec.code, '/finishes', { ...spec, ...extra });
  const redFinish = await finish(FINISHES.red, {
    kind: 'PREPINTADO',
    colorId: red.id,
    businessLine: 'metallic-roofing',
  });
  const whiteFinish = await finish(FINISHES.white, {
    kind: 'PREPINTADO',
    colorId: white.id,
    businessLine: 'metallic-roofing',
  });
  const galvFinish = await finish(FINISHES.galv, {
    kind: 'GALVANIZADO',
    colorId: null,
    businessLine: 'drywall',
  });

  const catalog = await api.list('/catalog');
  const product = async (sku, body) => {
    const found = catalog.find((p) => p.sku === sku && !p.mergedIntoId);
    return found ?? api.post('/catalog', { sku, source: 'MANUFACTURED', ...body });
  };
  const roofing = (finishRow, color, thicknessMm) => ({
    businessLineId: roofingLine,
    finishId: finishRow.id,
    colorId: color.id,
    thicknessMm,
    widthMm: '1220',
  });
  const sheet = await product(DEMO_SKUS.sheet, {
    ...roofing(redFinish, red, '0.40'),
    name: 'DEMO Plancha aluzinc 0,40 rojo 4,00 m',
    unit: 'NIU',
    roofingKind: 'PLANCHA',
    lengthMm: '4000',
    listPricePen: '88',
  });
  const custom = await product(DEMO_SKUS.custom, {
    ...roofing(whiteFinish, white, '0.40'),
    name: 'DEMO Cobertura aluzinc 0,40 blanco a medida',
    unit: 'MTR',
    roofingKind: 'A_MEDIDA',
    listPricePen: '22',
  });
  const accessory = await product(DEMO_SKUS.accessory, {
    ...roofing(whiteFinish, white, '0.25'),
    name: 'DEMO Accesorio aluzinc 0,25 blanco',
    unit: 'MTR',
    roofingKind: 'ACCESORIO',
    listPricePen: '15',
  });
  // D-344: en drywall el espesor y el ancho son los del fleje; el peso es el de la pieza
  // (0,45 × ancho × 3000 × 7,85 / 1e6).
  const drywall = (name, widthMm, pieceWeightKg) => ({
    businessLineId: drywallLine,
    name,
    unit: 'NIU',
    thicknessMm: '0.45',
    widthMm,
    lengthMm: '3000',
    pieceWeightKg,
    listPricePen: '12',
  });
  const stud = await product(
    DEMO_SKUS.stud,
    drywall('DEMO Parante 89 × 0,45 × 3,00 m', '244', '2.586'),
  );
  const track = await product(
    DEMO_SKUS.track,
    drywall('DEMO Riel 90 × 0,45 × 3,00 m', '180', '1.908'),
  );

  const supplier = (s, cutting) =>
    findOrCreate(api, '/suppliers', (x) => x.code === s.code, '/suppliers', {
      code: s.code,
      docType: 'RUC',
      docNumber: s.docNumber,
      name: s.name,
      creditDays: 0,
      providesCuttingService: cutting,
    });
  const steelSupplier = await supplier(DEMO.steelSupplier, false);
  const cuttingSupplier = await supplier(DEMO.cuttingSupplier, true);
  const customer = await findOrCreate(
    api,
    `/customers?search=${encodeURIComponent(DEMO.customer.docNumber)}`,
    (c) => c.docNumber === DEMO.customer.docNumber,
    '/customers',
    { docType: 'DNI', docNumber: DEMO.customer.docNumber, name: DEMO.customer.name, creditDays: 0 },
  );
  return {
    finishes: { red: redFinish, white: whiteFinish, galv: galvFinish },
    products: { sheet, custom, accessory, stud, track },
    steelSupplier,
    cuttingSupplier,
    customer,
  };
}

// ---------------------------------------------------------------------------
// Anulación de lo DEMO anterior (D-592)
// ---------------------------------------------------------------------------

/**
 * Anula lo DEMO vivo, en el orden en que se bloquea: comprobantes y despachos, OP (de la más
 * nueva a la más vieja), pedidos, cotizaciones y reservas, corte, compras y bobinas. Nunca lanza:
 * devuelve lo que no se pudo anular, para que el informe lo diga.
 */
export async function voidPrevious(api, masters) {
  const failures = [];
  const attempt = async (label, fn) => {
    try {
      await fn();
    } catch (err) {
      failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const isCustomer = (row) =>
    row.customerId === masters.customer.id || row.customerName === DEMO.customer.name;
  const supplierIds = new Set([masters.steelSupplier.id, masters.cuttingSupplier.id]);
  const skus = new Set(Object.values(DEMO_SKUS));
  const reason = { reason: REASON };

  // Comprobantes (cobros primero) y despachos: lo que el dueño pudo haber emitido probando.
  await attempt('comprobantes', async () => {
    const documents = (await api.list('/invoicing/documents')).filter(
      (d) => isCustomer(d) && !['VOIDED', 'REJECTED', 'ANNULLED'].includes(d.status),
    );
    for (const d of documents) {
      await attempt(`comprobante ${d.number ?? d.id}`, async () => {
        const detail = await api.get(`/invoicing/documents/${d.id}`);
        for (const p of (detail.payments ?? []).filter((x) => x.reversedAt === null)) {
          await api.post(`/invoicing/documents/${d.id}/payments/${p.id}/reverse`, reason);
        }
        if (d.status === 'DRAFT') await api.del(`/invoicing/documents/${d.id}`, reason);
        else await api.post(`/invoicing/documents/${d.id}/void`, reason);
      });
    }
  });
  await attempt('despachos', async () => {
    for (const d of (await api.list('/dispatches?status=ISSUED')).filter(isCustomer)) {
      await attempt(`despacho ${d.code}`, () => api.post(`/dispatches/${d.id}/reverse`, reason));
    }
  });

  await attempt('órdenes de producción', async () => {
    const orders = (await api.list('/production'))
      .filter((o) => skus.has(o.productSku) && o.status !== 'CANCELLED')
      .sort((a, b) => String(b.code).localeCompare(String(a.code)));
    for (const o of orders) {
      await attempt(`OP ${o.code}`, async () => {
        const base = o.kind === 'ROOFING' ? `/production/roofing/${o.id}` : `/production/${o.id}`;
        if (o.status === 'CLOSED') await api.post(`${base}/reopen`, reason);
        if (o.kind === 'ROOFING') {
          for (const d of await api.get(`${base}/drafts`)) await api.del(`${base}/drafts/${d.id}`);
        }
        const detail = await api.get(`/production/${o.id}`);
        const active = (detail.reports ?? []).filter((r) => r.status === 'ACTIVE');
        for (const r of [...active].reverse())
          await api.post(`${base}/reports/${r.id}/reverse`, reason);
        await api.post(`${base}/cancel`, reason);
      });
    }
  });

  await attempt('pedidos', async () => {
    for (const o of (await api.list('/sales/orders')).filter(
      (x) => isCustomer(x) && x.status !== 'CANCELLED',
    )) {
      await attempt(`pedido ${o.code}`, () => api.post(`/sales/orders/${o.id}/cancel`, reason));
    }
  });
  await attempt('cotizaciones', async () => {
    for (const q of (await api.list('/sales/quotations')).filter(
      (x) => isCustomer(x) && x.status !== 'CANCELLED',
    )) {
      await attempt(`cotización ${q.code}`, () =>
        api.post(`/sales/quotations/${q.id}/cancel`, reason),
      );
    }
  });
  await attempt('reservas', async () => {
    for (const r of (await api.list('/sales/reservations?status=ACTIVE')).filter(isCustomer)) {
      await attempt(`reserva ${r.id}`, () =>
        api.post(`/sales/reservations/${r.id}/release`, reason),
      );
    }
  });

  await attempt('cortes', async () => {
    const orders = (await api.list('/cutting')).filter((o) => supplierIds.has(o.supplierId));
    for (const o of orders.filter((x) => ['RECEIVED', 'PARTIALLY_RECEIVED'].includes(x.status))) {
      const detail = await api.get(`/cutting/${o.id}`);
      for (const row of (detail.coils ?? []).filter((c) => c.status === 'RECEIVED')) {
        await attempt(`recepción de ${row.coilCode}`, () =>
          api.post(`/cutting/${o.id}/coils/${row.coilId}/reverse`, reason),
        );
      }
    }
    const pending = (await api.list('/cutting')).filter(
      (o) => supplierIds.has(o.supplierId) && ['SENT', 'PARTIALLY_RECEIVED'].includes(o.status),
    );
    for (const o of pending)
      await attempt(`corte ${o.code ?? o.id}`, () => api.post(`/cutting/${o.id}/cancel`, reason));
  });

  await attempt('compras', async () => {
    const purchases = (await api.list('/purchases')).filter(
      (p) => supplierIds.has(p.supplierId) && p.status !== 'CANCELLED',
    );
    for (const p of purchases) {
      await attempt(`compra ${p.documentLabel ?? p.id}`, async () => {
        const detail = await api.get(`/purchases/${p.id}`);
        for (const pay of (detail.payments ?? []).filter((x) => !x.reversedAt)) {
          await api.post(`/purchases/${p.id}/payments/${pay.id}/reverse`, reason);
        }
        await api.post(`/purchases/${p.id}/cancel`, reason);
      });
    }
  });
  await attempt('bobinas', async () => {
    const coils = (await api.list('/coils?status=OPEN')).filter(
      (c) => supplierIds.has(c.supplierId) && Number.parseFloat(c.availableKg) > 0,
    );
    for (const c of coils)
      await attempt(`bobina ${c.code}`, () => api.post(`/coils/${c.id}/cancel`, reason));
  });
  return failures;
}

// ---------------------------------------------------------------------------
// Los casos
// ---------------------------------------------------------------------------

const pieces = (...rows) => rows.map(([m, qty]) => ({ lengthMm: (m * 1000).toFixed(2), qty }));

export async function seedCases(api, masters) {
  const today = limaToday();
  let seq = Number(String(Date.now()).slice(-7));
  const docNumber = () => {
    seq += 1;
    return `9${String(seq).padStart(7, '0')}`;
  };

  /** Una compra recibida de «Proveedor Demo Aceros», con sus bobinas en el orden pedido. */
  async function buyCoils(line, finish, thicknessMm, weights, note) {
    const purchase = await api.post('/purchases', {
      supplierId: masters.steelSupplier.id,
      businessLine: line,
      type: 'COIL',
      docType: 'FACTURA',
      series: 'F999',
      number: docNumber(),
      issueDate: today,
      currency: 'PEN',
      igvRate: '18',
      paymentTerms: 'CONTADO',
      notes: `DEMO · ${note}`,
      items: weights.map((w) => ({
        description: `Bobina DEMO ${note}`,
        qty: w,
        unit: 'KGM',
        unitPrice: '4.20',
        finishId: finish.id,
        widthMm: '1220',
        thicknessMm,
        coilStatus: 'OPEN',
      })),
    });
    await api.post(`/purchases/${purchase.id}/receive`, {});
    const coils = (await api.list(`/coils?supplierId=${masters.steelSupplier.id}`)).filter(
      (c) => c.purchaseId === purchase.id,
    );
    return weights.map((w) => {
      const i = coils.findIndex((c) => Number(c.weightKg) === Number(w));
      const [c] = coils.splice(i, 1);
      return c;
    });
  }

  /** Cotización → pedido → OP de coberturas, con las bobinas montadas en orden. */
  async function orderFor(key, product, item, coils) {
    const quotation = await api.post('/sales/quotations', {
      customerId: masters.customer.id,
      issueDate: today,
      notes: `DEMO · caso ${key}`,
      items: [{ productId: product.id, ...item }],
    });
    const order = await api.post(`/sales/quotations/${quotation.id}/confirm`, {});
    const detail = await api.get(`/sales/orders/${order.id}`);
    const opId = detail.reservations.find((r) => r.productionOrderId)?.productionOrderId;
    if (!opId) throw new Error(`${key}: confirmar no dejó OP`);
    for (const c of coils) await api.post(`/production/roofing/${opId}/coils`, { coilId: c.id });
    const op = await api.get(`/production/${opId}`);
    return {
      key,
      quotation: quotation.code,
      order: detail.code,
      orderId: order.id,
      op: op.code,
      opId,
      coils,
    };
  }
  const report = (c, body) => api.post(`/production/roofing/${c.opId}/report`, body);
  const draft = (c, body) => api.post(`/production/roofing/${c.opId}/drafts`, body);
  const { sheet, custom, accessory } = masters.products;
  const { red, white, galv } = masters.finishes;
  const roofing = 'metallic-roofing';
  const cases = [];

  // P1 · plancha nueva: 40 planchas en 3 bobinas; la 3 se llena sola con todo (D-575).
  const p1 = await orderFor(
    'P1',
    sheet,
    { qty: '40', valuePerMeterPen: '22.0000' },
    await buyCoils(roofing, red, '0.40', ['236', '220', '500'], 'caso P1'),
  );
  cases.push({
    ...p1,
    probar:
      '1 y 2 rinden de más (nota azul) y se terminan; la 3 llena sola sin confirmar; cerrar pide «Confirmo que salieron»',
  });

  // P2 · plancha a medio camino: 12 + 12 registradas y 8 en borrador.
  const p2 = await orderFor(
    'P2',
    sheet,
    { qty: '32', valuePerMeterPen: '22.0000' },
    await buyCoils(roofing, red, '0.40', ['300', '301', '302'], 'caso P2'),
  );
  await report(p2, { coilId: p2.coils[0].id, pieces: pieces([4, 12]) });
  await report(p2, { coilId: p2.coils[1].id, pieces: pieces([4, 12]) });
  await draft(p2, { coilId: p2.coils[2].id, pieces: pieces([4, 8]) });
  cases.push({
    ...p2,
    probar:
      'barra en tres tramos; 1 plancha más en la bobina 1 → «Excede el plan» (D-574); cerrar con el plan completo',
  });

  // M1 · a medida nueva: 6 largos, 4 bobinas; la 2 (95 kg) pasa el 1 % y el cierre el 10 %.
  const m1 = await orderFor(
    'M1',
    custom,
    {
      qty: '132.000',
      unitPricePen: '22.0000',
      pieces: pieces([2.5, 10], [3, 8], [3.5, 6], [4, 6], [4.5, 4], [5, 4]),
    },
    await buyCoils(roofing, white, '0.40', ['400', '95', '230', '303'], 'caso M1'),
  );
  cases.push({
    ...m1,
    probar:
      'bobina 2 con 2,50 × 10 → casilla del 1 %; bobina 3 con 230 kg consumidos → despunte > 10 % pide motivo al cerrar',
  });

  // M2 · a medida a medio camino: 2 bobinas registradas, 1 en borrador, la 4 llena sola.
  const m2 = await orderFor(
    'M2',
    custom,
    { qty: '100.000', unitPricePen: '22.0000', pieces: pieces([3, 10], [4, 10], [5, 6]) },
    await buyCoils(roofing, white, '0.40', ['304', '305', '306', '307'], 'caso M2'),
  );
  await report(m2, { coilId: m2.coils[0].id, pieces: pieces([3, 10]) });
  await report(m2, { coilId: m2.coils[1].id, pieces: pieces([4, 5]) });
  await draft(m2, { coilId: m2.coils[2].id, pieces: pieces([4, 5]) });
  cases.push({
    ...m2,
    probar:
      'bloque 4 «Llenado solo · sin confirmar»; «Registrar producción» manda solo el borrador; «Vaciar» → falta 30 m',
  });

  // A1 · accesorio nuevo: 60 m en 3 bobinas, con 20 m en el borrador del servidor (D-591).
  const a1 = await orderFor(
    'A1',
    accessory,
    { qty: '60.000', unitPricePen: '15.0000' },
    await buyCoils(roofing, white, '0.25', ['50', '51', '100'], 'caso A1'),
  );
  await draft(a1, { coilId: a1.coils[0].id, meters: '20.000' });
  cases.push({
    ...a1,
    probar:
      'bobina 1 con 20 m en el borrador del servidor (se ve desde otro navegador); bobina 2: 20 m; la 3 llena sola',
  });

  // A2 · accesorio casi completo: 27 de 30 m registrados.
  const a2 = await orderFor(
    'A2',
    accessory,
    { qty: '30.000', unitPricePen: '15.0000' },
    await buyCoils(roofing, white, '0.25', ['80', '52'], 'caso A2'),
  );
  await report(a2, { coilId: a2.coils[0].id, meters: '27.000' });
  cases.push({
    ...a2,
    probar: '4 m en la bobina 2 → «Excede el plan en 1.000 m» (D-574); con 3 m cierra exacto',
  });

  // Drywall: dos bobinas; la 1 cortada en 5 flejes de 244 mm (parante) y recibida, la 2 libre.
  const [dw1, dw2] = await buyCoils('drywall', galv, '0.45', ['2500', '2000'], 'drywall');
  const cutting = await api.post('/cutting', {
    supplierId: masters.cuttingSupplier.id,
    notes: 'DEMO · flejes para el parante',
    coils: [
      {
        coilId: dw1.id,
        widthPlanMm: [{ widthMm: '244', stripsCount: 5 }],
        expectedKerfLossMm: '0',
      },
    ],
  });
  await api.post(`/cutting/${cutting.id}/coils/${dw1.id}/receive`, {
    receivedWidthsMm: [{ widthMm: '244', stripsCount: 5 }],
    receivedWeightKg: '2500',
    kerfLossMm: '0',
  });
  return { cases, drywall: { cuttingId: cutting.id, cut: dw1, free: dw2 } };
}

export function casesTable({ cases, drywall }, masters) {
  const lines = [
    '| Caso | Pedido | OP | Abrir | Qué probar |',
    '|---|---|---|---|---|',
    ...cases.map(
      (c) =>
        `| ${c.key} | ${c.order} | ${c.op} | ${PREVIEW_WEB}/planta?op=${c.opId} | ${c.probar} |`,
    ),
    `| Drywall | — | — | ${PREVIEW_WEB}/corte/${drywall.cuttingId} | ${drywall.cut.code} cortada en 5 flejes de 244 mm (${masters.products.stud.sku}); ${drywall.free.code} libre para tu orden de corte con ${DEMO.cuttingSupplier.name}; perfiles en «Nueva orden de perfiles» (${PREVIEW_WEB}/planta) |`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

export async function seedEscenarios(env = process.env, { log = console.log } = {}) {
  const url = assertEscenariosDb(escenariosDbUrl(env));
  const port = apiPort(env);
  if ((env.ESCENARIOS_DATABASE_URL ?? '').trim() === '') {
    log('1/5 Postgres local (docker compose)…');
    run('docker', ['compose', 'up', '-d', '--wait', 'db'], { inherit: true });
  }
  log('2/5 Migraciones, seed y la cuenta de la vista previa en ayr_local…');
  prepareDatabase(url);
  log(`3/5 Compilando y levantando la API en :${String(port)}…`);
  const server = await startApi(url, port);
  try {
    const api = createClient(server.base);
    await api.login();
    const masters = await ensureMasters(api);
    log('4/5 Anulando los casos DEMO anteriores…');
    const failures = await voidPrevious(api, masters);
    log('5/5 Sembrando los casos…');
    const seeded = await seedCases(api, masters);
    log('');
    log(casesTable(seeded, masters));
    log('');
    log(
      `Entra en ${PREVIEW_WEB} con ${LOCAL_VIEWER_EMAIL} (la contraseña está en scripts/local-docker-env.mjs).`,
    );
    if (failures.length > 0) {
      log(`\nNo se pudo anular (queda como historia, no estorba a los casos nuevos):`);
      for (const f of failures) log(`- ${f}`);
    }
    return { seeded, failures };
  } finally {
    await server.stop();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await seedEscenarios();
}
