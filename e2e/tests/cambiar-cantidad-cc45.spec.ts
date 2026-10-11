import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getJson, postJson } from '../helpers/api';
import { loginAsAdmin } from '../helpers/report-fixtures';
import {
  buyRoofingCoil,
  mountCoil,
  pieces,
  purgeRoofingTrail,
  quoteAndOrder,
  reportPieces,
  setupRoofingScenario,
  type RoofingScenario,
} from '../helpers/roofing';
import { createCustomer } from '../helpers/sales';
import { rowAction, saveQtyChange } from '../helpers/ui';

/**
 * cc45 (D-603, D-604, D-605): «Cambiar cantidad» de una línea del pedido con producción, desde
 * el detalle del pedido. Las dos mitades del tablero: bajar a lo registrado y cerrar la orden, y
 * subir con la orden cerrada, que deja una orden nueva por la diferencia que se registra y cierra.
 */

interface ListedOrder {
  id: string;
  code: string;
  status: string;
  planMeters: string | null;
  planMetersReported: string | null;
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
    productionOrderIds: [] as string[],
  };
}

const ordersOf = (api: APIRequestContext, salesOrderId: string) =>
  getJson<ListedOrder[]>(api, `/api/production?salesOrderId=${salesOrderId}`);

test.describe('cc45 — cambiar la cantidad con producción (D-603, D-604)', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('bajar a lo registrado deja la orden lista para cerrar, y cierra', async ({ page }) => {
    const s = await setupRoofingScenario(api, { weightKg: '500' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    try {
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: s.product.id,
        rows: pieces([6, 2], [4, 2]),
      });
      trail.quotationIds.push(quotation.id);
      trail.orderIds.push(order.id);
      const [op] = await ordersOf(api, order.id);
      trail.productionOrderIds.push(op!.id);
      await mountCoil(api, op!.id, { coilId: s.coil.id });
      await reportPieces(api, op!.id, { pieces: pieces([6, 2]), coilId: s.coil.id });

      await loginAsAdmin(page);
      await page.goto(`/pedidos/${order.id}`);
      await expect(page.getByRole('heading', { name: order.code, level: 1 })).toBeVisible({
        timeout: 60_000,
      });
      // La línea muestra su orden y su avance (tablero).
      await expect(page.getByText(/registrado 12\.00 m de 20\.00 m/)).toBeVisible({
        timeout: 30_000,
      });

      await (await rowAction(page, 'línea 1', 'Cambiar cantidad de la línea 1')).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel('Nuevo · 6.00 m')).toHaveValue('2');
      await expect(dialog.getByLabel('Nuevo · 4.00 m')).toHaveValue('2');
      // El piso se ve antes de guardar: 1 plancha de 6 m está por debajo de lo registrado.
      await dialog.getByLabel('Nuevo · 6.00 m').fill('1');
      await expect(dialog.getByTestId('qty-effects')).toContainText('no puede bajar de 2 planchas');
      await dialog.getByRole('button', { name: 'Bajar a lo registrado' }).click();
      await expect(dialog.getByLabel('Nuevo · 4.00 m')).toHaveValue('0');
      await expect(dialog.getByTestId('qty-effects')).toContainText(
        'lista para «Registrar y cerrar»',
        { timeout: 30_000 },
      );
      await expect(dialog.getByTestId('qty-after')).toContainText('12.00 m');
      await saveQtyChange(page, 'El cliente redujo el pedido');
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      await expect(page.getByText(/registrado 12\.00 m de 12\.00 m/)).toBeVisible({
        timeout: 30_000,
      });

      // D-573: con el plan igual a lo registrado, la orden cierra.
      await postJson(api, `/api/production/roofing/${op!.id}/close`, {});
      const [closed] = await ordersOf(api, order.id);
      expect(closed?.status).toBe('CLOSED');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('subir con la orden cerrada crea una orden por la diferencia, que se registra y cierra', async ({
    page,
  }) => {
    const s = await setupRoofingScenario(api, { weightKg: '500' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    try {
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: s.product.id,
        rows: pieces([5, 2]),
      });
      trail.quotationIds.push(quotation.id);
      trail.orderIds.push(order.id);
      const [op] = await ordersOf(api, order.id);
      trail.productionOrderIds.push(op!.id);
      await mountCoil(api, op!.id, { coilId: s.coil.id });
      await reportPieces(api, op!.id, { pieces: pieces([5, 2]), coilId: s.coil.id });
      await postJson(api, `/api/production/roofing/${op!.id}/close`, {});

      await loginAsAdmin(page);
      await page.goto(`/pedidos/${order.id}`);
      await expect(page.getByRole('heading', { name: order.code, level: 1 })).toBeVisible({
        timeout: 60_000,
      });
      await (await rowAction(page, 'línea 1', 'Cambiar cantidad de la línea 1')).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: '+ Otro largo' }).click();
      await dialog.getByLabel('Metros del largo nuevo 1').fill('2');
      await dialog.getByLabel('Nuevo · largo nuevo 1').fill('3');
      await expect(dialog.getByTestId('qty-effects')).toContainText('por la diferencia', {
        timeout: 30_000,
      });
      await expect(dialog.getByTestId('qty-after')).toContainText('16.00 m');
      await saveQtyChange(page);
      await expect(dialog).toBeHidden({ timeout: 30_000 });

      const fresh = (await ordersOf(api, order.id)).find((o) => o.status === 'DRAFT');
      expect(fresh, 'nació la orden por la diferencia').toBeDefined();
      trail.productionOrderIds.push(fresh!.id);
      expect(fresh!.planMeters).toBe('6.000');
      await expect(page.getByText(new RegExp(`${fresh!.code}`)).first()).toBeVisible({
        timeout: 30_000,
      });

      // Lo nuevo se registra en la orden nueva y cierra exacto (D-573).
      const extra = await buyRoofingCoil(api, {
        supplierId: s.supplier.id,
        finishId: s.finish.id,
        colorId: s.color.id,
        weightKg: '200',
      });
      trail.coilIds.push(extra.coil.id);
      trail.purchaseIds.push(extra.purchaseId);
      await mountCoil(api, fresh!.id, { coilId: extra.coil.id });
      await reportPieces(api, fresh!.id, { pieces: pieces([2, 3]), coilId: extra.coil.id });
      await postJson(api, `/api/production/roofing/${fresh!.id}/close`, {});
      const all = await ordersOf(api, order.id);
      expect(all.map((o) => o.status)).toEqual(['CLOSED', 'CLOSED']);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});
