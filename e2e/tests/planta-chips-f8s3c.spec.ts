import { expect, test, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getJson } from '../helpers/api';
import { createCustomer, setOrderPriority } from '../helpers/sales';
import {
  createRoofingProduct,
  mountCoil,
  pieces,
  purgeRoofingTrail,
  quoteAndOrder,
  quoteAndOrderLines,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * F8-S3c/M1 y M2 — lo que la franja de chips trae de entrada, sin pasar por una cola
 * separada, y el link a la cotización de origen desde la lista de pedidos.
 *
 * - M1: `/planta?pedido=` muestra **todas** las órdenes del pedido como chips desde que se
 *   entra, iniciadas o no; la que todavía no arrancó lleva su nota de cola (`queueNote`) y la
 *   que ya montó bobina no; el orden respeta la prioridad (D-189);
 * - M2: `/planta` (sin pedido) enlaza, al lado del título de cada tarjeta, la cotización de la
 *   que nació el pedido — y el enlace navega a `/cotizaciones/:id`, no al pedido.
 *
 * Escribe (compras, bobinas, pedidos, producción): nunca contra producción (D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea compras, bobinas y pedidos: nunca contra producción (D-126).');
test.describe.configure({ timeout: 240_000 });

async function loginAsAdmin(page: Page) {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

test.describe('F8-S3c/M1 — la franja de chips trae todas las órdenes del pedido', () => {
  test('sin bobina muestra su nota de cola; con bobina montada, no; y la prioridad reordena los chips', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
    const { product: other } = await createRoofingProduct(api, {
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
    });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id, other.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      orderIds: [],
      quotationIds: [],
    };

    try {
      const { quotation, order } = await quoteAndOrderLines(api, {
        customerId: customer.id,
        lines: [
          { productId: scenario.product.id, rows: pieces([4, 10]) },
          { productId: other.id, rows: pieces([6, 5]) },
        ],
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];
      const [firstId, secondId] = order.reservations.map((r) => r.productionOrderId!);
      expect(firstId).toBeDefined();
      expect(secondId).toBeDefined();

      // La segunda monta su bobina por API: arranca, y con eso deja de estar "en cola".
      const mounted = await mountCoil(api, secondId!, { coilId: scenario.coil.id });
      expect(mounted.status).toBe('IN_PROGRESS');

      await loginAsAdmin(page);
      await page.goto(`/planta?pedido=${order.id}`);
      await expect(page.getByRole('heading', { name: `Producir ${order.code}` })).toBeVisible({
        timeout: 60_000,
      });

      // F8-S3c/M1: las dos son chips desde que se entra, sin ningún paso previo.
      const picker = page.locator('[aria-label="Órdenes del pedido"]');
      const chips = picker.locator('button');
      await expect(chips).toHaveCount(2);
      // Substring plano: el `textContent` del chip no lleva espacio entre el código y el
      // badge de estado que sigue, así que un `\bcode\b` con frontera de cierre no matchea
      // nada (helpers/ui.ts#openQueuedOrder tiene el mismo motivo documentado).
      const chipOf = (code: string) => chips.filter({ hasText: code });

      const firstCode = (await getJson<{ code: string }>(api, `/api/production/${firstId}`)).code;
      const secondCode = (await getJson<{ code: string }>(api, `/api/production/${secondId}`)).code;

      // Sin bobina: sigue "en cola" y el chip lo dice con la nota de cuánto lleva y sus kilos.
      const chipFirst = chipOf(firstCode);
      await expect(chipFirst).toContainText('Sin bobina');
      await expect(chipFirst).toContainText('en cola desde');
      await expect(chipFirst).toContainText('kg teóricos');

      // Con bobina montada: ya arrancó, y el chip deja de mostrar la nota de cola.
      const chipSecond = chipOf(secondCode);
      await expect(chipSecond).toContainText('Lista');
      await expect(chipSecond).not.toContainText('en cola desde');

      // El orden respeta la prioridad (D-189): sin ella, la primera creada va primero.
      const codesInOrder = () =>
        chips.evaluateAll((els) => els.map((e) => e.textContent?.match(/OP-\d+/)?.[0] ?? ''));
      expect(await codesInOrder()).toEqual([firstCode, secondCode]);

      await setOrderPriority(api, secondId!, { priority: true, reason: 'Pasa primero' });
      await page.reload();
      await expect(chips).toHaveCount(2);
      await expect
        .poll(codesInOrder, { message: 'la priorizada pasa a ser la primera' })
        .toEqual([secondCode, firstCode]);
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });
});

test.describe('F8-S3c/M2 — la lista de pedidos enlaza la cotización de origen', () => {
  test('la tarjeta del pedido lleva un link a su cotización, y el link navega a la cotización y no al pedido', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      orderIds: [],
      quotationIds: [],
    };

    try {
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows: pieces([4, 10]),
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];

      await loginAsAdmin(page);
      await page.goto('/planta');
      await expect(page.getByRole('heading', { name: 'Producción', exact: true })).toBeVisible({
        timeout: 60_000,
      });

      const pedidos = page.getByRole('region', { name: 'Pedidos con producción pendiente' });
      const card = pedidos
        .getByRole('link', { name: `Producir ${order.code}`, exact: true })
        .locator('xpath=ancestor::div[@data-slot="card"]');
      await expect(card).toBeVisible();
      const quotationLink = card.getByRole('link', { name: quotation.code, exact: true });
      await expect(quotationLink).toHaveAttribute('href', `/cotizaciones/${quotation.id}`);

      await quotationLink.click();
      await expect(page).toHaveURL(new RegExp(`/cotizaciones/${quotation.id}$`));
      await expect(page.getByRole('heading', { name: quotation.code, level: 1 })).toBeVisible({
        timeout: 60_000,
      });
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });
});
