import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getJson, postJson } from '../helpers/api';
import { putExpectingError, type ProductionOrderDto } from '../helpers/production';
import { createCustomer } from '../helpers/sales';
import {
  mountCoil,
  pieces,
  purgeRoofingTrail,
  quoteAndOrderLines,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * cc35 (ESPEC §3, D-545/D-546): «Ajustar el plan» de una cobertura a medida. El total tiene que
 * dar los mismos metros del plan vigente, ni más ni menos, y un largo no baja de las planchas que
 * ya se reportaron. La regla vale **también en el API**, no solo en pantalla.
 */
const allowWrites = !process.env.E2E_BASE_URL;
test.skip(!allowWrites, 'Crea compras, bobinas y producción: nunca contra producción (D-126).');
test.describe.configure({ timeout: 240_000 });

async function setup(api: APIRequestContext) {
  const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
  const customer = await createCustomer(api);
  // Plan: 10 × 4 m = 40 m.
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

const planPath = (opId: string) => `/api/production/roofing/${opId}/plan`;

test.describe('cc35 — ajustar el plan (API)', () => {
  let api: APIRequestContext;
  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });
  test.afterAll(async () => {
    await api.dispose();
  });

  test('el plan ajustado que no cuadra se rechaza también por API, y un largo no baja de lo reportado', async () => {
    const { scenario, opId, trail } = await setup(api);
    try {
      // 9 × 4 m = 36 m: faltan 4 m.
      const short = await api.put(planPath(opId), { data: { items: pieces([4, 9]) } });
      expect(short.status()).toBe(400);
      expect(await short.text()).toMatch(/faltan 4\.000 m/);

      // 10 × 4 m + 1 × 2 m = 42 m: sobran 2 m.
      const long = await api.put(planPath(opId), { data: { items: pieces([4, 10], [2, 1]) } });
      expect(long.status()).toBe(400);
      expect(await long.text()).toMatch(/sobran 2\.000 m/);

      // Nada cambió.
      let order = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
      expect(order.items.map((i) => [i.lengthMm, i.qty])).toEqual([['4000.00', 10]]);

      // 9 × 4 m + 2 × 2 m = 40 m: cuadra.
      const ok = await api.put(planPath(opId), { data: { items: pieces([4, 9], [2, 2]) } });
      expect(ok.status()).toBe(200);

      // Con 3 planchas de 4 m reportadas, el largo de 4 m no baja de 3 ni se quita.
      await mountCoil(api, opId, { coilId: scenario.coil.id });
      await postJson(api, `/api/production/roofing/${opId}/report`, { pieces: pieces([4, 3]) });
      const below = await putExpectingError(api, planPath(opId), {
        items: pieces([4, 2], [2, 16]),
      });
      expect(below.status).toBe(400);
      expect(below.message).toMatch(
        /4\.00 m ya tiene 3 planchas reportadas: no puede quedar con 2/,
      );

      // Bajar a 3 sí, si el total cuadra: 3 × 4 m + 14 × 2 m = 40 m.
      const down = await api.put(planPath(opId), { data: { items: pieces([4, 3], [2, 14]) } });
      expect(down.status()).toBe(200);
      order = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
      expect(order.items.map((i) => [i.lengthMm, i.qty])).toEqual([
        ['4000.00', 3],
        ['2000.00', 14],
      ]);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});
