import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, createUser, getJson, postJson } from '../helpers/api';
import { ROLE_PASSWORD, type ProductionOrderDto } from '../helpers/production';
import { createCustomer, queueOf, setOrderPriority } from '../helpers/sales';
import {
  cancelAutoCreatedOrders,
  createRoofingProduct,
  mountCoil,
  pieces,
  purgeRoofingTrail,
  quoteAndOrderLines,
  reservationsOf,
  setupRoofingScenario,
} from '../helpers/roofing';
import { headerAction, loginAndSetPassword } from '../helpers/ui';

/**
 * F8-S3b — huecos de cobertura que los specs de la sesión dejaron sin mirar.
 *
 * 1. Prioridad parcial del pedido: una OP priorizada por API → «Prioridad en 1 de 2 órdenes»;
 *    «Priorizar pedido» completa solo la que faltaba y no pisa el motivo de la otra.
 * 2. «Quitar prioridad al pedido» se propaga a todas sus OPs, también a la que ya está en curso.
 * 3. SUPERVISOR_PLANTA ve la vista del pedido y su prioridad, pero no los botones de prioridad.
 * 4. `?op=` suelto de una OP abierta redirige a `?pedido=…&op=…`; el de una OP cerrada avisa
 *    que «no está abierta» y ofrece su detalle.
 * 5. «Generar todas las órdenes (n)» vive en el menú del pedido y pasa por un diálogo.
 * 6. «Abrir una orden nueva» es un drawer: crear desde ahí cierra el drawer y lleva al pedido.
 * 7. «Anular pedido» es destructiva: vive en el menú «Más acciones», nunca como botón.
 * 8. La tarjeta del pedido en `/planta` recalcula ML y conteos tras montar y reportar.
 *
 * Aritmética: 1 000 mm × 0.50 mm, densidad 8.0 y el 1 % de D-165 ⇒ 4.04 kg por metro.
 *
 * Escribe (compras, bobinas, pedidos, producción): nunca contra producción (D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea compras, bobinas y producción: nunca contra producción (D-126).');
test.describe.configure({ timeout: 240_000 });

type Trail = Parameters<typeof purgeRoofingTrail>[1];

const draftsPath = (opId: string) => `/api/production/roofing/${opId}/drafts`;

async function loginAsAdmin(page: Page) {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

/**
 * Un pedido de dos líneas de coberturas —10 × 4 m (40 m) y 5 × 6 m (30 m)— con sus dos OPs
 * en cola y una bobina de 2 000 kg que alcanza para las dos.
 */
async function setupTwoLines(api: APIRequestContext) {
  const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
  const { product: other } = await createRoofingProduct(api, {
    finishId: scenario.finish.id,
    colorId: scenario.color.id,
  });
  const customer = await createCustomer(api);
  const trail: Trail = {
    supplierId: scenario.supplier.id,
    finishId: scenario.finish.id,
    colorId: scenario.color.id,
    productIds: [scenario.product.id, other.id],
    coilIds: [scenario.coil.id],
    purchaseIds: [scenario.purchaseId],
    productionOrderIds: [],
    orderIds: [],
    quotationIds: [],
  };
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
  trail.productionOrderIds = [firstId!, secondId!];
  const first = await getJson<ProductionOrderDto>(api, `/api/production/${firstId}`);
  const second = await getJson<ProductionOrderDto>(api, `/api/production/${secondId}`);
  return {
    scenario,
    other,
    customer,
    order,
    firstId: firstId!,
    secondId: secondId!,
    firstCode: first.code,
    secondCode: second.code,
    trail,
  };
}

interface PriorityView {
  priority: boolean;
  priorityReason: string | null;
  status: string;
}

const opView = (api: APIRequestContext, id: string) =>
  getJson<PriorityView>(api, `/api/production/${id}`);

async function openPedidoWorkspace(page: Page, orderId: string, orderCode: string) {
  await page.goto(`/planta?pedido=${orderId}`);
  await expect(page.getByRole('heading', { name: `Producir ${orderCode}` })).toBeVisible({
    timeout: 60_000,
  });
}

