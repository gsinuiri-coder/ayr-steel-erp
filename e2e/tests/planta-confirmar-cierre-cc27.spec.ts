import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, createUser, getJson, postJson, type CreatedUser } from '../helpers/api';
import {
  apiAs,
  balanceOf,
  createCuttingSupplier,
  ROLE_PASSWORD,
  today,
} from '../helpers/production';
import { createCustomer } from '../helpers/sales';
import {
  buyRoofingCoil,
  createColor,
  createRoofingFinish,
  createRoofingProduct,
  mountCoil,
  purgeRoofingTrail,
  reservationsOf,
} from '../helpers/roofing';

/**
 * cc27 / UX26-03 (D-453) — «Ejecutar y cerrar» pide confirmación con un resumen del API.
 *
 * Antes un clic cerraba la orden, movía el kardex y podía terminar la bobina sin decir nada. Ahora
 * el clic abre un diálogo con lo que el cierre va a hacer, calculado por el API corriendo la misma
 * acción en una transacción que se deshace. Lo que este spec fija:
 *
 * - «Volver» deja todo como estaba: kardex, bobina, borrador y orden (la vista previa no escribe);
 * - las cifras del diálogo son las que el kardex registra al confirmar;
 * - un doble clic en «Ejecutar y cerrar» ejecuta una sola vez.
 *
 * Crea compras, bobinas y órdenes: nunca contra producción (D-126, regla dura 9).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos de planta: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 300_000 });

const COIL_KG = '4184';
const WIDTH = '1220';
const THICKNESS = '0.28';
const PIECE_MM = '3600.00';
/** 100 planchas de 3,60 m: unos 994 kg teóricos, dentro de la bobina y de la tolerancia. */
const PIECES = 100;

interface OrderDto {
  id: string;
  code: string;
  status: string;
  reports: { id: string; status: string }[];
}
interface CoilState {
  status: string;
  availableKg: string;
}

interface Scenario {
  supplierId: string;
  finishId: string;
  colorId: string;
  productId: string;
  customerId: string;
  coilIds: string[];
  purchaseIds: string[];
  quotationIds: string[];
  salesOrderIds: string[];
  productionOrderIds: string[];
}

async function setup(api: APIRequestContext): Promise<Scenario> {
  const color = await createColor(api);
  const [supplier, finish, customer] = await Promise.all([
    createCuttingSupplier(api),
    createRoofingFinish(api, { colorId: color.id }),
    createCustomer(api),
  ]);
  const { product } = await createRoofingProduct(api, {
    finishId: finish.id,
    colorId: color.id,
    thicknessMm: THICKNESS,
    catalogWidthMm: WIDTH,
    pieceLengthMm: PIECE_MM,
  });
  return {
    supplierId: supplier.id,
    finishId: finish.id,
    colorId: color.id,
    productId: product.id,
    customerId: customer.id,
    coilIds: [],
    purchaseIds: [],
    quotationIds: [],
    salesOrderIds: [],
    productionOrderIds: [],
  };
}

