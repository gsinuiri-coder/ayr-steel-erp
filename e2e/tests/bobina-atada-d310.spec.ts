import { expect, test, type APIRequestContext } from '@playwright/test';
import type { QuotationDuplicateDto } from '@ayr/shared';
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

      // 5. D-322: duplicar la primera (sigue abierta) **crea** la copia, pero la bobina no se vuelve
      // a vender: la línea viaja como el producto BOB… sin bobina, con su aviso.
      const duplicate = await postJson<QuotationDuplicateDto>(
        api,
        `/api/sales/quotations/${first.id}/duplicate`,
      );
      trail.quotationIds.push(duplicate.id);
      expect(duplicate.warnings).toHaveLength(1);
      expect(duplicate.warnings[0]).toContain(s.coil.code);
      expect(duplicate.warnings[0]).toContain(`sigue atada a ${first.code}`);
      expect(duplicate.items).toHaveLength(1);
      expect(duplicate.items[0]?.reserveItemType).not.toBe('COIL');
      expect(duplicate.items[0]?.productSku).toMatch(/^BOB/);
      // La copia no ata la bobina: sigue siendo de la primera.
      expect((await sellableCoils(api)).some((c) => c.coilId === s.coil.id)).toBe(false);

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

  test('D-320: agregar una bobina atada a otra cotización a un pedido confirmado se rechaza', async () => {
    const owned = await setupRoofingScenario(api, { weightKg: '200' });
    const tied = await setupRoofingScenario(api, { weightKg: '150' });
    const customer = await createCustomer(api);
    const trail = {
      supplierId: owned.supplier.id,
      finishId: owned.finish.id,
      colorId: owned.color.id,
      productIds: [owned.product.id],
      coilIds: [owned.coil.id],
      purchaseIds: [owned.purchaseId],
      orderIds: [] as string[],
      quotationIds: [] as string[],
    };
    try {
      // Un pedido confirmado con su propia bobina.
      const quotation = await createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        items: [{ saleCoilId: owned.coil.id, qty: owned.coil.availableKg, unitPricePen: '8' }],
      });
      trail.quotationIds.push(quotation.id);
      const order = await postJson<{ id: string }>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds.push(order.id);

      // Otra cotización abierta ata la segunda bobina.
      const other = await createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        items: [{ saleCoilId: tied.coil.id, qty: tied.coil.availableKg, unitPricePen: '8' }],
      });
      trail.quotationIds.push(other.id);

      const add = await api.post(`/api/sales/orders/${order.id}/items`, {
        data: {
          items: [{ saleCoilId: tied.coil.id, qty: tied.coil.availableKg, unitPricePen: '8.0000' }],
        },
      });
      expect(add.status()).toBe(400);
      expect(await add.text()).toContain(`atada a ${other.code}`);

      // Anulada la otra cotización, la bobina se puede agregar.
      await postJson(api, `/api/sales/quotations/${other.id}/cancel`, {
        reason: 'Liberar la bobina para la prueba de D-320',
      });
      const ok = await api.post(`/api/sales/orders/${order.id}/items`, {
        data: {
          items: [{ saleCoilId: tied.coil.id, qty: tied.coil.availableKg, unitPricePen: '8.0000' }],
        },
      });
      expect(ok.ok(), await ok.text()).toBe(true);
    } finally {
      await purgeRoofingTrail(api, trail);
      await purgeRoofingTrail(api, {
        supplierId: tied.supplier.id,
        finishId: tied.finish.id,
        colorId: tied.color.id,
        productIds: [tied.product.id],
        coilIds: [tied.coil.id],
        purchaseIds: [tied.purchaseId],
      });
    }
  });
});
