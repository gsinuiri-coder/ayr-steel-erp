// cc42 (D-595): prueba de `pnpm seed:escenarios`. Corre el script **dos veces seguidas** contra
// una base `ayr_local` y verifica por la API que queda un solo juego de casos vivo, con el estado
// que cada caso promete, y que el juego anterior quedó anulado (no borrado: D-592).
//
// Necesita `ESCENARIOS_DATABASE_URL` apuntando a una base `ayr_local` **descartable** (la CI usa
// el Postgres del runner; en la máquina, un contenedor aparte). Contra el `ayr_local` del Docker
// del dueño no corre: lo dejaría con dos juegos anulados de más.
//
// Uso: ESCENARIOS_DATABASE_URL=… pnpm seed:escenarios:test
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ROOT } from './lib.mjs';
import { dbUrl } from './local-docker-env.mjs';
import {
  DEMO,
  DEMO_SKUS,
  apiPort,
  assertEscenariosDb,
  createClient,
  escenariosDbUrl,
  startApi,
} from './seed-escenarios.mjs';

const override = (process.env.ESCENARIOS_DATABASE_URL ?? '').trim();
if (override === '') {
  throw new Error(
    'seed:escenarios:test necesita ESCENARIOS_DATABASE_URL (una ayr_local descartable).',
  );
}
const url = assertEscenariosDb(escenariosDbUrl());
if (new URL(url).port === new URL(dbUrl('ayr_local')).port) {
  throw new Error(
    'seed:escenarios:test no corre contra el Postgres del Docker del dueño (puerto 5434).',
  );
}

function runSeed(round) {
  const res = spawnSync(process.execPath, [resolve(ROOT, 'scripts/seed-escenarios.mjs')], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`La corrida ${String(round)} falló:\n${res.stdout}\n${res.stderr}`);
  }
  assert.doesNotMatch(
    res.stdout,
    /No se pudo anular/,
    `La corrida ${String(round)} dejó algo sin anular`,
  );
  // cc48: V1 (la venta a crédito) también tiene pedido y OP, cerrada.
  const ops = [
    ...res.stdout.matchAll(/\| (P1|P2|M1|M2|A1|A2|C1|C2|V1) \| (PED-\d+) \| (OP-\d+) \|/g),
  ];
  assert.equal(ops.length, 9, `La corrida ${String(round)} no imprimió los nueve casos`);
  return Object.fromEntries(ops.map((m) => [m[1], m[3]]));
}

/**
 * Revisión cc42: entre corrida y corrida se usan los casos como lo haría el dueño, para que la
 * segunda anule también lo que ya se probó: P2 registrada y cerrada, M2 registrado y una OP de
 * drywall fabricada y cerrada (reabrir, revertir y anular, D-592). cc45: C1 baja a lo registrado y
 * C2 sube, que deja una OP nueva por la diferencia.
 */
async function useCases(ops) {
  const server = await startApi(url, apiPort(), { compile: false });
  try {
    const api = createClient(server.base);
    await api.login();
    const byCode = new Map((await api.list('/production')).map((o) => [o.code, o]));
    const p2 = byCode.get(ops.P2);
    const m2 = byCode.get(ops.M2);
    await api.post(`/production/roofing/${p2.id}/drafts/commit`, {
      close: true,
      idempotencyKey: randomUUID(),
    });
    await api.post(`/production/roofing/${m2.id}/drafts/commit`, { idempotencyKey: randomUUID() });
    const stud = (await api.list('/catalog')).find((p) => p.sku === DEMO_SKUS.stud);
    const strip = (await api.list('/coils?status=OPEN')).find(
      (c) => c.kind === 'STRIP' && c.availableKg !== '0.000',
    );
    const order = await api.post('/production', { productId: stud.id });
    await api.post(`/production/${order.id}/consume`, { coilId: strip.id });
    await api.post(`/production/${order.id}/report`, { pieces: 50, idempotencyKey: randomUUID() });
    await api.post(`/production/${order.id}/close`, { reason: 'Prueba: el resto del fleje queda' });
    const closed = (await api.list('/production')).filter((o) => o.status === 'CLOSED');
    assert.equal(closed.length, 4, 'P2, C2, V1 y la OP de drywall quedaron cerradas');

    const reason = 'El cliente cambió el pedido';
    const lineOf = async (opCode) => {
      const op = byCode.get(opCode);
      const salesOrder = await api.get(`/sales/orders/${op.salesOrderId}`);
      return { orderId: salesOrder.id, item: salesOrder.items[0] };
    };
    const c1 = await lineOf(ops.C1);
    const lowered = await api.patch(`/sales/orders/${c1.orderId}/items/${c1.item.id}/qty`, {
      qty: '101.600',
      pieces: [
        { lengthMm: '6000.00', qty: 10 },
        { lengthMm: '5200.00', qty: 8 },
      ],
      reason,
    });
    assert.equal(lowered.items[0].qty, '101.600', 'C1 bajó a lo registrado');
    const c2 = await lineOf(ops.C2);
    await api.patch(`/sales/orders/${c2.orderId}/items/${c2.item.id}/qty`, {
      qty: '26.000',
      reason,
    });
    const grown = (await api.list(`/production?salesOrderId=${c2.orderId}`)).filter(
      (o) => o.status === 'DRAFT',
    );
    assert.equal(grown.length, 1, 'C2: nació una OP por la diferencia');
    assert.equal(grown[0].planMeters, '6.000', 'C2: la OP nueva fabrica 6 m');
    return { drywall: order.code, extra: grown[0].code };
  } finally {
    await server.stop();
  }
}

