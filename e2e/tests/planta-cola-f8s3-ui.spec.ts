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
 * - F8-S3b/M2: `/planta` lista **pedidos** en el orden del ranking, cada tarjeta con la
 *   información completa de su cola (OP, pedido y cliente, producto, ML del plan, fecha
 *   compromiso, prioridad, vencida); la prioridad se asigna al pedido y se propaga a sus OPs;
 *   dentro del pedido, F8-S3c/M1 quitó el paso por una cola separada: la franja de chips trae
 *   de entrada **todas** las órdenes, iniciadas o no, y un clic en la suya abre esa orden en el
 *   workspace;
 * - `/produccion` salió del menú y redirige al historial, que desde F8-S3b es vista propia;
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
  test('/planta lista pedidos en el orden del ranking; la prioridad del pedido se propaga a sus OPs; la cola del pedido abre su workspace; /produccion redirige', async ({
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
      // Pedido A: dos líneas con la fecha prometida vencida; confirmar abre dos OPs.
      const overdue = isoDaysFromToday(-2);
      const a = await quoteAndOrderLines(api, {
        customerId: customer.id,
        lines: [
          { productId: scenario.product.id, rows: pieces([4, 10]) },
          { productId: other.id, rows: pieces([6, 5]) },
        ],
        promisedDeliveryDate: overdue,
      });
      // Pedido B: una línea, sin fecha. Sin prioridad va detrás de A, que está vencido.
      const b = await quoteAndOrderLines(api, {
        customerId: customer.id,
        lines: [{ productId: scenario.product.id, rows: pieces([4, 5]) }],
      });
      trail.quotationIds = [a.quotation.id, b.quotation.id];
      trail.orderIds = [a.order.id, b.order.id];
      const [first, second] = a.order.reservations.map((r) => r.productionOrderId!);
      const bOrderId = b.order.reservations[0]!.productionOrderId!;
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      const opOf = async (id: string) =>
        (await api.get(`/api/production/${id}`).then((r) => r.json())) as {
          code: string;
          priority: boolean;
          priorityReason: string | null;
        };
      const firstCode = (await opOf(first!)).code;
      const secondCode = (await opOf(second!)).code;

      await loginAsAdmin(page);
      await page.goto('/planta');
      await expect(page.getByRole('heading', { name: 'Producción', exact: true })).toBeVisible({
        timeout: 60_000,
      });

      // --- La primera vista son pedidos, en el orden del ranking ---
      const pedidos = page.getByRole('region', { name: 'Pedidos con producción pendiente' });
      const cardLinks = pedidos.getByRole('link', { name: /^Producir PED-\d+$/ });
      const pedidoOrder = () =>
        cardLinks.evaluateAll((els) =>
          els.map((e) => /PED-\d+/.exec(e.textContent ?? '')?.[0] ?? ''),
        );
      const linkOf = (code: string) =>
        pedidos.getByRole('link', { name: `Producir ${code}`, exact: true });
      await expect(linkOf(b.order.code)).toBeVisible();
      let labels = await pedidoOrder();
      expect(labels.indexOf(a.order.code), 'el vencido va primero').toBeLessThan(
        labels.indexOf(b.order.code),
      );

      // La tarjeta del pedido lleva el resumen y la información precisa de su cola.
      const cardA = linkOf(a.order.code).locator('xpath=ancestor::div[@data-slot="card"]');
      await expect(cardA).toContainText(customer.name);
      await expect(cardA).toContainText('Vencido');
      await expect(cardA).toContainText('Compromiso:');
      await expect(cardA).toContainText('2 órdenes abiertas');
      await expect(cardA).toContainText('0 con el plan cubierto · 0 en curso · 2 sin iniciar');
      await expect(cardA).toContainText('0.000 m de 70.000 m reportados');
      await expect(cardA).toContainText(scenario.product.sku);
      await expect(cardA).toContainText(other.sku);
      const queueA = cardA.getByRole('list', { name: `Cola de ${a.order.code}` });
      await expect(queueA.getByRole('listitem')).toHaveCount(2);
      await expect(queueA).toContainText(firstCode);
      await expect(queueA).toContainText('40.000 m del plan');
      await expect(queueA).toContainText('Vencida');

      // --- La prioridad se asigna al pedido y se propaga a sus OPs ---
      await linkOf(b.order.code).click();
      await expect(page).toHaveURL(new RegExp(`/planta\\?pedido=${b.order.id}$`));
      await expect(page.getByRole('heading', { name: `Producir ${b.order.code}` })).toBeVisible();
      await page.getByRole('button', { name: 'Priorizar pedido' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox').fill('Obra con grúa alquilada');
      await dialog.getByRole('button', { name: 'Priorizar' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('button', { name: 'Quitar prioridad al pedido' })).toBeVisible();
      const bOp = await opOf(bOrderId);
      expect(bOp.priority).toBe(true);
      expect(bOp.priorityReason).toBe('Obra con grúa alquilada');

      await page.getByRole('link', { name: 'Todos los pedidos' }).click();
      await expect(linkOf(b.order.code)).toBeVisible();
      await expect
        .poll(
          async () => {
            labels = await pedidoOrder();
            return labels.indexOf(b.order.code) < labels.indexOf(a.order.code);
          },
          { message: 'el priorizado pasa delante del vencido' },
        )
        .toBe(true);

      // --- Dentro del pedido, los chips siguen el ranking por OP y abren su workspace (F8-S3c/M1) ---
      await setOrderPriority(api, second!, { priority: true, reason: 'Sale primero la otra' });
      await page.goto(`/planta?pedido=${a.order.id}`);
      await expect(page.getByRole('heading', { name: `Producir ${a.order.code}` })).toBeVisible({
        timeout: 60_000,
      });
      // F8-S3c/M1: sin cola separada, la franja de chips trae de entrada las dos órdenes del
      // pedido, iniciadas o no. El chip es un `<button>` con rol `tab`, no `button`.
      const picker = page.locator('[aria-label="Órdenes del pedido"]');
      const chips = picker.locator('button');
      await expect(chips).toHaveCount(2);
      const chipLabels = await chips.evaluateAll((els) =>
        els.map((e) => /OP-\d+/.exec(e.textContent ?? '')?.[0] ?? ''),
      );
      expect(chipLabels, 'la priorizada va primero').toEqual([secondCode, firstCode]);
      // Substring plano: el `textContent` del chip no lleva espacio entre el código y el
      // badge de estado que sigue, así que un `\bcode\b` con frontera de cierre no matchea
      // nada (helpers/ui.ts#openQueuedOrder tiene el mismo motivo documentado).
      const chipOf = (code: string) => chips.filter({ hasText: code });
      // Sin bobina montada, las dos siguen sin iniciar: el chip lo dice con su nota de cola.
      await expect(chipOf(secondCode)).toContainText('en cola desde');
      await expect(chipOf(firstCode)).toContainText('en cola desde');
      await expect(chipOf(firstCode)).toContainText(scenario.product.sku);
      await expect(chipOf(firstCode)).toContainText('faltan 40.000 m');
      await expect(chipOf(firstCode)).toContainText(customer.name);
      // Una sola OP priorizada de dos: el resumen del pedido lo dice.
      await expect(page.getByText('Prioridad en 1 de 2 órdenes')).toBeVisible();
      const secondOp = await opOf(second!);
      expect(secondOp.priority).toBe(true);
      expect(secondOp.priorityReason).toBe('Sale primero la otra');

      await chipOf(firstCode).click();
      const panel = page.locator(`#panel-${first!}`);
      await expect(panel.getByText(firstCode, { exact: true })).toBeVisible();
      await expect(panel.getByText('Faltan 10 × 4.00 m')).toBeVisible();

      // `/produccion` ya no está en el menú y redirige al historial, que es vista propia.
      await expect(
        page.getByRole('link', { name: 'Órdenes de producción', exact: true }),
      ).toHaveCount(0);
      await page.goto('/produccion');
      await expect(page).toHaveURL(/\/planta\?historial=1$/, { timeout: 60_000 });
      await expect(
        page.getByRole('heading', { name: 'Historial de órdenes', exact: true }),
      ).toBeVisible();
      await expect(page.getByText('Historial de órdenes de producción')).toBeVisible();
      const historyGroup = page
        .getByRole('link', { name: a.order.code, exact: true })
        .locator('xpath=ancestor::div[@data-slot="card"][1]');
      await expect(historyGroup).toContainText(customer.name);
      await expect(
        historyGroup.getByRole('link', { name: firstCode, exact: true }),
      ).toHaveAttribute('href', `/produccion/${first!}`);
      await expect(
        historyGroup.getByRole('link', { name: secondCode, exact: true }),
      ).toHaveAttribute('href', `/produccion/${second!}`);
      await expect(historyGroup).toContainText('2 órdenes');
      // Y ya no convive plegado con la lista de pedidos.
      await expect(
        page.getByRole('region', { name: 'Pedidos con producción pendiente' }),
      ).toHaveCount(0);
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
      await expect(page).toHaveURL(new RegExp(`/planta\\?pedido=${order.id}&op=${opId}$`), {
        timeout: 60_000,
      });
      await expect(page.locator(`#panel-${opId}`).getByText(op.code, { exact: true })).toBeVisible({
        timeout: 60_000,
      });
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });
});