/** Una bobina, un pedido de planchas y su OP con la bobina montada y una fila en el borrador. */
async function orderWithDraft(
  api: APIRequestContext,
  s: Scenario,
): Promise<{ order: OrderDto; coilId: string; coilCode: string }> {
  const { coil, purchaseId } = await buyRoofingCoil(api, {
    supplierId: s.supplierId,
    finishId: s.finishId,
    colorId: s.colorId,
    weightKg: COIL_KG,
    widthMm: WIDTH,
    thicknessMm: THICKNESS,
  });
  s.coilIds.push(coil.id);
  s.purchaseIds.push(purchaseId);
  const quotation = await postJson<{ id: string }>(api, '/api/sales/quotations', {
    customerId: s.customerId,
    issueDate: today(),
    items: [{ productId: s.productId, qty: String(PIECES), unitPricePen: '120' }],
  });
  s.quotationIds.push(quotation.id);
  const salesOrder = await postJson<{ id: string }>(
    api,
    `/api/sales/quotations/${quotation.id}/confirm`,
    {},
  );
  s.salesOrderIds.push(salesOrder.id);
  const reservation = (await reservationsOf(api, salesOrder.id)).find(
    (r) => r.productionOrderId !== null,
  );
  expect(reservation, 'confirmar no dejó la OP en cola').toBeDefined();
  const orderId = reservation!.productionOrderId!;
  s.productionOrderIds.push(orderId);
  await mountCoil(api, orderId, { coilId: coil.id });
  const added = await api.post(`/api/production/roofing/${orderId}/drafts`, {
    data: { pieces: [{ lengthMm: PIECE_MM, qty: PIECES }], idempotencyKey: randomUUID() },
  });
  expect(added.ok(), await added.text()).toBe(true);
  return {
    order: await getJson<OrderDto>(api, `/api/production/${orderId}`),
    coilId: coil.id,
    coilCode: coil.code,
  };
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

/** «1,234.567 kg» → «1234.567». */
function kgOf(text: string): string {
  return text.replace(/[^\d.]/g, '');
}

test.describe('cc27 / UX26-03 — confirmar «Ejecutar y cerrar»', () => {
  let api: APIRequestContext;
  let supervisor: CreatedUser;
  let s: Scenario;

  test.beforeAll(async ({ baseURL }) => {
    test.setTimeout(180_000);
    api = await adminApi(baseURL!);
    supervisor = await createUser(api, 'SUPERVISOR_PLANTA');
    // `apiAs` cambia la clave temporal: el login de la pantalla entra con ROLE_PASSWORD.
    await (await apiAs(baseURL!, supervisor)).dispose();
    s = await setup(api);
  });

  test.afterAll(async () => {
    test.setTimeout(240_000);
    await purgeRoofingTrail(api, {
      productionOrderIds: s.productionOrderIds,
      orderIds: s.salesOrderIds,
      quotationIds: s.quotationIds,
      coilIds: s.coilIds,
      purchaseIds: s.purchaseIds,
      productIds: [s.productId],
      supplierId: s.supplierId,
      finishId: s.finishId,
      colorId: s.colorId,
    });
    await api.dispose();
  });

  test('«Volver» deja kardex, bobina y orden intactos; confirmar con doble clic ejecuta una vez y registra lo que el resumen dijo', async ({
    page,
  }) => {
    const { order, coilId, coilCode } = await orderWithDraft(api, s);
    const coilBefore = (await balanceOf(api, 'COIL', coilId)).qty;
    expect(coilBefore).toBe('4184.000');

    await login(page, supervisor.email, ROLE_PASSWORD);
    await page.goto(`/planta?op=${order.id}`);
    const panel = page.locator(`#panel-${order.id}`);
    const executeAndClose = panel.getByRole('button', {
      name: `Ejecutar el borrador y cerrar ${order.code}`,
    });
    await expect(executeAndClose).toBeEnabled({ timeout: 60_000 });

    // --- 1. El resumen, y «Volver» ---
    await executeAndClose.click();
    const dialog = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('table', { name: 'Consumo por bobina' }) });
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await expect(dialog).toContainText(order.code);
    const back = dialog.getByRole('button', { name: 'Volver', exact: true });
    await expect(back).toBeFocused();
    const row = dialog.getByRole('row', { name: new RegExp(coilCode) });
    const cells = row.getByRole('cell');
    await expect(cells.nth(1)).toHaveText('4,184.000 kg');
    const consumed = kgOf(await cells.nth(2).innerText());
    const after = kgOf(await cells.nth(3).innerText());
    expect(Number(consumed)).toBeGreaterThan(0);
    await expect(cells.nth(4)).toHaveText('Vuelve al almacén');
    await expect(dialog).toContainText('Bobinas que quedan terminadas: ninguna');

    await back.click();
    await expect(dialog).toBeHidden();
    // La vista previa no escribió nada.
    expect((await balanceOf(api, 'COIL', coilId)).qty).toBe(coilBefore);
    expect((await getJson<CoilState>(api, `/api/coils/${coilId}`)).status).toBe('OPEN');
    const untouched = await getJson<OrderDto>(api, `/api/production/${order.id}`);
    expect(untouched.status).toBe('IN_PROGRESS');
    expect(untouched.reports.filter((r) => r.status === 'ACTIVE')).toHaveLength(0);
    const drafts = await getJson<unknown[]>(api, `/api/production/roofing/${order.id}/drafts`);
    expect(drafts).toHaveLength(1);

    // --- 2. Confirmar con doble clic: una sola ejecución ---
    await executeAndClose.click();
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await dialog.getByRole('button', { name: 'Ejecutar y cerrar', exact: true }).dblclick();
    await expect(page.getByText(`${order.code}: borrador ejecutado y orden cerrada`)).toBeVisible({
      timeout: 60_000,
    });
    await expect(dialog).toBeHidden();

    const closed = await getJson<OrderDto>(api, `/api/production/${order.id}`);
    expect(closed.status).toBe('CLOSED');
    expect(closed.reports.filter((r) => r.status === 'ACTIVE')).toHaveLength(1);
    // Lo que el resumen dijo es lo que el kardex registró.
    const coilAfter = (await balanceOf(api, 'COIL', coilId)).qty;
    expect(coilAfter).toBe(Number(after).toFixed(3));
    expect((Number(coilBefore) - Number(coilAfter)).toFixed(3)).toBe(Number(consumed).toFixed(3));
  });
});
