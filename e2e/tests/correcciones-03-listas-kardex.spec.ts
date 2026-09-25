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
import { openSidebarGroup, selectOption } from '../helpers/ui';

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

    // Abrir otro grupo cierra el anterior (D-326: el kardex es del grupo Almacén).
    await headerButton('Almacén').click();
    await expect(headerButton('Almacén')).toHaveAttribute('aria-expanded', 'true');
    await expect(headerButton('Comercial')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('link', { name: 'Cotizaciones', exact: true })).toBeHidden();
    await expect(page.getByRole('link', { name: 'Kardex', exact: true })).toBeVisible();

    // Navegar por un ítem deja abierto su grupo, y solo ese.
    await page.getByRole('link', { name: 'Kardex', exact: true }).click();
    await expect(page).toHaveURL(/\/kardex$/);
    await expect(headerButton('Almacén')).toHaveAttribute('aria-expanded', 'true');
    const openGroups = await page
      .locator('[data-slot="sidebar-group-label"][data-state="open"]')
      .count();
    expect(openGroups, 'solo un grupo abierto').toBe(1);

    // Ir a una pantalla de otro grupo por URL abre el grupo de esa pantalla.
    await page.goto('/pedidos');
    await expect(headerButton('Comercial')).toHaveAttribute('aria-expanded', 'true', {
      timeout: 60_000,
    });
    await expect(headerButton('Almacén')).toHaveAttribute('aria-expanded', 'false');
  });

  test('D-326: el mapa del menú del administrador, grupo por grupo, y la pestaña «Colores»', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    const map: Record<string, string[]> = {
      Comercial: [
        'Cotizaciones',
        'Reservas temporales',
        'Pedidos',
        'Despachos',
        'Comprobantes',
        'Cobranzas',
        'Mostrador',
        'Clientes',
      ],
      Compras: ['Compras', 'Proveedores'],
      Almacén: ['Bobinas', 'Flejes', 'Corte tercerizado', 'Inventario', 'Kardex'],
      Planta: ['Producción', 'Órdenes de producción'],
      Catálogo: ['Productos', 'Líneas', 'Acabados', 'Colores'],
      Reportes: ['Ventas y margen', 'Inventario valorizado', 'Reporte mensual de bobinas'],
      Administración: ['Usuarios', 'Márgenes y tipo de cambio', 'Auditoría', 'Configuración'],
    };
    // Los grupos aparecen en este orden, con «Panel» suelto a la cabeza.
    const labels = page.locator('[data-slot="sidebar-group-label"]');
    await expect(labels).toHaveText(Object.keys(map), { timeout: 60_000 });
    for (const [group, items] of Object.entries(map)) {
      await openSidebarGroup(page, group);
      const content = page.locator(`#nav-group-${group}`);
      await expect(content.getByRole('link')).toHaveText(items);
    }

    // «Colores» abre la pestaña de colores del catálogo, y «Productos» vuelve a las líneas.
    await openSidebarGroup(page, 'Catálogo');
    await page.getByRole('link', { name: 'Colores', exact: true }).click();
    await expect(page).toHaveURL(/\/catalogo\?tab=colores/);
    await expect(page.getByRole('tab', { name: 'Colores' })).toHaveAttribute(
      'data-state',
      'active',
      { timeout: 60_000 },
    );
    await page.getByRole('link', { name: 'Productos', exact: true }).click();
    await expect(page).not.toHaveURL(/tab=colores/);
    await expect(page.getByRole('tab', { name: 'Colores' })).toHaveAttribute(
      'data-state',
      'inactive',
    );
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
      const byStage = await getItems<{ id: string }>(api, '/api/sales/orders?stage=CANCELLED');
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
      // D-298: la hoja del cliente —cabecera Producto / Código / Método y las columnas Fecha,
      // Detalle, ENTRADAS, SALIDAS y SALDO—, igual para los dos métodos.
      const header = page.getByTestId('kardex-header');
      await expect(header).toContainText('Producto');
      await expect(header).toContainText(scenario.coil.code);
      await expect(header).toContainText('Método');
      const sheet = page.getByTestId('kardex-sheet');
      for (const group of ['Fecha', 'Detalle', 'ENTRADAS', 'SALIDAS', 'SALDO']) {
        await expect(sheet.getByRole('columnheader', { name: group })).toBeVisible();
      }
      // La compra y la salida de producción son de hoy.
      const movementRows = sheet.getByRole('row').filter({ hasText: /Compra|Producción/ });
      await expect(movementRows.first()).toBeVisible({ timeout: 30_000 });
      // Saldo corrido: el ingreso deja el peso completo de la bobina (cantidad y monto).
      await expect(sheet.getByRole('row').filter({ hasText: 'Compra' }).first()).toContainText(
        '2,000.000',
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

      // M0.1 (correcciones 04): «Desde» y «Hasta» escritos uno tras otro, sin pausa, se conservan
      // los dos. Antes la segunda escritura reenviaba el «Desde» viejo y dejaba el rango al revés.
      await page.getByLabel('Desde').fill('2026-08-01');
      await page.getByLabel('Hasta').fill('2026-08-31');
      await expect
        .poll(() => Object.fromEntries(new URL(page.url()).searchParams), { timeout: 15_000 })
        .toMatchObject({ range: 'custom', from: '2026-08-01', to: '2026-08-31' });
      await expect(page.getByText(/La fecha «Desde» es posterior a «Hasta»/)).toBeHidden();
      await page.getByRole('button', { name: 'Todo', exact: true }).click();
      await expect(movementRows.first()).toBeVisible({ timeout: 30_000 });

      // D-323: sin filtros por columna; la fecha ordena (la más reciente primero) y el saldo
      // inicial y los totales se quedan en su lugar.
      const totalMovements = await movementRows.count();
      expect(totalMovements).toBeGreaterThanOrEqual(2);
      await expect(page.getByLabel('Filtrar por detalle')).toHaveCount(0);
      await expect(movementRows.first()).toContainText('Compra');
      await sheet.getByRole('button', { name: 'Fecha', exact: true }).click();
      await expect(page).toHaveURL(/sort=date/);
      await sheet.getByRole('button', { name: 'Fecha', exact: true }).click();
      await expect(page).toHaveURL(/dir=desc/);
      await expect(movementRows.first()).toContainText('Producción');
      await expect(movementRows).toHaveCount(totalMovements);

      // D-296/D-298: método de costeo PEPS con el mismo formato.
      await selectOption(page, page.getByRole('combobox', { name: 'Método de costeo' }), 'PEPS');
      await expect(page).toHaveURL(/costing=peps/);
      await expect(sheet.getByText('Saldo inicial')).toBeVisible({ timeout: 30_000 });
      await expect(sheet.getByText('Totales')).toBeVisible();
      await expect(sheet.getByRole('row').filter({ hasText: '2,000.000' }).first()).toBeVisible();
      // «Descargar Excel» apunta al formato del cliente en el método elegido.
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.screenshot({ path: 'test-results/kardex-hoja-peps.png' });
      await expect(page.getByRole('link', { name: 'Descargar Excel' })).toHaveAttribute(
        'href',
        /\/api\/reports\/kardex\/xlsx\?.*method=PEPS/,
      );
      await page.reload();
      await expect(page.getByTestId('kardex-sheet').getByText('Saldo inicial')).toBeVisible({
        timeout: 30_000,
      });
      await selectOption(
        page,
        page.getByRole('combobox', { name: 'Método de costeo' }),
        'Promedio (por defecto)',
      );
      await expect(page).not.toHaveURL(/costing=/);
      await expect(page.getByTestId('kardex-sheet').getByText('Saldo inicial')).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Descargar Excel' })).toHaveAttribute(
        'href',
        /method=AVERAGE/,
      );

      // El Excel del cliente baja en los dos métodos (solo ADMINISTRADOR) y es un .xlsx.
      for (const method of ['AVERAGE', 'PEPS']) {
        const file = await api.get(
          `/api/reports/kardex/xlsx?itemType=COIL&itemId=${scenario.coil.id}&from=2000-01-01&to=2100-01-01&method=${method}`,
        );
        expect(file.ok(), `El Excel ${method} debía bajar`).toBe(true);
        expect(file.headers()['content-type']).toContain('spreadsheetml');
        expect((await file.body()).subarray(0, 2).toString()).toBe('PK');
      }

      // --- Catálogo: búsqueda por SKU, en la URL ---
      await page.goto('/catalogo');
      await expect(page.getByRole('heading', { name: 'Catálogo', exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await page.getByRole('tab', { name: 'Coberturas Aluzinc' }).first().click();
      const search = page.getByLabel('Buscar productos por SKU o nombre').first();
      await search.fill(scenario.product.sku);
      await expect(page).toHaveURL(new RegExp(`q=${scenario.product.sku}`), { timeout: 30_000 });
      await expect(page.getByRole('row').filter({ hasText: scenario.product.sku })).toHaveCount(1);
      // D-323: el catálogo no tiene filtros por columna; los encabezados ordenan.
      await search.fill('');
      await expect(page).not.toHaveURL(/q=/);
      await expect(page.getByLabel('Filtrar por SKU')).toHaveCount(0);
      await search.fill('zzzz-no-existe');
      await expect(page.getByText(/Ningún producto de esta línea coincide/)).toBeVisible();

      // --- Reporte de la OP: de qué bobina salió el material ---
      await page.goto(`/produccion/${opId}`);
      // D-325: el detalle ya no trae la sección «Bobinas montadas en la orden»; de qué bobina salió
      // cada reporte se lee en la columna «Bobina / fleje».
      await expect(page.getByRole('heading', { name: 'Reportes de piezas' })).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        page.getByText(/Bobinas montadas en la orden|Flejes consumidos por la orden/),
      ).toHaveCount(0);
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
