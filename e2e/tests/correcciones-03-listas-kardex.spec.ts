import { expect, test, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getItems } from '../helpers/api';
import { createCustomer } from '../helpers/sales';
import {
  mountCoil,
  pieces,
  purgeRoofingTrail,
  quoteAndOrder,
  reportPieces,
  setupRoofingScenario,
} from '../helpers/roofing';
import { openSidebarGroup } from '../helpers/ui';

/**
 * Correcciones 03 del cliente (2026-09-25), por pantalla:
 *
 * - **M0 (D-289):** los filtros de una lista viven en la URL (recargar los conserva); los
 *   terminales negativos no salen en la bandeja y se piden con su chip; buscar por código los
 *   encuentra aunque el chip no esté activo.
 * - **M1 (D-290):** `/kardex` arranca vacío, se elige el ítem con un buscador y el rango de
 *   fechas es el mes en curso; búsqueda por SKU/nombre en el catálogo.
 * - **M2 (D-291/D-292):** sidebar acordeón; columna de bobina en los reportes de una OP; el
 *   historial de órdenes en tabla con fila expandible.
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

test.describe('Correcciones 03 — sidebar acordeón (D-292)', () => {
  test('un solo grupo abierto a la vez; navegar abre el grupo del ítem activo', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    const header = (name: string) =>
      page.locator('[data-slot="sidebar-group-label"]').getByText(name, { exact: true });
    const headerButton = (name: string) =>
      header(name).locator('xpath=ancestor-or-self::button[1]');

    // Panel (sin grupo) sigue suelto y a la vista.
    await expect(page.getByRole('link', { name: 'Panel', exact: true })).toBeVisible();

    await openSidebarGroup(page, 'Comercial');
    await expect(headerButton('Comercial')).toHaveAttribute('data-state', 'open');
    await expect(page.getByRole('link', { name: 'Cotizaciones', exact: true })).toBeVisible();

    // Abrir otro grupo cierra el anterior.
    await headerButton('Catálogo').click();
    await expect(headerButton('Catálogo')).toHaveAttribute('aria-expanded', 'true');
    await expect(headerButton('Comercial')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('link', { name: 'Cotizaciones', exact: true })).toBeHidden();
    await expect(page.getByRole('link', { name: 'Kardex', exact: true })).toBeVisible();

    // Navegar por un ítem deja abierto su grupo, y solo ese.
    await page.getByRole('link', { name: 'Kardex', exact: true }).click();
    await expect(page).toHaveURL(/\/kardex$/);
    await expect(headerButton('Catálogo')).toHaveAttribute('aria-expanded', 'true');
    const openGroups = await page
      .locator('[data-slot="sidebar-group-label"][data-state="open"]')
      .count();
    expect(openGroups, 'solo un grupo abierto').toBe(1);

    // Ir a una pantalla de otro grupo por URL abre el grupo de esa pantalla.
    await page.goto('/pedidos');
    await expect(headerButton('Comercial')).toHaveAttribute('aria-expanded', 'true', {
      timeout: 60_000,
    });
    await expect(headerButton('Catálogo')).toHaveAttribute('aria-expanded', 'false');
  });
});

test.describe('Correcciones 03 — pedidos: chips y URL (D-289)', () => {
  test('el anulado no sale en la bandeja, sale al buscarlo o con el chip; la URL guarda el filtro', async ({
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
        rows: pieces([4, 3]),
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];
      const cancelled = await api.post(`/api/sales/orders/${order.id}/cancel`, {
        data: { reason: 'Prueba de correcciones 03 (E2E)' },
      });
      expect(cancelled.ok(), 'El pedido debía anularse').toBe(true);

      // API: sin filtro, la bandeja no lo trae; con `search` o `stage`, sí.
      const inTray = await getItems<{ id: string }>(api, '/api/sales/orders');
      expect(inTray.map((o) => o.id)).not.toContain(order.id);
      const bySearch = await getItems<{ id: string }>(
        api,
        `/api/sales/orders?search=${encodeURIComponent(order.code)}`,
      );
      expect(bySearch.map((o) => o.id)).toContain(order.id);
      const byStage = await getItems<{ id: string }>(
        api,
        '/api/sales/orders?stage=CANCELLED',
      );
      expect(byStage.map((o) => o.id)).toContain(order.id);

      await loginAsAdmin(page);
      await page.goto('/pedidos');
      await expect(page.getByRole('heading', { name: 'Pedidos', exact: true })).toBeVisible({
        timeout: 60_000,
      });
      const rowOf = () => page.getByRole('row').filter({ hasText: order.code });
      const chipAnulados = page.getByRole('button', { name: 'Anulados', exact: true });
      const chipAtendidos = page.getByRole('button', { name: 'Atendidos', exact: true });
      await expect(chipAnulados).toHaveAttribute('aria-pressed', 'false');
      await expect(chipAtendidos).toHaveAttribute('aria-pressed', 'false');
      await expect(rowOf()).toHaveCount(0);

      // El chip «Anulados» lo muestra y lo escribe en la URL.
      await chipAnulados.click();
      await expect(page).toHaveURL(/stage=CANCELLED/);
      await expect(chipAnulados).toHaveAttribute('aria-pressed', 'true');
      await expect(rowOf()).toHaveCount(1, { timeout: 30_000 });

      // Recargar conserva el filtro: mismo chip, misma fila.
      await page.reload();
      await expect(page).toHaveURL(/stage=CANCELLED/);
      await expect(chipAnulados).toHaveAttribute('aria-pressed', 'true');
      await expect(rowOf()).toHaveCount(1, { timeout: 30_000 });

      // «Atendidos» se suma a los chips (la lista pide los dos estados) y también queda en la URL.
      await chipAtendidos.click();
      await expect(chipAtendidos).toHaveAttribute('aria-pressed', 'true');
      await expect(page).toHaveURL(
        /stage=(FULFILLED%2CCANCELLED|FULFILLED,CANCELLED|CANCELLED%2CFULFILLED|CANCELLED,FULFILLED)/,
      );
      await chipAtendidos.click();
      await chipAnulados.click();
      await expect(page).not.toHaveURL(/stage=/);

      // Buscar por código lo encuentra aunque ningún chip esté activo, y la búsqueda vive en la URL.
      await page.getByPlaceholder('Buscar por código, cliente o documento…').fill(order.code);
      await expect(page).toHaveURL(new RegExp(`search=${order.code}`), { timeout: 30_000 });
      await expect(rowOf()).toHaveCount(1, { timeout: 30_000 });
      await page.reload();
      await expect(page.getByPlaceholder('Buscar por código, cliente o documento…')).toHaveValue(
        order.code,
      );
      await expect(rowOf()).toHaveCount(1, { timeout: 30_000 });
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });
});

test.describe('Correcciones 03 — kardex por ítem, catálogo, columna de bobina e historial', () => {
  test('kardex vacío → ítem → rango en la URL; búsqueda en catálogo; bobina en el reporte y en el historial', async ({
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
        rows: pieces([4, 3]),
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];
      const opId = order.reservations[0]!.productionOrderId!;
      expect(opId).toBeDefined();
      await mountCoil(api, opId, { coilId: scenario.coil.id });
      await reportPieces(api, opId, { pieces: pieces([4, 2]) });

      await loginAsAdmin(page);

      // --- Kardex: arranca vacío y sin listado mezclado ---
      await page.goto('/kardex');
      await expect(page.getByRole('heading', { name: 'Kardex', exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByText('Elegí un ítem para ver su kardex')).toBeVisible();
      await expect(page.getByTestId('kardex-empty')).toBeVisible();
      await expect(page.getByRole('table')).toHaveCount(0);

      // El buscador de ítems encuentra la bobina por su código.
      await page.getByRole('button', { name: 'Ítem del kardex' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Filtrar opciones').fill(scenario.coil.code);
      await dialog.getByRole('button', { name: `Ver kardex ${scenario.coil.code}` }).click();
      await expect(page).toHaveURL(new RegExp(`itemType=COIL&item=${scenario.coil.id}`));
      await expect(page.getByTestId('kardex-empty')).toBeHidden();
      // Mes en curso por defecto: la entrada de la compra y la salida de producción son de hoy.
      await expect(page.getByRole('button', { name: 'Mes actual' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      const movementRows = page.getByRole('row').filter({ hasText: /Entrada|Salida/ });
      await expect(movementRows.first()).toBeVisible({ timeout: 30_000 });
      // Saldo corrido: el ingreso deja el peso completo de la bobina.
      await expect(page.getByRole('row').filter({ hasText: 'Entrada' }).first()).toContainText(
        '2,000.000 kg',
      );

      // Mes anterior: vacío, y el rango queda en la URL.
      await page.getByRole('button', { name: 'Mes anterior' }).click();
      await expect(page).toHaveURL(/range=prev/);
      await expect(page.getByText(/No hay movimientos en este rango/)).toBeVisible({
        timeout: 30_000,
      });
      // Todo: vuelve el historial completo, y recargar conserva ítem y rango.
      await page.getByRole('button', { name: 'Todo', exact: true }).click();
      await expect(page).toHaveURL(/range=all/);
      await expect(movementRows.first()).toBeVisible({ timeout: 30_000 });
      await page.reload();
      await expect(page).toHaveURL(
        new RegExp(`item=${scenario.coil.id}.*range=all|range=all.*item=`),
      );
      await expect(page.getByRole('button', { name: 'Todo', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(movementRows.first()).toBeVisible({ timeout: 30_000 });

      // --- Catálogo: búsqueda por SKU, en la URL ---
      await page.goto('/catalogo');
      await expect(page.getByRole('heading', { name: 'Catálogo', exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await page
        .getByRole('tab', { name: 'Coberturas Aluzinc' })
        .first()
        .click();
      const search = page.getByLabel('Buscar productos por SKU o nombre').first();
      await search.fill(scenario.product.sku);
      await expect(page).toHaveURL(new RegExp(`q=${scenario.product.sku}`), { timeout: 30_000 });
      await expect(page.getByRole('row').filter({ hasText: scenario.product.sku })).toHaveCount(1);
      await search.fill('zzzz-no-existe');
      await expect(page.getByText(/Ningún producto de esta línea coincide/)).toBeVisible();

      // --- Reporte de la OP: de qué bobina salió el material ---
      await page.goto(`/produccion/${opId}`);
      const coilCell = page.getByTestId('report-coils').first();
      await expect(coilCell.getByRole('link', { name: scenario.coil.code })).toHaveAttribute(
        'href',
        `/bobinas/${scenario.coil.id}`,
        { timeout: 60_000 },
      );

      // --- Historial de órdenes: una fila por pedido, con sus órdenes al abrirla ---
      await page.goto('/planta?historial=1');
      const historyRow = page
        .getByTestId('history-order-row')
        .filter({ has: page.getByRole('link', { name: order.code, exact: true }) });
      await expect(historyRow).toHaveCount(1, { timeout: 60_000 });
      await expect(historyRow).toContainText(customer.name);
      await expect(historyRow).toContainText('0 / 1');
      await historyRow.getByRole('button', { name: /Ver las órdenes de/ }).click();
      const detail = page.getByTestId('history-orders-detail');
      await expect(detail.getByRole('link', { name: /^OP-\d+$/ })).toHaveAttribute(
        'href',
        `/produccion/${opId}`,
      );
      await expect(detail.getByRole('link', { name: scenario.coil.code })).toHaveAttribute(
        'href',
        `/bobinas/${scenario.coil.id}`,
        { timeout: 30_000 },
      );
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });
});
