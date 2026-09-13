import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getJson, postJson } from '../helpers/api';
import { balanceOf, postExpectingError, type ProductionOrderDto } from '../helpers/production';
import { createCustomer } from '../helpers/sales';
import {
  mountCoil,
  pieces,
  purgeRoofingTrail,
  quoteAndOrderLines,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * D-191 (F8-S3/M3) — el borrador de reportes por orden, por API.
 *
 * Lo que protege, en una línea: **nada del borrador mueve kardex ni reserva hasta ejecutarlo,
 * y ejecutarlo es todo o nada**. La validación del ingreso (contra lo reportado más lo que el
 * borrador ya ocupa) y la del commit (dentro de la transacción, porque el estado pudo cambiar)
 * son la misma, y los errores nombran la fila.
 *
 * Aritmética a mano: 1 000 mm × 0.50 mm, densidad 8.0 y el 1 % de D-165 ⇒ 4.04 kg por metro.
 */

const allowWrites = !process.env.E2E_BASE_URL;
test.skip(!allowWrites, 'Crea compras, bobinas y producción: nunca contra producción (D-126).');
test.describe.configure({ timeout: 240_000 });

interface DraftDto {
  id: string;
  rowNumber: number;
  coilId: string;
  coilCode: string;
  pieces: { lengthMm: string; qty: number }[];
  meters: string;
  theoreticalKg: string;
  consumedKg: string | null;
}

const draftsPath = (opId: string) => `/api/production/roofing/${opId}/drafts`;

async function setup(api: APIRequestContext) {
  const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
  const customer = await createCustomer(api);
  // Plan: 10 × 4 m = 40 m ⇒ 161.6 kg.
  const { quotation, order } = await quoteAndOrderLines(api, {
    customerId: customer.id,
    lines: [{ productId: scenario.product.id, rows: pieces([4, 10]) }],
  });
  const opId = order.reservations[0]!.productionOrderId!;
  const trail: Parameters<typeof purgeRoofingTrail>[1] = {
    supplierId: scenario.supplier.id,
    finishId: scenario.finish.id,
    colorId: scenario.color.id,
    productIds: [scenario.product.id],
    coilIds: [scenario.coil.id],
    purchaseIds: [scenario.purchaseId],
    productionOrderIds: [opId],
    orderIds: [order.id],
    quotationIds: [quotation.id],
  };
  return { scenario, order, opId, trail };
}

test.describe('D-191 — borrador de reportes por orden (API)', () => {
  let api: APIRequestContext;
  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });
  test.afterAll(async () => {
    await api.dispose();
  });

  test('ingresar, corregir y quitar filas no mueve nada; ejecutar graba todo en orden y vacía el borrador', async () => {
    const { scenario, opId, trail } = await setup(api);
    try {
      // Sin bobina montada no hay borrador: la orden todavía no se inició.
      const notStarted = await postExpectingError(api, draftsPath(opId), {
        pieces: pieces([4, 2]),
      });
      expect(notStarted.message).toMatch(/todavía no tiene bobina montada/);

      await mountCoil(api, opId, { coilId: scenario.coil.id });

      // Fila 1 (4 × 4 m = 16 m) con kg declarado; fila 2 (3 × 4 m = 12 m).
      await postJson<DraftDto[]>(api, draftsPath(opId), {
        pieces: pieces([4, 4]),
        consumedKg: '70',
      });
      let drafts = await postJson<DraftDto[]>(api, draftsPath(opId), { pieces: pieces([4, 3]) });
      expect(drafts.map((d) => [d.rowNumber, d.meters, d.theoreticalKg, d.consumedKg])).toEqual([
        [1, '16.000', '64.640', '70.000'],
        [2, '12.000', '48.480', null],
      ]);
      expect(drafts[1]!.coilCode).toBe(scenario.coil.code);

      // D-146 contando el borrador: 16 + 12 ya ocupan 28 de 40; 16 m más no entran.
      const overrun = await postExpectingError(api, draftsPath(opId), { pieces: pieces([4, 4]) });
      expect(overrun.status).toBe(400);
      expect(overrun.message).toMatch(
        /el borrador \(28\.000 m\) quedan 12\.000 m y esta fila suma 16\.000 m/,
      );

      // Nada se movió: ni la bobina, ni el producto, ni reportes.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('2000.000');
      const before = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
      expect(before.reports).toHaveLength(0);

      // Una tercera fila entra (28 + 4 = 32) y se quita: el borrador es editable fila por fila.
      drafts = await postJson<DraftDto[]>(api, draftsPath(opId), { pieces: pieces([4, 1]) });
      expect(drafts).toHaveLength(3);
      const removed = await api.delete(`${draftsPath(opId)}/${drafts[2]!.id}`);
      expect(removed.ok()).toBe(true);
      drafts = (await removed.json()) as DraftDto[];
      expect(drafts).toHaveLength(2);

      // Corregir la fila 2 a 6 × 4 m (24 m): 16 + 24 = 40, cubre el plan exacto.
      drafts = await api
        .put(`${draftsPath(opId)}/${drafts[1]!.id}`, { data: { pieces: pieces([4, 6]) } })
        .then((r) => r.json() as Promise<DraftDto[]>);
      expect(drafts.map((d) => d.meters)).toEqual(['16.000', '24.000']);

      // Con el plan cubierto por el borrador, ninguna fila más entra.
      const overPlan = await postExpectingError(api, draftsPath(opId), { pieces: pieces([4, 1]) });
      expect(overPlan.message).toMatch(/el plan ya está cubierto/);

      // El borrador viaja en el batch de /planta, y sobrevive a otra lectura (server-side).
      const batch = await getJson<{ orderId: string; drafts: DraftDto[]; draftMeters: string }[]>(
        api,
        '/api/production/roofing/batch',
      );
      expect(batch.find((o) => o.orderId === opId)).toMatchObject({ draftMeters: '40.000' });

      // --- Ejecutar ---
      const committed = await postJson<ProductionOrderDto>(api, `${draftsPath(opId)}/commit`, {
        idempotencyKey: randomUUID(),
      });
      const active = committed.reports.filter((r) => r.status === 'ACTIVE');
      expect(active.map((r) => [r.metersM, r.consumedKg])).toEqual([
        ['16.000', '70.000'],
        ['24.000', null],
      ]);
      expect(committed.status).toBe('IN_PROGRESS');
      // 40 m ⇒ 161.6 kg fuera de la bobina y 40 m de producto.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1838.400');
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('40.000');
      expect(await getJson<DraftDto[]>(api, draftsPath(opId))).toEqual([]);

      // Con el borrador vacío, ejecutar sin cerrar no tiene sentido.
      const empty = await postExpectingError(api, `${draftsPath(opId)}/commit`, {});
      expect(empty.message).toMatch(/borrador de la orden está vacío/);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('si el estado cambió, ejecutar revalida todo: la fila que ya no entra corta y no entra NINGUNA', async () => {
    const { scenario, opId, trail } = await setup(api);
    try {
      await mountCoil(api, opId, { coilId: scenario.coil.id });
      await postJson(api, draftsPath(opId), { pieces: pieces([4, 5]) }); // 20 m
      await postJson(api, draftsPath(opId), { pieces: pieces([4, 5]) }); // 20 m

      // Achicar el plan por debajo de lo que el borrador ya ocupa se rechaza de entrada.
      const shrink = await api.put(`/api/production/roofing/${opId}/plan`, {
        data: { items: pieces([4, 6]) },
      });
      expect(shrink.status()).toBe(400);
      expect(await shrink.text()).toMatch(/quita o corrige filas del borrador/);

      // Pero el estado igual puede cambiar por debajo: un reporte directo (API o importación)
      // de 8 m deja 32 m libres, y el borrador ocupa 40.
      await postJson(api, `/api/production/roofing/${opId}/report`, { pieces: pieces([4, 2]) });

      const failed = await postExpectingError(api, `${draftsPath(opId)}/commit`, {
        idempotencyKey: randomUUID(),
      });
      expect(failed.status).toBe(400);
      expect(failed.message).toMatch(/^Fila 2: /);

      // Todo o nada: ni la fila 1, que sí entraba, se grabó. Solo está el reporte directo.
      const order = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
      expect(order.reports).toHaveLength(1);
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1967.680');
      expect(await getJson<DraftDto[]>(api, draftsPath(opId))).toHaveLength(2);

      // Cerrar con el borrador cargado tampoco: quedaría huérfano.
      const close = await postExpectingError(api, `/api/production/roofing/${opId}/close`, {});
      expect(close.message).toMatch(/fila\(s\) sin ejecutar en el borrador/);
      // Ni bajar la bobina de la que salen esas filas.
      const withCoil = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
      const release = await postExpectingError(
        api,
        `/api/production/roofing/${opId}/coils/${withCoil.consumptions[0]!.id}/release`,
      );
      expect(release.message).toMatch(/fila\(s\) en el borrador/);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('ejecutar y cerrar es una transacción; el mismo intento dos veces en paralelo graba una sola vez', async () => {
    const { scenario, opId, trail } = await setup(api);
    try {
      await mountCoil(api, opId, { coilId: scenario.coil.id });
      await postJson(api, draftsPath(opId), { pieces: pieces([4, 10]) });

      const idempotencyKey = randomUUID();
      const [a, b] = await Promise.all([
        api.post(`${draftsPath(opId)}/commit`, { data: { close: true, idempotencyKey } }),
        api.post(`${draftsPath(opId)}/commit`, { data: { close: true, idempotencyKey } }),
      ]);
      expect(a.ok(), await a.text()).toBe(true);
      expect(b.ok(), await b.text()).toBe(true);

      const order = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
      expect(order.status).toBe('CLOSED');
      expect(order.reports.filter((r) => r.status === 'ACTIVE')).toHaveLength(1);
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('40.000');
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1838.400');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('los kilos de una bobina se acumulan entre filas, y anular la orden descarta el borrador', async () => {
    // Se montan solo 100 kg: 20 m (80.8 kg) entran; otra fila de 8 m (32.32 kg) ya no.
    const { scenario, opId, trail } = await setup(api);
    try {
      await mountCoil(api, opId, { coilId: scenario.coil.id, qtyKg: '100' });
      await postJson(api, draftsPath(opId), { pieces: pieces([4, 5]) });
      const tooMuch = await postExpectingError(api, draftsPath(opId), { pieces: pieces([4, 2]) });
      expect(tooMuch.message).toMatch(/el borrador ya ocupa 80\.800 kg/);

      const cancelled = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${opId}/cancel`,
        { reason: 'E2E: descartar el borrador con la orden' },
      );
      expect(cancelled.status).toBe('CANCELLED');
      expect(await getJson<DraftDto[]>(api, draftsPath(opId))).toEqual([]);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});