const first = runSeed(1);
console.log('Corrida 1:', JSON.stringify(first));
const used = await useCases(first);
const second = runSeed(2);
console.log('Corrida 2:', JSON.stringify(second));
for (const key of Object.keys(first)) assert.notEqual(first[key], second[key], `${key} repitió OP`);

const server = await startApi(url, apiPort(), { compile: false });
try {
  const api = createClient(server.base);
  await api.login();
  const skus = new Set(Object.values(DEMO_SKUS));
  const ops = (await api.list('/production')).filter((o) => skus.has(o.productSku));
  const live = ops.filter((o) => o.status !== 'CANCELLED');
  assert.deepEqual(
    live.map((o) => o.code).sort(),
    Object.values(second).sort(),
    'Las OP DEMO vivas tienen que ser exactamente las de la última corrida',
  );
  for (const code of [...Object.values(first), used.drywall, used.extra]) {
    assert.equal(ops.find((o) => o.code === code)?.status, 'CANCELLED', `${code} no quedó anulada`);
  }

  const byKey = Object.fromEntries(
    Object.entries(second).map(([key, code]) => [key, live.find((o) => o.code === code)]),
  );
  const activeReports = async (o) =>
    ((await api.get(`/production/${o.id}`)).reports ?? []).filter((r) => r.status === 'ACTIVE');
  const drafts = (o) => api.get(`/production/roofing/${o.id}/drafts`);
  for (const key of ['P1', 'M1']) {
    assert.equal((await activeReports(byKey[key])).length, 0, `${key} no debería tener partes`);
    assert.equal((await drafts(byKey[key])).length, 0, `${key} no debería tener borrador`);
  }
  for (const key of ['P2', 'M2']) {
    assert.equal((await activeReports(byKey[key])).length, 2, `${key}: dos bobinas registradas`);
    assert.equal((await drafts(byKey[key])).length, 1, `${key}: una bobina en borrador`);
  }
  const a1Drafts = await drafts(byKey.A1);
  assert.equal(a1Drafts.length, 1, 'A1: el borrador del accesorio');
  assert.equal(a1Drafts[0].meters, '20.000', 'A1: 20 m en el borrador del servidor');
  assert.equal((await activeReports(byKey.A2)).length, 1, 'A2: 27 m registrados');

  const customer = (await api.list(`/customers?search=${DEMO.customer.docNumber}`)).find(
    (c) => c.docNumber === DEMO.customer.docNumber,
  );
  const orders = (await api.list('/sales/orders')).filter((o) => o.customerId === customer.id);
  assert.equal(
    orders.filter((o) => o.status !== 'CANCELLED').length,
    9,
    'nueve pedidos vivos (con V1, cc48)',
  );

  const suppliers = await api.list('/suppliers');
  const supplierIds = new Set(
    suppliers
      .filter((s) => [DEMO.steelSupplier.code, DEMO.cuttingSupplier.code].includes(s.code))
      .map((s) => s.id),
  );
  const purchases = (await api.list('/purchases')).filter((p) => supplierIds.has(p.supplierId));
  assert.equal(
    purchases.filter((p) => p.status !== 'CANCELLED').length,
    11,
    'once compras vivas (con V1, cc48)',
  );

  const cuts = (await api.list('/cutting')).filter((o) => supplierIds.has(o.supplierId));
  assert.equal(cuts.filter((o) => o.status === 'RECEIVED').length, 1, 'un corte recibido vivo');
  const coils = (await api.list('/coils?status=OPEN')).filter((c) => supplierIds.has(c.supplierId));
  const strips = coils.filter((c) => c.kind === 'STRIP' && Number.parseFloat(c.availableKg) > 0);
  assert.equal(strips.length, 5, 'cinco flejes en stock');
  const free = coils.filter(
    (c) => c.kind !== 'STRIP' && c.availableKg === '2000.000' && c.thicknessMm === '0.45',
  );
  assert.equal(free.length, 1, 'la bobina de drywall libre (2 000 kg)');
  // cc46: S1 · un solo partido vivo (el de la corrida 1 se revirtió), con borde y dos hijas.
  const splitChildren = coils.filter((c) => c.splitId !== null);
  assert.equal(splitChildren.length, 2, 'S1: dos hijas vivas del partido');
  assert.equal(new Set(splitChildren.map((c) => c.splitId)).size, 1, 'S1: un solo partido vivo');
  const splits = await api.get(`/coils/${splitChildren[0].parentCoilId}/splits`);
  const s1 = splits.find((s) => s.id === splitChildren[0].splitId);
  assert.equal(s1?.status, 'ACTIVE', 'S1: el partido está vigente');
  assert.equal(s1?.kerfLossKg, '49.180', 'S1: 20 mm de kerf y 40 mm de borde (49.180 kg)');
  console.log('seed:escenarios:test ok: dos corridas, un juego vivo y el anterior anulado.');
} finally {
  await server.stop();
}
