import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, postJson } from '../helpers/api';
import {
  deactivateTrail,
  errorFrom,
  LINE,
  setupScenario,
  type ProductionOrderDto,
} from '../helpers/production';
import {
  createCustomer,
  createQuotationWithLines,
  purgeSalesTrail,
  type SalesOrderDto,
} from '../helpers/sales';

/**
 * **cc44 — un perfil de drywall se produce a stock y se vende contra ese stock.**
 *
 * - D-598: para confirmar una cotización de un perfil fabricado tiene que haber stock; confirmar
 *   no crea una orden de producción (eso es solo de coberturas, D-186).
 * - D-599: la OP de perfiles no se ata a un pedido: nace sin reserva, como corrida de stock.
 *
 * Escribe cotizaciones, pedidos y producción: nunca contra producción (regla dura 9, D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Escribe cotizaciones y producción: nunca contra producción (D-126).');

let api: APIRequestContext;

test.beforeAll(async ({ baseURL }) => {
  api = await adminApi(baseURL!);
});

test('una cotización de un perfil fabricado no se confirma sin stock y sí después de producirlo a stock (D-598, D-599)', async () => {
  const scenario = await setupScenario(api);
  const customer = await createCustomer(api);
  const productionOrderIds: string[] = [];
  const trail: { orderIds: string[]; quotationIds: string[] } = { orderIds: [], quotationIds: [] };

  try {
    const quote = () =>
      createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: LINE,
        items: [{ productId: scenario.product.id, qty: '30', unitPricePen: '40.0000' }],
      });

    // Sin stock: la cotización se hace, pero confirmarla rebota nombrando el disponible.
    const first = await quote();
    trail.quotationIds.push(first.id);
    const rejected = await errorFrom(
      await api.post(`/api/sales/quotations/${first.id}/confirm`, { data: {} }),
      'confirmar un perfil fabricado sin stock',
    );
    expect(rejected.status).toBe(400);
    expect(rejected.message.toLowerCase()).toContain('disponible');
    expect(rejected.message).toContain(scenario.product.sku);

    // La OP de perfiles es una corrida de stock: sin pedido ni reserva detrás.
    const op = await postJson<ProductionOrderDto>(api, '/api/production', {
      productId: scenario.product.id,
    });
    productionOrderIds.push(op.id);
    expect(op.reservationId).toBeNull();
    expect(op.salesOrderId).toBeNull();
    expect(op.targetPieces).toBeNull();
    await postJson(api, `/api/production/${op.id}/consume`, { coilId: scenario.strips[0]!.id });
    await postJson(api, `/api/production/${op.id}/report`, { pieces: 50 });

    // Con 50 piezas en stock, una cotización nueva confirma y reserva el propio producto.
    const second = await quote();
    trail.quotationIds.push(second.id);
    const order = await postJson<SalesOrderDto>(
      api,
      `/api/sales/quotations/${second.id}/confirm`,
      {},
    );
    trail.orderIds.push(order.id);
    expect(order.reservations).toHaveLength(1);
    expect(order.reservations[0]).toMatchObject({
      itemType: 'PRODUCT',
      itemId: scenario.product.id,
      qty: '30.000',
      status: 'ACTIVE',
      productionOrderId: null,
    });
  } finally {
    await purgeSalesTrail(api, trail);
    await deactivateTrail(api, {
      productionOrderIds,
      cuttingOrderId: scenario.cuttingOrderId,
      motherId: scenario.mother.id,
      purchaseId: scenario.purchaseId,
      supplierId: scenario.supplier.id,
      finish: scenario.finish,
      productId: scenario.product.id,
    });
  }
});
