import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, postJson } from '../helpers/api';
import { createCuttingSupplier, postExpectingError, today } from '../helpers/production';
import {
  buyCoilForSale,
  createCustomer,
  type QuotationDto,
  type SalesOrderDto,
} from '../helpers/sales';
import {
  buyRoofingCoil,
  pieces,
  purgeRoofingOrder,
  purgeRoofingTrail,
  quoteAndOrder,
  reservationsOf,
  roofingOrder,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * Fase 7e — bordes de la venta de bobina completa (D-116).
 *
 * `fase7e.spec.ts` prueba que el camino feliz cuadra; este prueba que la custodia que deja
 * una venta directa de bobina **no tiene atajos**: ni una merma, ni un envío a corte, ni
 * montarla en una orden de producción ajena se la pueden llevar por debajo — cada intento
 * se rechaza con 400 y el motivo real, nunca con un 500.
 */

const allowWrites = process.env.E2E_ALLOW_WRITES === '1' || !process.env.E2E_BASE_URL;

test.describe.configure({ timeout: 240_000 });

test.describe('Fase 7e — bordes de la venta de bobina completa', () => {
  test.skip(
    !allowWrites,
    'Escrituras contra producción deshabilitadas: exporta E2E_ALLOW_WRITES=1',
  );

  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('la bobina en custodia por una venta completa no se merma, ni se envía a corte, ni se monta en una OP ajena (D-116)', async () => {
    const cutter = await createCuttingSupplier(api);
    const customer = await createCustomer(api);

    // Caso Drywall: se vende entera y se intenta mermar y enviar a corte.
    const drywall = await buyCoilForSale(api, {
      lineCode: 'drywall',
      weightKg: '400',
      coilStatus: 'OPEN',
    });
    // Caso Metallic Roofing: se vende entera **la bobina de un producto real**, para poder
    // intentar montarla después en la OP de otro pedido de ese mismo producto.
    const roofing = await setupRoofingScenario(api, { weightKg: '600' });

    const trail = {
      productionOrderIds: [] as string[],
      orderIds: [] as string[],
      quotationIds: [] as string[],
      coilIds: [drywall.coil.id, roofing.coil.id],
      purchaseIds: [drywall.purchaseId, roofing.purchaseId],
      productIds: [roofing.product.id],
      supplierId: roofing.supplier.id,
      finishId: roofing.finish.id,
      colorId: roofing.color.id,
    };

    try {
      // -- Drywall: vendida entera, queda en custodia --
      const q1 = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: today(),
        items: [{ saleCoilId: drywall.coil.id, qty: '1', unitPricePen: '6' }],
      });
      trail.quotationIds.push(q1.id);
      await postJson(api, `/api/sales/quotations/${q1.id}/emit`);
      const order1 = await postJson<SalesOrderDto>(api, `/api/sales/quotations/${q1.id}/confirm`);
      trail.orderIds.push(order1.id);

      const merma = await postExpectingError(api, `/api/coils/${drywall.coil.id}/scrap`, {
        qtyKg: '10',
        reason: 'Intento de merma sobre bobina vendida entera',
      });
      expect(merma.status).toBe(400);
      expect(merma.message).toMatch(/reservad/i);

      const corte = await postExpectingError(api, '/api/cutting', {
        supplierId: cutter.id,
        notes: 'Intento de corte sobre bobina vendida entera',
        coils: [
          {
            coilId: drywall.coil.id,
            widthPlanMm: [{ widthMm: '600', stripsCount: 1 }],
            expectedKerfLossMm: '0',
          },
        ],
      });
      expect(corte.status).toBe(400);
      expect(corte.message).toMatch(/reservad/i);

      // -- Metallic Roofing: vendida entera, no se puede montar en la OP de OTRO pedido --
      const q2 = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: today(),
        items: [{ saleCoilId: roofing.coil.id, qty: '1', unitPricePen: '9' }],
      });
      trail.quotationIds.push(q2.id);
      await postJson(api, `/api/sales/quotations/${q2.id}/emit`);
      const order2 = await postJson<SalesOrderDto>(api, `/api/sales/quotations/${q2.id}/confirm`);
      trail.orderIds.push(order2.id);

      // Una OP de coberturas legítima, nacida de OTRO pedido y OTRA bobina (D-084):
      // necesita una bobina que montar, y ahí es donde se intenta colar la que ya se
      // vendió entera.
      const rawCoil = await buyRoofingCoil(api, {
        supplierId: roofing.supplier.id,
        finishId: roofing.finish.id,
        colorId: roofing.color.id,
        weightKg: '500',
      });
      trail.coilIds.push(rawCoil.coil.id);
      trail.purchaseIds.push(rawCoil.purchaseId);

      const rows = pieces([4, 1]);
      const { quotation: q3, order: order3 } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: roofing.product.id,
        coilId: rawCoil.coil.id,
        reserveKg: '40',
        rows,
      });
      trail.quotationIds.push(q3.id);
      trail.orderIds.push(order3.id);
      const reservation3 = (await reservationsOf(api, order3.id))[0]!;
      const op = await roofingOrder(api, reservation3.id);
      trail.productionOrderIds.push(op.id);

      const mount = await postExpectingError(api, `/api/production/roofing/${op.id}/coils`, {
        coilId: roofing.coil.id,
      });
      expect(mount.status).toBe(400);
      expect(mount.message).toMatch(/reservad/i);
    } finally {
      for (const orderId of [...trail.productionOrderIds].reverse()) {
        await purgeRoofingOrder(api, orderId).catch(() => undefined);
      }
      trail.productionOrderIds = [];
      await purgeRoofingTrail(api, trail);
      await api
        .patch(`/api/suppliers/${cutter.id}`, { data: { isActive: false } })
        .catch(() => undefined);
      await api
        .patch(`/api/suppliers/${drywall.supplier.id}`, { data: { isActive: false } })
        .catch(() => undefined);
      await api
        .patch(`/api/finishes/${drywall.finish.id}`, { data: { isActive: false } })
        .catch(() => undefined);
    }
  });
});
