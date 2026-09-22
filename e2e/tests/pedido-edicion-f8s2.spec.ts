import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, createUser, getJson, postJson } from '../helpers/api';
import {
  createInvoice,
  dispatchOrder,
  DISPATCH_LINE,
  purgeInvoicingTrail,
  setupOrderScenario,
  type InvoicingTrail,
} from '../helpers/invoicing';
import { apiAs, postExpectingError, putJson } from '../helpers/production';
import { chooseProductWithStock, headerAction } from '../helpers/ui';
import {
  metersOf,
  mountCoil,
  pieces,
  purgeRoofingTrail,
  reportPieces,
  reservationsOf,
  ROOFING_LINE,
  setupRoofingScenario,
  type RoofingScenario,
} from '../helpers/roofing';
import {
  createCustomer,
  createQuotation,
  patchExpectingError,
  setupCoilStock,
  stockPanel,
  updateQuotationBody,
  type QuotationDto,
  type SalesOrderDto,
} from '../helpers/sales';

/**
 * F8-S2/M4 — editar un pedido confirmado hasta su comprobante (D-187).
 *
 * Geometría de prueba: 4.04 kg/m (ver `flujo-comercial-f8s2.spec.ts`), así que una línea de
 * 10 m son 40.400 kg del agregado.
 *
 * Escribe cotizaciones, pedidos, órdenes, despachos y comprobantes en borrador: nunca contra
 * producción (regla dura 9).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 240_000 });

interface PriceChange {
  lineNumber: number;
  beforeUnitValuePen: string;
  afterUnitValuePen: string;
  changedByName: string | null;
}

type EditableOrder = SalesOrderDto & { priceChanges: PriceChange[]; isEditable: boolean };
type QuotationWithChanges = QuotationDto & { priceChanges: PriceChange[] };

async function patchJson<T>(api: APIRequestContext, path: string, data: unknown): Promise<T> {
  const res = await api.patch(path, { data });
  if (!res.ok()) throw new Error(`PATCH ${path} → ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

async function availableKg(api: APIRequestContext, s: RoofingScenario): Promise<string> {
  const panel = await stockPanel(api, { businessLine: ROOFING_LINE, productIds: [s.product.id] });
  return panel.products.find((p) => p.productId === s.product.id)?.rawMaterialAvailableKg ?? '';
}

function trailOf(s: RoofingScenario) {
  return {
    supplierId: s.supplier.id,
    finishId: s.finish.id,
    colorId: s.color.id,
    productIds: [s.product.id],
    coilIds: [s.coil.id],
    purchaseIds: [s.purchaseId],
    orderIds: [] as string[],
    quotationIds: [] as string[],
  };
}

test.describe('F8-S2 — edición del pedido confirmado (D-187)', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('D-187: cada cambio de precio —en la cotización y en el pedido— queda registrado, con piso y solo ADMINISTRADOR', async ({
    baseURL,
  }) => {
    const s = await setupRoofingScenario(api, { weightKg: '500' });
    const customer = await createCustomer(api);
    const otherCustomer = await createCustomer(api);
    const trail = trailOf(s);
    const seller = await createUser(api, 'VENDEDOR');
    const sellerApi = await apiAs(baseURL!, seller);
    try {
      const rows = pieces([10, 1]);
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: s.product.id,
        qty: metersOf(rows),
        unitPricePen: '60',
        pieces: rows,
      });
      trail.quotationIds.push(quotation.id);

      // Editar la cotización con otro precio deja una fila; volver a guardar igual, ninguna.
      const edited = await putJson<QuotationWithChanges>(
        api,
        `/api/sales/quotations/${quotation.id}`,
        updateQuotationBody({
          customerId: customer.id,
          items: [
            { productId: s.product.id, qty: metersOf(rows), unitPricePen: '65', pieces: rows },
          ],
        }),
      );
      expect(edited.priceChanges).toEqual([
        expect.objectContaining({
          lineNumber: 1,
          beforeUnitValuePen: '60.0000',
          afterUnitValuePen: '65.0000',
        }),
      ]);
      expect(edited.priceChanges[0]!.changedByName).not.toBeNull();
      const same = await putJson<QuotationWithChanges>(
        api,
        `/api/sales/quotations/${quotation.id}`,
        updateQuotationBody({
          customerId: customer.id,
          items: [
            { productId: s.product.id, qty: metersOf(rows), unitPricePen: '65', pieces: rows },
          ],
        }),
      );
      expect(same.priceChanges).toHaveLength(1);

      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds.push(order.id);
      const item = order.items[0]!;

      // El vendedor no cambia el precio de un pedido confirmado.
      const forbidden = await patchExpectingError(
        sellerApi,
        `/api/sales/orders/${order.id}/items/${item.id}/price`,
        { unitPricePen: '70' },
      );
      expect(forbidden.status).toBe(403);

      // Por debajo del piso, ni el administrador (D-163).
      const belowFloor = await patchExpectingError(
        api,
        `/api/sales/orders/${order.id}/items/${item.id}/price`,
        { unitPricePen: '0.0100' },
      );
      expect(belowFloor.status).toBe(400);
      expect(belowFloor.message).toContain('mínimo');

      const repriced = await patchJson<EditableOrder>(
        api,
        `/api/sales/orders/${order.id}/items/${item.id}/price`,
        { unitPricePen: '70' },
      );
      expect(repriced.isEditable).toBe(true);
      expect(repriced.items[0]).toMatchObject({ unitPricePen: '70.0000', subtotalPen: '700.0000' });
      expect(repriced.subtotalPen).toBe('700.0000');
      expect(repriced.totalPen).toBe('826.0000');
      expect(repriced.priceChanges).toEqual([
        expect.objectContaining({
          lineNumber: 1,
          beforeUnitValuePen: '65.0000',
          afterUnitValuePen: '70.0000',
        }),
      ]);

      // El cliente: solo ADMINISTRADOR, con motivo.
      const customerForbidden = await patchExpectingError(
        sellerApi,
        `/api/sales/orders/${order.id}/customer`,
        { customerId: otherCustomer.id, reason: 'Factura a la empresa del cliente' },
      );
      expect(customerForbidden.status).toBe(403);
      const moved = await patchJson<EditableOrder>(api, `/api/sales/orders/${order.id}/customer`, {
        customerId: otherCustomer.id,
        reason: 'Factura a la empresa del cliente',
      });
      expect(moved.customerId).toBe(otherCustomer.id);

      // Agregar ítems: el vendedor que no es dueño del pedido tampoco.
      const addForbidden = await postExpectingError(
        sellerApi,
        `/api/sales/orders/${order.id}/items`,
        {
          items: [
            { productId: s.product.id, qty: metersOf(rows), unitPricePen: '60', pieces: rows },
          ],
        },
      );
      expect([403, 404]).toContain(addForbidden.status);
    } finally {
      await sellerApi.dispose();
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-187: agregar un ítem reserva y genera su OP; la cantidad se ajusta hasta el primer reporte', async () => {
    const s = await setupRoofingScenario(api, { weightKg: '500' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    try {
      const rows = pieces([10, 1]); // 40.400 kg
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: s.product.id,
        qty: metersOf(rows),
        unitPricePen: '60',
        pieces: rows,
      });
      trail.quotationIds.push(quotation.id);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds.push(order.id);
      expect(await availableKg(api, s)).toBe('459.600');

      // Agregar una línea igual: reserva 40.400 kg más y nace con su OP en cola. El mismo
      // envío repetido (misma clave) no agrega dos veces.
      const idempotencyKey = `e2e-add-${Date.now()}`;
      const body = {
        items: [{ productId: s.product.id, qty: metersOf(rows), unitPricePen: '60', pieces: rows }],
        idempotencyKey,
      };
      const grown = await postJson<SalesOrderDto>(api, `/api/sales/orders/${order.id}/items`, body);
      const again = await postJson<SalesOrderDto>(api, `/api/sales/orders/${order.id}/items`, body);
      expect(grown.items).toHaveLength(2);
      expect(again.items).toHaveLength(2);
      expect(grown.items[1]).toMatchObject({ lineNumber: 2, subtotalPen: '600.0000' });
      expect(grown.subtotalPen).toBe('1200.0000');
      expect(await availableKg(api, s)).toBe('419.200');
      const added = (await reservationsOf(api, order.id)).find(
        (r) => r.salesOrderItemId === grown.items[1]!.id && r.status === 'ACTIVE',
      );
      expect(added?.qty).toBe('40.400');
      expect(added?.productionOrderId, 'el ítem agregado nace con su OP').not.toBeNull();

      // La línea 2 pasa a 20 m: la reserva y el plan de su OP siguen a la cantidad nueva.
      const longer = pieces([10, 2]);
      const resized = await patchJson<SalesOrderDto>(
        api,
        `/api/sales/orders/${order.id}/items/${grown.items[1]!.id}/qty`,
        { qty: metersOf(longer), pieces: longer },
      );
      expect(resized.items[1]).toMatchObject({ qty: '20.000', subtotalPen: '1200.0000' });
      expect(await availableKg(api, s)).toBe('378.800');
      const line2 = (await reservationsOf(api, order.id)).find(
        (r) => r.salesOrderItemId === grown.items[1]!.id && r.status === 'ACTIVE',
      );
      expect(line2?.qty).toBe('80.800');
      expect(line2?.productionOrderId).toBe(added?.productionOrderId);
      const op = await getJson<{ items: { lengthMm: string; qty: number }[] }>(
        api,
        `/api/production/${line2!.productionOrderId!}`,
      );
      expect(op.items).toEqual([expect.objectContaining({ lengthMm: '10000.00', qty: 2 })]);

      // Si no alcanza, no cambia nada.
      const tooMuch = pieces([10, 30]);
      const short = await patchExpectingError(
        api,
        `/api/sales/orders/${order.id}/items/${grown.items[1]!.id}/qty`,
        { qty: metersOf(tooMuch), pieces: tooMuch },
      );
      expect(short.status).toBe(400);
      expect(await availableKg(api, s)).toBe('378.800');

      // La línea 1 se produce: con un reporte vigente su cantidad ya no se toca, y el mensaje
      // manda a agregar un ítem.
      const line1 = (await reservationsOf(api, order.id)).find(
        (r) => r.salesOrderItemId === order.items[0]!.id && r.status === 'ACTIVE',
      );
      const line1Op = line1!.productionOrderId!;
      await mountCoil(api, line1Op, { coilId: s.coil.id });
      await reportPieces(api, line1Op, { pieces: pieces([10, 1]), coilId: s.coil.id });
      const reported = await patchExpectingError(
        api,
        `/api/sales/orders/${order.id}/items/${order.items[0]!.id}/qty`,
        { qty: metersOf(longer), pieces: longer },
      );
      expect(reported.status).toBe(400);
      expect(reported.message).toContain('reportes de producción');
      expect(reported.message).toContain('Agrega un ítem');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-187: con despacho parcial se agregan ítems; con comprobante ya no se edita nada', async () => {
    const sc = await setupOrderScenario(api, { coilKg: '100', unitPricePen: '8.0000' });
    const extra = await setupCoilStock(api, { lineCode: DISPATCH_LINE, weightKg: '100' });
    const trail: InvoicingTrail = {
      documentIds: [],
      dispatchIds: [],
      orderIds: [sc.order.id],
      coilIds: [sc.coil.id, extra.coil.id],
      purchaseId: sc.purchaseId,
      supplierId: sc.supplier.id,
      finish: sc.finish,
      productIds: [sc.product.id],
    };
    try {
      const half = await dispatchOrder(api, {
        salesOrderId: sc.order.id,
        items: [{ salesOrderItemId: sc.item.id, qty: '50' }],
      });
      trail.dispatchIds!.push(half.id);

      // La línea despachada en parte no cambia de cantidad (y una bobina entera nunca).
      const coilQty = await patchExpectingError(
        api,
        `/api/sales/orders/${sc.order.id}/items/${sc.item.id}/qty`,
        { qty: '40' },
      );
      expect(coilQty.status).toBe(400);

      // Pero sí se le agrega un ítem, aunque ya haya salido mercadería.
      const grown = await postJson<EditableOrder>(api, `/api/sales/orders/${sc.order.id}/items`, {
        items: [{ saleCoilId: extra.coil.id, qty: extra.coil.availableKg, unitPricePen: '8.0000' }],
      });
      expect(grown.items).toHaveLength(2);
      expect(grown.status).toBe('PARTIALLY_FULFILLED');
      expect(grown.reservations.filter((r) => r.status === 'ACTIVE')).toHaveLength(2);

      // Con un comprobante en borrador sobre el pedido, se acabó la edición.
      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: sc.customer.id,
        salesOrderId: sc.order.id,
        items: [{ salesOrderItemId: sc.item.id, qty: '50' }],
      });
      trail.documentIds!.push(draft.id);
      const locked = await getJson<EditableOrder>(api, `/api/sales/orders/${sc.order.id}`);
      expect(locked.isEditable).toBe(false);
      const price = await patchExpectingError(
        api,
        `/api/sales/orders/${sc.order.id}/items/${sc.item.id}/price`,
        { unitPricePen: '9.0000' },
      );
      expect(price.status).toBe(400);
      expect(price.message).toContain('comprobante');
      const add = await postExpectingError(api, `/api/sales/orders/${sc.order.id}/items`, {
        items: [{ saleCoilId: extra.coil.id, qty: '1', unitPricePen: '8.0000' }],
      });
      expect(add.status).toBe(400);
      expect(add.message).toContain('comprobante');
    } finally {
      await purgeInvoicingTrail(api, trail);
      await purgeInvoicingTrail(api, {
        purchaseId: extra.purchaseId,
        supplierId: extra.supplier.id,
        finish: extra.finish,
      });
    }
  });

  test('D-187: agregar un ítem de coberturas desde la pantalla del pedido', async ({ page }) => {
    const s = await setupRoofingScenario(api, { weightKg: '500' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    try {
      const rows = pieces([10, 1]);
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: s.product.id,
        qty: metersOf(rows),
        unitPricePen: '60',
        pieces: rows,
      });
      trail.quotationIds.push(quotation.id);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds.push(order.id);

      await loginAsAdmin(page);
      await page.goto(`/pedidos/${order.id}`);
      await (await headerAction(page, 'Agregar ítems')).click();
      await expect(
        page.getByRole('heading', { name: `Agregar ítems a ${order.code}` }),
      ).toBeVisible({ timeout: 60_000 });

      // Coberturas exige cotización (RF-31), pero este pedido ya nació de una: la línea de
      // negocio tiene que ofrecerse igual.
      await page.getByLabel('Línea de negocio de la línea 1').click();
      await page.getByRole('option', { name: 'Coberturas Aluzinc' }).click();
      // D-188: el campo de producto abre el picker con stock, no un desplegable de opciones.
      await chooseProductWithStock(page, page.getByLabel('Producto de la línea 1'), s.product.sku);
      await page.getByLabel('Planchas del largo 1 de la línea 1').fill('1');
      await page.getByLabel('Largo 1 de la línea 1 en metros').fill('10');
      await page.getByLabel('Precio unitario de la línea 1').fill('70.80');
      await page.getByRole('button', { name: 'Agregar ítems' }).click();

      await expect(page).toHaveURL(new RegExp(`/pedidos/${order.id}$`), { timeout: 30_000 });
      const detail = await getJson<SalesOrderDto>(api, `/api/sales/orders/${order.id}`);
      expect(detail.items).toHaveLength(2);
      const added = (await reservationsOf(api, order.id)).find(
        (r) => r.salesOrderItemId === detail.items[1]!.id,
      );
      expect(added).toMatchObject({ status: 'ACTIVE', qty: '40.400' });
      expect(added!.productionOrderId).not.toBeNull();
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-187: el administrador cambia el precio desde el pedido y ve el registro', async ({
    page,
  }) => {
    const sc = await setupOrderScenario(api, { coilKg: '100', unitPricePen: '8.0000' });
    const trail: InvoicingTrail = {
      orderIds: [sc.order.id],
      coilIds: [sc.coil.id],
      purchaseId: sc.purchaseId,
      supplierId: sc.supplier.id,
      finish: sc.finish,
      productIds: [sc.product.id],
    };
    try {
      await loginAsAdmin(page);
      await page.goto(`/pedidos/${sc.order.id}`);
      await expect(page.getByRole('heading', { name: sc.order.code, level: 1 })).toBeVisible({
        timeout: 60_000,
      });

      await page.getByRole('button', { name: 'Cambiar precio de la línea 1' }).click();
      const dialog = page.getByRole('dialog');
      // 8.0000 sin IGV son 9.44 con IGV; se sube a 11.80 (10.0000 sin IGV).
      await expect(dialog.getByLabel(/Precio con IGV/)).toHaveValue('9.44');
      await dialog.getByLabel(/Precio con IGV/).fill('11.80');
      await dialog.getByRole('button', { name: 'Guardar precio' }).click();
      await expect(dialog).toBeHidden();

      const changes = page.getByRole('table', { name: 'Cambios de precio' });
      await expect(changes).toBeVisible();
      await expect(changes.getByText('S/ 9.44')).toBeVisible();
      await expect(changes.getByText('S/ 11.80')).toBeVisible();

      const detail = await getJson<EditableOrder>(api, `/api/sales/orders/${sc.order.id}`);
      expect(detail.items[0]!.unitPricePen).toBe('10.0000');
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });
});

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}