test.describe('F8-S3b — huecos de cobertura', () => {
  test('prioridad parcial: con 1 de 2 OPs priorizada el pedido lo dice, ofrece los dos botones y «Priorizar pedido» completa solo la que faltaba', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupTwoLines(api);
    try {
      await setOrderPriority(api, s.secondId, { priority: true, reason: 'Motivo original' });

      await loginAsAdmin(page);
      await openPedidoWorkspace(page, s.order.id, s.order.code);

      await expect(page.getByText('Prioridad en 1 de 2 órdenes', { exact: true })).toBeVisible();
      const prioritize = page.getByRole('button', { name: 'Priorizar pedido' });
      const unprioritize = page.getByRole('button', { name: 'Quitar prioridad al pedido' });
      await expect(prioritize).toBeVisible();
      await expect(unprioritize).toBeVisible();

      await prioritize.click();
      const dialog = page.getByRole('dialog', { name: `Priorizar ${s.order.code}` });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Se aplica a 1 de las 2 órdenes');
      await dialog.getByRole('textbox').fill('Completar la prioridad del pedido');
      await dialog.getByRole('button', { name: 'Priorizar', exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText(`${s.order.code} priorizado (1 orden)`)).toBeVisible();

      // Todo el pedido priorizado: el badge ya no es parcial y «Priorizar pedido» desaparece.
      await expect(page.getByText('Prioridad en 1 de 2 órdenes', { exact: true })).toHaveCount(0);
      await expect(prioritize).toHaveCount(0);
      await expect(unprioritize).toBeVisible();

      const first = await opView(api, s.firstId);
      const second = await opView(api, s.secondId);
      expect(first.priority).toBe(true);
      expect(first.priorityReason).toBe('Completar la prioridad del pedido');
      // La que ya estaba priorizada no se volvió a tocar: conserva su motivo.
      expect(second.priority).toBe(true);
      expect(second.priorityReason).toBe('Motivo original');
    } finally {
      await purgeRoofingTrail(api, s.trail);
      await api.dispose();
    }
  });

  test('«Quitar prioridad al pedido» la quita de todas sus OPs, también de la que ya está en curso', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupTwoLines(api);
    try {
      await setOrderPriority(api, s.firstId, { priority: true, reason: 'Obra urgente' });
      await setOrderPriority(api, s.secondId, { priority: true, reason: 'Obra urgente' });
      const mounted = await mountCoil(api, s.firstId, { coilId: s.scenario.coil.id });
      expect(mounted.status).toBe('IN_PROGRESS');

      await loginAsAdmin(page);
      await openPedidoWorkspace(page, s.order.id, s.order.code);

      await expect(page.getByRole('button', { name: 'Priorizar pedido' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Quitar prioridad al pedido' }).click();
      const dialog = page.getByRole('dialog', { name: `Quitar prioridad a ${s.order.code}` });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Se aplica a 2 de las 2 órdenes');
      await dialog.getByRole('textbox').fill('El cliente postergó la obra');
      await dialog.getByRole('button', { name: 'Quitar prioridad', exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText(`${s.order.code}: prioridad quitada (2 órdenes)`)).toBeVisible();

      await expect(page.getByRole('button', { name: 'Priorizar pedido' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Quitar prioridad al pedido' })).toHaveCount(0);

      for (const id of [s.firstId, s.secondId]) {
        const op = await opView(api, id);
        expect(op.priority, `${id} sigue priorizada`).toBe(false);
        expect(op.priorityReason).toBeNull();
      }
      expect((await opView(api, s.firstId)).status).toBe('IN_PROGRESS');
      expect((await queueOf(api)).find((q) => q.orderId === s.secondId)?.priority).toBe(false);
    } finally {
      await purgeRoofingTrail(api, s.trail);
      await api.dispose();
    }
  });

  test('SUPERVISOR_PLANTA ve la producción del pedido y su prioridad, pero no los botones para cambiarla', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupTwoLines(api);
    try {
      await setOrderPriority(api, s.firstId, { priority: true, reason: 'Obra con grúa' });
      const supervisor = await createUser(api, 'SUPERVISOR_PLANTA');
      await loginAndSetPassword(page, supervisor, ROLE_PASSWORD);

      await openPedidoWorkspace(page, s.order.id, s.order.code);
      await expect(page.getByText('Prioridad en 1 de 2 órdenes', { exact: true })).toBeVisible();
      // F8-S3c/M1: sin cola separada, las dos órdenes del pedido ya son chips desde que se entra.
      const picker = page.locator('[aria-label="Órdenes del pedido"]');
      await expect(picker.locator('button').filter({ hasText: s.firstCode })).toBeVisible();
      await expect(picker.locator('button').filter({ hasText: s.secondCode })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Priorizar pedido' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Quitar prioridad al pedido' })).toHaveCount(0);
    } finally {
      await purgeRoofingTrail(api, s.trail);
      await api.dispose();
    }
  });

  test('?op= suelto de una OP abierta redirige a su pedido; el de una OP cerrada avisa que no está abierta y ofrece su detalle', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupTwoLines(api);
    try {
      // La primera se produce entera y se cierra en el mismo commit.
      await mountCoil(api, s.firstId, { coilId: s.scenario.coil.id });
      await postJson(api, draftsPath(s.firstId), { pieces: pieces([4, 10]) });
      const closed = await postJson<ProductionOrderDto>(api, `${draftsPath(s.firstId)}/commit`, {
        close: true,
        idempotencyKey: randomUUID(),
      });
      expect(closed.status).toBe('CLOSED');

      await loginAsAdmin(page);

      // Abierta: `?op=` se resuelve a `?pedido=…&op=…` y abre esa orden en el workspace.
      await page.goto(`/planta?op=${s.secondId}`);
      await expect(page).toHaveURL(new RegExp(`/planta\\?pedido=${s.order.id}&op=${s.secondId}$`), {
        timeout: 60_000,
      });
      await expect(page.getByRole('heading', { name: `Producir ${s.order.code}` })).toBeVisible();
      await expect(
        page.locator(`#panel-${s.secondId}`).getByText(s.secondCode, { exact: true }),
      ).toBeVisible({ timeout: 60_000 });

      // Cerrada: no hay nada que producir, se dice y no se redirige.
      await page.goto(`/planta?op=${s.firstId}`);
      await expect(
        page.getByText('Esa orden no está abierta, así que no hay nada que producir.'),
      ).toBeVisible({ timeout: 60_000 });
      await expect(page).toHaveURL(new RegExp(`/planta\\?op=${s.firstId}$`));
      const detail = page.getByRole('link', { name: 'Ver su detalle' });
      await expect(detail).toHaveAttribute('href', `/produccion/${s.firstId}`);
      await detail.click();
      await expect(page.getByRole('heading', { name: s.firstCode })).toBeVisible({
        timeout: 60_000,
      });
    } finally {
      await purgeRoofingTrail(api, s.trail);
      await api.dispose();
    }
  });

  test('«Generar todas las órdenes (2)» vive en el menú del pedido, abre un diálogo y «Generar» crea las dos OPs', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupTwoLines(api);
    try {
      expect(await cancelAutoCreatedOrders(api, s.order.id)).toBe(2);

      await loginAsAdmin(page);
      await page.goto(`/pedidos/${s.order.id}`);
      await expect(page.getByRole('heading', { name: s.order.code })).toBeVisible({
        timeout: 60_000,
      });

      const main = page.locator('main');
      await expect(
        main.getByRole('button', { name: 'Generar todas las órdenes (2)', exact: true }),
      ).toHaveCount(0);
      const generate = await headerAction(page, 'Generar todas las órdenes (2)');
      await expect(generate).toHaveAttribute('role', 'menuitem');
      await generate.click();

      const dialog = page.getByRole('dialog', { name: `Generar las órdenes de ${s.order.code}` });
      await expect(dialog).toBeVisible();
      // Cancelar no crea nada.
      await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
      await expect(dialog).toBeHidden();
      expect(
        (await reservationsOf(api, s.order.id)).filter(
          (r) => r.status === 'ACTIVE' && r.productionOrderId !== null,
        ),
      ).toHaveLength(0);

      await (await headerAction(page, 'Generar todas las órdenes (2)')).click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Generar', exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      await expect(page.getByText(/^2 órdenes creadas: OP-\d+, OP-\d+$/)).toBeVisible();

      const live = (await reservationsOf(api, s.order.id)).filter(
        (r) => r.status === 'ACTIVE' && r.itemType === 'RAW_MATERIAL',
      );
      expect(live).toHaveLength(2);
      const newIds = live.map((r) => r.productionOrderId);
      expect(newIds.every((id) => id !== null && id !== s.firstId && id !== s.secondId)).toBe(true);
      s.trail.productionOrderIds!.push(...(newIds as string[]));
      const queued = new Set((await queueOf(api)).map((q) => q.orderId));
      expect(newIds.every((id) => queued.has(id!))).toBe(true);

      // Ya no hay nada que generar; ahora el menú ofrece producir las dos.
      await expect(await headerAction(page, 'Producir (2)')).toBeVisible();
      await expect(page.getByRole('menuitem', { name: /^Generar todas las órdenes/ })).toHaveCount(
        0,
      );
      await page.keyboard.press('Escape');
    } finally {
      await purgeRoofingTrail(api, s.trail);
      await api.dispose();
    }
  });

  test('«Abrir una orden nueva» es un drawer; iniciar la línea sin orden lo cierra y lleva a la producción del pedido', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupTwoLines(api);
    try {
      // Solo la primera línea pierde su orden: la segunda sigue en cola.
      await postJson(api, `/api/production/roofing/${s.firstId}/cancel`, {
        reason: 'E2E: dejar la línea sin orden',
      });

      await loginAsAdmin(page);
      await page.goto('/planta');
      await expect(page.getByRole('heading', { name: 'Producción', exact: true })).toBeVisible({
        timeout: 60_000,
      });
      const pedidos = page.getByRole('region', { name: 'Pedidos con producción pendiente' });
      await expect(pedidos).toBeVisible();

      await page.getByRole('button', { name: 'Abrir una orden nueva' }).click();
      const drawer = page.getByRole('dialog', { name: 'Abrir una orden nueva' });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByText('Líneas de pedido sin orden')).toBeVisible();
      await expect(drawer.getByText('Nueva orden de perfiles (drywall)')).toBeVisible();

      // Cerrar el drawer deja la lista de pedidos a la vista, sin navegar.
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
      await expect(page).toHaveURL(/\/planta$/);

      await page.getByRole('button', { name: 'Abrir una orden nueva' }).click();
      await expect(drawer).toBeVisible();
      await drawer
        .getByRole('button', { name: `Iniciar producción del pedido ${s.order.code}` })
        .click();
      await expect(drawer).toBeHidden({ timeout: 30_000 });
      await expect(page).toHaveURL(new RegExp(`/planta\\?pedido=${s.order.id}&op=[0-9a-f-]{36}$`), {
        timeout: 60_000,
      });
      await expect(page.getByRole('heading', { name: `Producir ${s.order.code}` })).toBeVisible();

      const newId = new URL(page.url()).searchParams.get('op')!;
      s.trail.productionOrderIds!.push(newId);
      expect(newId).not.toBe(s.firstId);
      const created = await getJson<ProductionOrderDto & { code: string }>(
        api,
        `/api/production/${newId}`,
      );
      expect(created.status).toBe('DRAFT');
      await expect(
        page.locator(`#panel-${newId}`).getByText(created.code, { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
    } finally {
      await purgeRoofingTrail(api, s.trail);
      await api.dispose();
    }
  });

  test('«Anular pedido» es destructiva: no es un botón de la cabecera sino el último ítem del menú, y abre su diálogo', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupTwoLines(api);
    try {
      await loginAsAdmin(page);
      await page.goto(`/pedidos/${s.order.id}`);
      await expect(page.getByRole('heading', { name: s.order.code })).toBeVisible({
        timeout: 60_000,
      });

      const main = page.locator('main');
      // La principal del pedido es despachar.
      await expect(main.getByRole('link', { name: 'Despachar', exact: true })).toBeVisible();
      await expect(main.getByRole('button', { name: 'Anular pedido', exact: true })).toHaveCount(0);

      await main.getByRole('button', { name: 'Más acciones' }).click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      const items = menu.getByRole('menuitem');
      await expect(items.last()).toHaveText('Anular pedido');
      await expect(menu.getByRole('menuitem', { name: 'Despachar', exact: true })).toHaveCount(0);
      await expect(menu.getByRole('separator')).toHaveCount(1);

      await menu.getByRole('menuitem', { name: 'Anular pedido', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: `Anular ${s.order.code}` });
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      // Cerrar sin confirmar no anula nada.
      const order = await getJson<{ status: string }>(api, `/api/sales/orders/${s.order.id}`);
      expect(order.status).not.toBe('CANCELLED');
    } finally {
      await purgeRoofingTrail(api, s.trail);
      await api.dispose();
    }
  });

  test('la tarjeta del pedido en /planta recalcula ML reportados y conteos al montar, reportar y cubrir el plan', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupTwoLines(api);
    try {
      await loginAsAdmin(page);
      const pedidos = page.getByRole('region', { name: 'Pedidos con producción pendiente' });
      const cardOf = () =>
        pedidos
          .getByRole('link', { name: `Producir ${s.order.code}`, exact: true })
          .locator('xpath=ancestor::div[@data-slot="card"]');
      const queueList = () => cardOf().getByRole('list', { name: `Cola de ${s.order.code}` });
      const visit = async () => {
        await page.goto('/planta');
        await expect(cardOf()).toBeVisible({ timeout: 60_000 });
      };

      // --- Recién confirmado: nada reportado, las dos sin iniciar ---
      await visit();
      await expect(cardOf()).toContainText('2 órdenes abiertas');
      await expect(cardOf()).toContainText('0 con el plan cubierto · 0 en curso · 2 sin iniciar');
      await expect(cardOf()).toContainText('0.000 m de 70.000 m reportados');
      await expect(queueList().getByRole('listitem')).toHaveCount(2);

      // --- Montar la bobina en la primera: pasa a en curso y sale de la cola ---
      await mountCoil(api, s.firstId, { coilId: s.scenario.coil.id });
      await visit();
      await expect(cardOf()).toContainText('0 con el plan cubierto · 1 en curso · 1 sin iniciar');
      await expect(cardOf()).toContainText('0.000 m de 70.000 m reportados');
      await expect(queueList().getByRole('listitem')).toHaveCount(1);
      await expect(queueList()).toContainText(s.secondCode);
      await expect(queueList()).not.toContainText(s.firstCode);

      // --- Reportar 3 × 4 m = 12 m ---
      await postJson(api, `/api/production/roofing/${s.firstId}/report`, {
        pieces: pieces([4, 3]),
      });
      await visit();
      await expect(cardOf()).toContainText('12.000 m de 70.000 m reportados');
      await expect(cardOf()).toContainText('0 con el plan cubierto · 1 en curso · 1 sin iniciar');

      // --- Cubrir el plan de la primera (40 m) sin cerrarla ---
      await postJson(api, `/api/production/roofing/${s.firstId}/report`, {
        pieces: pieces([4, 7]),
      });
      await visit();
      await expect(cardOf()).toContainText('40.000 m de 70.000 m reportados');
      await expect(cardOf()).toContainText('1 con el plan cubierto · 0 en curso · 1 sin iniciar');
      await expect(cardOf()).toContainText('2 órdenes abiertas');

      // Y el resumen de la vista del pedido dice lo mismo.
      await cardOf()
        .getByRole('link', { name: `Producir ${s.order.code}`, exact: true })
        .click();
      await expect(page.getByRole('heading', { name: `Producir ${s.order.code}` })).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        page.getByText('40.000 m de 70.000 m reportados · 2 órdenes abiertas'),
      ).toBeVisible();
    } finally {
      await purgeRoofingTrail(api, s.trail);
      await api.dispose();
    }
  });
});
