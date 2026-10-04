import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getJson, postJson } from '../helpers/api';
import {
  createInvoice,
  createInvoiceableCustomer,
  dispatchOrder,
  purgeInvoicingTrail,
  validRuc,
  type FiscalDocumentDto,
  type InvoicingTrail,
} from '../helpers/invoicing';
import { POS_LINE, setupPosStock } from '../helpers/pos';
import { balanceOf, type ProductionOrderDto } from '../helpers/production';
import {
  pieces,
  purgeRoofingTrail,
  quoteAndOrder,
  reservationsOf,
  roofingOrder,
  setupRoofingScenario,
} from '../helpers/roofing';
import { createCustomer, createDirectOrder } from '../helpers/sales';
import { headerAction } from '../helpers/ui';

/**
 * D-383 — proteger la anulación de un pedido.
 *
 * 1. Con un comprobante vivo o un despacho vigente, anular se bloquea: primero se deshace la venta.
 * 2. Con producto fabricado sin despachar (OP cerrada), el diálogo lo lista por línea con su OP y
 *    dice qué pasa; el API exige la casilla y la audita.
 * 3. La alerta «no se puede anular» ya no aparece con la OP cerrada.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea pedidos, producción, despachos y comprobantes: nunca contra producción (D-126).',
);

test.describe.configure({ timeout: 300_000 });

interface AuditEvent {
  action: string;
  after: Record<string, unknown> | null;
}

interface CancelPreview {
  blocks: string[];
  fabricated: {
    lineNumber: number;
    sku: string;
    qty: string;
    unit: string;
    productionOrders: { code: string; status: string }[];
  }[];
  annulledManualDocuments: { id: string; number: string | null }[];
}

function uniqueCorrelative(): number {
  return Number(String(Date.now()).slice(-7));
}

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

test.describe('D-383 — anular un pedido', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('con una orden de producción cerrada: el diálogo lista lo fabricado, exige la casilla y la anulación lo audita', async ({
    page,
  }) => {
    const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      productionOrderIds: [],
      orderIds: [],
      quotationIds: [],
    };
    try {
      // 3 planchas de 4.20 m + 2 de 6.00 m = 24.60 m, fabricadas y sin despachar.
      const rows = pieces([4.2, 3], [6, 2]);
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows,
        unitPricePen: '30',
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];
      const [rawMaterial] = await reservationsOf(api, order.id);
      const op = await roofingOrder(api, rawMaterial!.id);
      trail.productionOrderIds = [op.id];
      await postJson(api, `/api/production/roofing/${op.id}/coils`, { coilId: scenario.coil.id });
      await postJson(api, `/api/production/roofing/${op.id}/report`, { pieces: rows });
      const closed = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${op.id}/close`,
        { consumedKg: '102.000' },
      );
      expect(closed.status).toBe('CLOSED');
      const productBefore = await balanceOf(api, 'PRODUCT', scenario.product.id);
      expect(productBefore.qty).toBe('24.600');

      // La vista previa: lo fabricado de la línea 1 con su OP cerrada, sin bloqueos.
      const preview = await getJson<CancelPreview>(
        api,
        `/api/sales/orders/${order.id}/cancel-preview`,
      );
      expect(preview.blocks).toEqual([]);
      expect(preview.fabricated).toEqual([
        expect.objectContaining({
          lineNumber: 1,
          qty: '24.600',
          unit: 'MTR',
          productionOrders: [{ code: op.code, status: 'CLOSED' }],
        }),
      ]);

      // El API exige la casilla.
      const withoutAck = await api.post(`/api/sales/orders/${order.id}/cancel`, {
        data: { reason: 'sin casilla (E2E D-383)' },
      });
      expect(withoutAck.status()).toBe(409);
      expect(await withoutAck.text()).toContain('tiene producto fabricado sin despachar');

      await loginAsAdmin(page);
      await page.goto(`/pedidos/${order.id}`);
      await expect(page.getByRole('heading', { name: order.code })).toBeVisible();
      // D-383 (3): con la OP cerrada ya no dice que no se puede anular.
      await expect(page.getByText('el pedido no se puede anular hasta revertir')).toHaveCount(0);

      await (await headerAction(page, 'Anular pedido')).click();
      const dialog = page.getByRole('dialog', { name: `Anular ${order.code}` });
      const fabricated = dialog.getByTestId('cancel-fabricated');
      await expect(fabricated).toContainText('Línea 1');
      await expect(fabricated).toContainText('24.6 MTR');
      await expect(fabricated).toContainText(op.code);
      await expect(dialog).toContainText('queda en inventario sin pedido');

      const confirm = dialog.getByRole('button', { name: 'Anular pedido' });
      await dialog.getByLabel('Motivo').fill('El cliente desistió (E2E D-383)');
      // Sin la casilla no deja anular.
      await expect(confirm).toBeDisabled();
      await dialog.getByLabel('Entiendo que lo fabricado queda en inventario sin pedido').check();
      await confirm.click();
      await expect(dialog).toBeHidden({ timeout: 60_000 });

      const cancelled = await getJson<{ status: string }>(api, `/api/sales/orders/${order.id}`);
      expect(cancelled.status).toBe('CANCELLED');
      // Lo fabricado sigue en inventario: anular no toca el kardex.
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('24.600');

      const events = await getJson<{ items: AuditEvent[] }>(
        api,
        `/api/audit?entityType=sales_orders&entityId=${order.id}&pageSize=50`,
      );
      const event = events.items.find((e) => e.action === 'sales.order.cancel');
      expect(event?.after).toMatchObject({
        acknowledgedFabricated: true,
        fabricatedLoose: [
          expect.objectContaining({
            lineNumber: 1,
            qty: '24.600',
            unit: 'MTR',
            productionOrders: [op.code],
          }),
        ],
      });
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('comprobante vivo y despacho vigente bloquean; un borrador de un pedido anulado ya no se registra', async () => {
    const trail: InvoicingTrail = {
      documentIds: [],
      dispatchIds: [],
      orderIds: [],
      productIds: [],
    };
    try {
      const customer = await createInvoiceableCustomer(api, { docNumber: validRuc() });
      const stock = await setupPosStock(api, { qty: '40', unitPrice: '20' });
      trail.purchaseId = stock.purchaseId;
      trail.supplierId = stock.supplier.id;
      trail.productIds!.push(stock.product.id);
      const order = await createDirectOrder(api, {
        customerId: customer.id,
        businessLine: POS_LINE,
        items: [{ productId: stock.product.id, qty: '10', unitPricePen: '50.0000' }],
      });
      trail.orderIds!.push(order.id);
      const line = order.items[0]!;
      const cancelUrl = `/api/sales/orders/${order.id}/cancel`;

      // Comprobante manual vivo: no se anula el pedido.
      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: customer.id,
        salesOrderId: order.id,
        items: [{ salesOrderItemId: line.id, qty: line.qty }],
      });
      trail.documentIds!.push(draft.id);
      const invoice = await postJson<FiscalDocumentDto>(
        api,
        `/api/invoicing/documents/${draft.id}/register-manual`,
        { series: 'F905', correlative: uniqueCorrelative() },
      );
      const byDocument = await api.post(cancelUrl, { data: { reason: 'con comprobante (E2E)' } });
      expect(byDocument.status()).toBe(400);
      expect(await byDocument.text()).toContain(
        `tiene el comprobante ${invoice.number ?? ''} vigente: anúlalo internamente antes de anular el pedido`,
      );
      const preview = await getJson<CancelPreview>(
        api,
        `/api/sales/orders/${order.id}/cancel-preview`,
      );
      expect(preview.blocks).toHaveLength(1);

      // Despacho vigente: tampoco.
      const dispatch = await dispatchOrder(api, {
        salesOrderId: order.id,
        items: [{ salesOrderItemId: line.id, qty: line.qty, weightKg: '25' }],
      });
      trail.dispatchIds!.push(dispatch.id);
      await postJson(api, `/api/invoicing/documents/${invoice.id}/annul`, {
        reason: 'limpieza del caso (E2E D-383)',
      });
      const byDispatch = await api.post(cancelUrl, { data: { reason: 'con despacho (E2E)' } });
      expect(byDispatch.status()).toBe(400);
      expect(await byDispatch.text()).toMatch(/tiene el despacho DES-\d{6} vigente: reviértelo/);

      // Revertido el despacho, el pedido se anula. El aviso de comprobantes manuales anulados
      // sale en la vista previa.
      await postJson(api, `/api/dispatches/${dispatch.id}/reverse`, {
        reason: 'limpieza del caso (E2E D-383)',
      });
      const afterReverse = await getJson<CancelPreview>(
        api,
        `/api/sales/orders/${order.id}/cancel-preview`,
      );
      expect(afterReverse.blocks).toEqual([]);
      expect(afterReverse.annulledManualDocuments.map((d) => d.number)).toEqual([invoice.number]);

      // Un borrador creado antes de anular ya no se registra después.
      const lateDraft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: customer.id,
        salesOrderId: order.id,
        items: [{ salesOrderItemId: line.id, qty: line.qty }],
      });
      trail.documentIds!.push(lateDraft.id);
      const cancelled = await api.post(cancelUrl, { data: { reason: 'ahora sí (E2E D-383)' } });
      expect(cancelled.status()).toBe(201);
      const late = await api.post(`/api/invoicing/documents/${lateDraft.id}/register-manual`, {
        data: { series: 'F905', correlative: uniqueCorrelative() + 1 },
      });
      expect(late.status()).toBe(409);
      expect(await late.text()).toContain(
        'está anulado: este borrador ya no se registra ni se emite',
      );
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });
});
