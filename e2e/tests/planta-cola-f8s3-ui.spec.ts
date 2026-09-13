import { expect, test, type Page } from '@playwright/test';
import { adminApi, adminCredentials } from '../helpers/api';
import { createCustomer, isoDaysFromToday, setOrderPriority } from '../helpers/sales';
import {
  createRoofingProduct,
  pieces,
  purgeRoofingTrail,
  quoteAndOrderLines,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * F8-S3 por pantalla: la cola son las órdenes no iniciadas (D-189) y las órdenes viven en el
 * pedido (D-190).
 *
 * - `/planta` muestra la **cola** con la información completa de cada entrada (OP, pedido y
 *   cliente, producto, ML del plan, fecha compromiso, prioridad, vencida), en el orden del
 *   ranking, y un clic abre **esa** orden en el workspace;
 * - `/produccion` salió del menú y redirige al historial dentro de `/planta`;
 * - el detalle del pedido lista sus órdenes con estado y avance, prioriza por orden y lleva al
 *   workspace de cada una.
 *
 * Escribe (compras, bobinas, pedidos, producción): nunca contra producción.
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

test.describe('F8-S3 — cola de producción y órdenes en el pedido (pantalla)', () => {
  test('la cola de /planta muestra cada OP completa y en orden; el clic abre su workspace; /produccion redirige', async ({
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
      // Un pedido de dos líneas con la fecha prometida vencida: confirmar abre dos OPs.
      const overdue = isoDaysFromToday(-2);
      const { quotation, order } = await quoteAndOrderLines(api, {
        customerId: customer.id,
        lines: [
          { productId: scenario.product.id, rows: pieces([4, 10]) },
          { productId: other.id, rows: pieces([6, 5]) },
        ],
        promisedDeliveryDate: overdue,
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];
      const [first, second] = order.reservations.map((r) => r.productionOrderId!);
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      // La segunda se prioriza: tiene que quedar delante de la primera en la cola.
      await setOrderPriority(api, second!, { priority: true, reason: 'Obra con grúa alquilada' });

      await loginAsAdmin(page);
      await page.goto('/planta');
      await expect(page.getByRole('heading', { name: 'Producción', exact: true })).toBeVisible({
        timeout: 60_000,
      });

      const queueCard = page.locator('main').getByText('Cola de producción').locator('../..');
      // El nombre accesible es el contenido visible (código, prioridad, vencida, cliente…),
      // precedido por «Abrir en producción».
      const entries = queueCard.getByRole('button', { name: /^Abrir en producción OP-\d+/ });
      await expect(entries.first()).toBeVisible();
      const labels = await entries.evaluateAll((els) =>
        els.map((e) => /OP-\d+/.exec(e.textContent ?? '')?.[0] ?? ''),
      );
      const codeOf = async (id: string) =>
        (await api.get(`/api/production/${id}`).then((r) => r.json())) as { code: string };
      const firstCode = (await codeOf(first!)).code;
      const secondCode = (await codeOf(second!)).code;
      const idxFirst = labels.indexOf(firstCode);
      const idxSecond = labels.indexOf(secondCode);
      expect(idxFirst).toBeGreaterThanOrEqual(0);
      expect(idxSecond).toBeGreaterThanOrEqual(0);
      expect(idxSecond, 'la priorizada va primero').toBeLessThan(idxFirst);

      // La entrada lleva la información precisa que el card de cola tenía.
      const entry = queueCard.getByRole('button', {
        name: new RegExp(`^Abrir en producción ${firstCode}\\b`),
      });
      await expect(entry).toContainText(order.code);
      await expect(entry).toContainText(customer.name);
      await expect(entry).toContainText(scenario.product.sku);
      await expect(entry).toContainText('40.000 m del plan');
      await expect(entry).toContainText('Vencida');
      await expect(entry).toContainText('Compromiso:');
      const prioritized = queueCard.getByRole('button', {
        name: new RegExp(`^Abrir en producción ${secondCode}\\b`),
      });
      await expect(prioritized).toContainText('Prioridad');
      await expect(prioritized).toContainText('Obra con grúa alquilada');

      // Clic → el workspace de ESA orden.
      await entry.click();
      const panel = page.locator(`#panel-${first!}`);
      await expect(panel.getByText(firstCode, { exact: true })).toBeVisible();
      await expect(panel.getByText('Faltan 10 × 4.00 m')).toBeVisible();

      // `/produccion` ya no está en el menú y redirige al historial dentro de /planta.
      await expect(
        page.getByRole('link', { name: 'Órdenes de producción', exact: true }),
      ).toHaveCount(0);
      await page.goto('/produccion');
      await expect(page).toHaveURL(/\/planta\?historial=1$/, { timeout: 60_000 });
      await expect(page.getByText('Historial de órdenes de producción')).toBeVisible();
      await expect(page.getByRole('link', { name: firstCode, exact: true })).toBeVisible();
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });

  test('el detalle del pedido lista sus órdenes con estado y avance, prioriza una y lleva a producirla', async ({
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
      const { quotation, order } = await quoteAndOrderLines(api, {
        customerId: customer.id,
        lines: [{ productId: scenario.product.id, rows: pieces([4, 10]) }],
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];
      const opId = order.reservations[0]!.productionOrderId!;
      const op = (await api.get(`/api/production/${opId}`).then((r) => r.json())) as {
        code: string;
      };

      await loginAsAdmin(page);
      await page.goto(`/pedidos/${order.id}`);
      await expect(page.getByRole('heading', { name: order.code })).toBeVisible({
        timeout: 60_000,
      });

      const section = page.locator('section').filter({
        has: page.getByRole('heading', { name: 'Órdenes de producción' }),
      });
      const row = section.getByRole('row').filter({ hasText: op.code });
      await expect(row).toContainText(scenario.product.sku);
      await expect(row).toContainText('En cola');
      await expect(row).toContainText('0.000 m');
      await expect(row).toContainText('de 40.000 m');

      // Priorizar desde el pedido, con motivo.
      await row.getByRole('button', { name: `Priorizar ${op.code}` }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox').fill('El cliente adelantó la obra');
      await dialog.getByRole('button', { name: 'Priorizar' }).click();
      await expect(row).toContainText('Prioridad');
      await expect(row).toContainText('El cliente adelantó la obra');

      // «Producir» lleva al workspace de esa orden.
      await row.getByRole('link', { name: `Producir ${op.code}` }).click();
      await expect(page).toHaveURL(new RegExp(`/planta\\?op=${opId}$`), { timeout: 60_000 });
      await expect(page.locator(`#panel-${opId}`).getByText(op.code, { exact: true })).toBeVisible({
        timeout: 60_000,
      });
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });
});
