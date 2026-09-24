import { expect, test, type APIRequestContext } from '@playwright/test';
import { businessToday } from '@ayr/shared';
import { adminApi, createUser, postJson } from '../helpers/api';
import { apiAs, postExpectingError } from '../helpers/production';
import {
  metersOf,
  pieces,
  purgeRoofingTrail,
  ROOFING_LINE,
  setupRoofingScenario,
} from '../helpers/roofing';
import { createCustomer, createQuotation, type QuotationDto } from '../helpers/sales';

/**
 * **D-275 — el criterio de D-267 en los rechazos de reserva.**
 *
 * La invariante del agregado (D-134) rechaza una operación que deja corto lo prometido y nombra a
 * los titulares, entre ellos las reservas temporales («COT-… (reserva temporal)»). Un VENDEDOR
 * llega a ese rechazo al reservar o confirmar la venta de una bobina entera: si otro vendedor
 * tiene una reserva temporal sobre el agregado, el mensaje nombraba su cotización. Regla: a un
 * VENDEDOR, la cotización de otro vendedor se muestra «cotización no disponible»; la suya y
 * cualquier rol no VENDEDOR siguen viendo el código.
 *
 * Escribe cotizaciones y reservas: nunca contra producción (D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 300_000 });

test.describe('D-275 — rechazo de reserva por vendedor', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('B no ve el código de la reserva temporal de A; el administrador sí', async ({
    baseURL,
  }) => {
    const s = await setupRoofingScenario(api, { weightKg: '100' });
    const customer = await createCustomer(api);
    const sellerA = await apiAs(baseURL!, await createUser(api, 'VENDEDOR'));
    const sellerB = await apiAs(baseURL!, await createUser(api, 'VENDEDOR'));
    const quotationIds: string[] = [];
    try {
      // A cotiza una cobertura a medida (promesa genérica del agregado, D-134) y la reserva.
      const rows = pieces([10, 2]); // 20 m ⇒ 80.800 kg del agregado
      const quotationA = await createQuotation(sellerA, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: s.product.id,
        qty: metersOf(rows),
        unitPricePen: '60',
        pieces: rows,
      });
      quotationIds.push(quotationA.id);
      await postJson<QuotationDto>(sellerA, `/api/sales/quotations/${quotationA.id}/reserve`);

      // B cotiza la venta de la bobina entera (D-116) y la quiere reservar: el agregado queda
      // corto contra la reserva temporal de A.
      const quotationB = await postJson<QuotationDto>(sellerB, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: businessToday(),
        items: [{ saleCoilId: s.coil.id, qty: '100.000', unitPricePen: '20.0000' }],
      });
      quotationIds.push(quotationB.id);
      expect(quotationB.items[0]!.reserveItemId).toBe(s.coil.id);

      const forB = await postExpectingError(
        sellerB,
        `/api/sales/quotations/${quotationB.id}/reserve`,
      );
      expect(forB.status).toBe(400);
      expect(forB.message).toContain('cotización no disponible (reserva temporal)');
      expect(forB.message).not.toContain(quotationA.code);

      // El administrador, con el mismo gesto sobre la misma cotización, ve el código.
      const forAdmin = await postExpectingError(
        api,
        `/api/sales/quotations/${quotationB.id}/reserve`,
      );
      expect(forAdmin.status).toBe(400);
      expect(forAdmin.message).toContain(`${quotationA.code} (reserva temporal)`);
    } finally {
      await purgeRoofingTrail(api, {
        quotationIds,
        coilIds: [s.coil.id],
        purchaseIds: [s.purchaseId],
        productIds: [s.product.id],
        supplierId: s.supplier.id,
        finishId: s.finish.id,
        colorId: s.color.id,
      });
      await sellerA.dispose();
      await sellerB.dispose();
    }
  });
});
