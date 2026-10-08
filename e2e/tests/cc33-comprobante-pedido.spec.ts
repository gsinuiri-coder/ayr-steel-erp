import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { DispatchDto, FiscalDocumentDto, SalesOrderDto } from '@ayr/shared';
import { adminApi, createUser, getItems, getJson, postJson } from '../helpers/api';
import { apiAs } from '../helpers/production';
import {
  DISPATCH_LINE,
  createInvoiceableCustomer,
  dispatchOrder,
  freeLine,
  invoiceBody,
  setupOrderScenario,
} from '../helpers/invoicing';
import { createDirectOrder, setupCoilStock } from '../helpers/sales';

/**
 * cc33 N2 y N4 — el comprobante y su pedido.
 *
 * - N2: el alcance del vendedor se revisaba **después** de confirmar el borrador (en `findOne`).
 *   El vendedor de otro pedido recibía 404, pero el borrador, el enlace del despacho y la clave
 *   de idempotencia quedaban escritos, y el borrador ajeno ocupaba el total del pedido.
 * - N4: con solo líneas libres, el comprobante no miraba si el pedido estaba anulado o era de
 *   otro cliente.
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea pedidos y comprobantes: nunca contra producción (D-126).');
test.describe.configure({ timeout: 180_000 });

interface FiscalDocumentListItem {
  id: string;
  status: string;
  createdByName: string | null;
}

test.describe('cc33 — comprobante y pedido', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('N2: el vendedor de otro pedido recibe 404 y no deja nada escrito', async ({ baseURL }) => {
    const [sellerA, sellerB] = await Promise.all([
      createUser(api, 'VENDEDOR', { name: 'Vendedor A cc33' }),
      createUser(api, 'VENDEDOR', { name: 'Vendedor B cc33' }),
    ]);
    const [asA, asB] = await Promise.all([apiAs(baseURL!, sellerA), apiAs(baseURL!, sellerB)]);
    const [customer, stock] = await Promise.all([
      createInvoiceableCustomer(api),
      setupCoilStock(api, { lineCode: DISPATCH_LINE, weightKg: '500' }),
    ]);
    // El pedido es del vendedor A: lo crea él (pedido directo, D-240).
    const order = await createDirectOrder(asA, {
      customerId: customer.id,
      businessLine: DISPATCH_LINE,
      items: [{ saleCoilId: stock.coil.id, qty: stock.coil.availableKg, unitPricePen: '8.0000' }],
    });
    const item = order.items[0]!;
    const dispatch = await dispatchOrder(api, {
      salesOrderId: order.id,
      items: [{ salesOrderItemId: item.id, qty: item.qty }],
    });

    const idempotencyKey = randomUUID();
    const body = {
      ...invoiceBody({
        docType: 'FACTURA',
        customerId: customer.id,
        salesOrderId: order.id,
        items: [{ salesOrderItemId: item.id, qty: item.qty }],
      }),
      dispatchId: dispatch.id,
      idempotencyKey,
    };

    const foreign = await asB.post('/api/invoicing/documents', { data: body });
    expect(foreign.status()).toBe(404);

    // Nada quedó: ni borrador del pedido, ni enlace del despacho.
    const documents = await getItems<FiscalDocumentListItem>(
      api,
      `/api/invoicing/documents?salesOrderId=${order.id}`,
    );
    expect(documents).toHaveLength(0);
    const afterForeign = await getJson<DispatchDto>(api, `/api/dispatches/${dispatch.id}`);
    expect(afterForeign.invoiceId).toBeNull();

    // A factura el total, con la misma clave: la clave de B no quedó tomada.
    const own = await postJson<FiscalDocumentDto>(asA, '/api/invoicing/documents', body);
    expect(own.status).toBe('DRAFT');
    expect(own.totalPen).toBe(order.totalPen);
    expect(own.createdByName).toBe('Vendedor A cc33');
    const linked = await getJson<DispatchDto>(api, `/api/dispatches/${dispatch.id}`);
    expect(linked.invoiceId).toBe(own.id);

    await Promise.all([asA.dispose(), asB.dispose()]);
  });

  test('N4: solo líneas libres sobre un pedido anulado o de otro cliente se rechaza', async () => {
    const scenario = await setupOrderScenario(api, { coilKg: '300' });
    const other = await createInvoiceableCustomer(api);

    // Pedido de otro cliente.
    const foreignCustomer = await api.post('/api/invoicing/documents', {
      data: invoiceBody({
        docType: 'FACTURA',
        customerId: other.id,
        salesOrderId: scenario.order.id,
        items: [freeLine('1', '10.0000', 'flete')],
      }),
    });
    expect(foreignCustomer.status()).toBe(400);
    expect(await foreignCustomer.text()).toContain('clientes distintos');

    // Pedido anulado.
    await postJson<SalesOrderDto>(api, `/api/sales/orders/${scenario.order.id}/cancel`, {
      reason: 'E2E cc33 N4',
    });
    const cancelled = await api.post('/api/invoicing/documents', {
      data: invoiceBody({
        docType: 'FACTURA',
        customerId: scenario.customer.id,
        salesOrderId: scenario.order.id,
        items: [freeLine('1', '10.0000', 'flete')],
      }),
    });
    expect(cancelled.status()).toBe(400);
    expect(await cancelled.text()).toContain('está anulado');
  });
});
