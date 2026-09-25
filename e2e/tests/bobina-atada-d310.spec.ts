import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getJson, postJson } from '../helpers/api';
import { purgeRoofingTrail, ROOFING_LINE, setupRoofingScenario } from '../helpers/roofing';
import {
  createCustomer,
  createQuotationWithLines,
  sellableCoils,
  updateQuotationBody,
} from '../helpers/sales';

/**
 * D-310 — una bobina atada a otra cotización abierta no se ofrece ni se deja vender en otra.
 *
 * Hallazgo de la guía de revisión: `GET /sales/sellable-coils` ofrecía una bobina que otra
 * cotización ya vendía entera (sin reservarla), mientras el pool de venta (`coilPoolFor`) sí la
 * excluía. El vendedor la elegía en la segunda cotización y el choque aparecía recién al
 * confirmar. Ahora la lista, el «no se ofrecen» y el guardado comparten una sola regla.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 120_000 });

interface UnavailableCoil {
  coilId: string;
  reason: string;
}

test.describe('D-310 — bobina atada a otra cotización', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('la lista la oculta, «no se ofrecen» la explica y el guardado la rechaza, hasta que se anula la primera', async () => {
    const s = await setupRoofingScenario(api, { weightKg: '200' });
    const customer = await createCustomer(api);
    const trail = {
      supplierId: s.supplier.id,
      finishId: s.finish.id,
      colorId: s.color.id,
      productIds: [s.product.id],
      coilIds: [s.coil.id],
      purchaseIds: [s.purchaseId],
      orderIds: [] as string[],
      quotationIds: [] as string[],
    };
    const line = { saleCoilId: s.coil.id, qty: s.coil.availableKg, unitPricePen: '8' };
    try {
      const first = await createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        items: [line],
      });
      trail.quotationIds.push(first.id);

      // 1. La lista de vendibles ya no la ofrece…
      expect((await sellableCoils(api)).some((c) => c.coilId === s.coil.id)).toBe(false);
      // …y «no se ofrecen» dice de quién es, con el mismo vocabulario que el pool.
      const unavailable = await getJson<UnavailableCoil[]>(
        api,
        '/api/sales/sellable-coils/unavailable',
      );
      expect(unavailable.find((c) => c.coilId === s.coil.id)?.reason).toBe(`atada a ${first.code}`);

      // 2. La propia cotización que se edita sí la sigue viendo (su promesa), y otra id no.
      const own = await getJson<{ coilId: string }[]>(
        api,
        `/api/sales/sellable-coils?excludeQuotationId=${first.id}`,
      );
      expect(own.some((c) => c.coilId === s.coil.id)).toBe(true);
      const ownUnavailable = await getJson<UnavailableCoil[]>(
        api,
        `/api/sales/sellable-coils/unavailable?excludeQuotationId=${first.id}`,
      );
      expect(ownUnavailable.find((c) => c.coilId === s.coil.id)).toBeUndefined();

      // 3. Editar la propia cotización con su bobina no se bloquea a sí misma.
      const saved = await api.put(`/api/sales/quotations/${first.id}`, {
        data: updateQuotationBody({ customerId: customer.id, items: [line] }),
      });
      expect(saved.status(), await saved.text()).toBeLessThan(300);

      // 4. Una segunda cotización con la misma bobina se rechaza en el servidor.
      const second = await api.post('/api/sales/quotations', {
        data: updateQuotationBody({ customerId: customer.id, items: [line] }),
      });
      expect(second.status()).toBe(400);
      expect(await second.text()).toMatch(new RegExp(`no se puede vender: atada a ${first.code}`));

      // 5. Duplicar la primera (sigue abierta) tampoco la vende dos veces.
      const duplicate = await api.post(`/api/sales/quotations/${first.id}/duplicate`);
      expect(duplicate.status()).toBe(400);
      expect(await duplicate.text()).toMatch(/atada a COT-/);

      // 6. Anulada la primera, la bobina vuelve a ofrecerse y se puede vender.
      await postJson(api, `/api/sales/quotations/${first.id}/cancel`, {
        reason: 'Liberar la bobina para la prueba de D-310',
      });
      expect((await sellableCoils(api)).some((c) => c.coilId === s.coil.id)).toBe(true);
      const again = await createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        items: [line],
      });
      trail.quotationIds.push(again.id);
      expect(again.items[0]?.reserveItemId).toBe(s.coil.id);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});
