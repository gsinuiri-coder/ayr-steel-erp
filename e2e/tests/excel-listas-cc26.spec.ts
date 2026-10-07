import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, adminCredentials, createUser } from '../helpers/api';
import { apiAs } from '../helpers/production';
import { headerAction } from '../helpers/ui';

/**
 * cc26 (D-438, D-446, D-451) — el Excel de las listas.
 *
 * Que las filas y los totales sean los de la lista lo fijan los unitarios de cada exportación
 * (`*-export.spec.ts`: filas = todas las páginas, mismo filtro y orden). Aquí se prueba lo que
 * solo se ve con el sistema entero: cada ruta responde un xlsx, los roles son los de su lista y
 * cada pantalla ofrece el botón con los filtros que tiene puestos.
 *
 * Solo lee, pero entra como administrador de la suite: nunca contra producción (D-126).
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Suite local y CI: nunca contra producción (D-126).');

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function expectXlsx(api: APIRequestContext, path: string, filename: string) {
  const res = await api.get(path);
  expect(res.status(), path).toBe(200);
  expect(res.headers()['content-type']).toContain(XLSX_TYPE);
  expect(res.headers()['content-disposition']).toContain(filename);
}

test.describe('Excel de las listas (cc26)', () => {
  test('cada ruta responde un xlsx con los roles de su lista', async ({ baseURL }) => {
    const admin = await adminApi(baseURL!);
    await expectXlsx(admin, '/api/invoicing/documents/xlsx', 'comprobantes-');
    await expectXlsx(admin, '/api/invoicing/documents/xlsx?pendingOnly=true', 'comprobantes-');
    await expectXlsx(admin, '/api/sales/quotations/xlsx', 'cotizaciones-');
    await expectXlsx(admin, '/api/sales/orders/xlsx', '.xlsx');
    await expectXlsx(admin, '/api/purchases/xlsx', '.xlsx');
    await expectXlsx(admin, '/api/customers/xlsx', '.xlsx');
    await expectXlsx(admin, '/api/invoicing/receivables/xlsx', '.xlsx');
    // La página no viaja: el Excel trae todas las filas de los filtros (D-446).
    await expectXlsx(admin, '/api/sales/quotations/xlsx?page=3&pageSize=1', 'cotizaciones-');

    const sellerUser = await createUser(admin, 'VENDEDOR');
    const seller = await apiAs(baseURL!, sellerUser);
    await expectXlsx(seller, '/api/invoicing/documents/xlsx', 'comprobantes-');
    await expectXlsx(seller, '/api/sales/quotations/xlsx', 'cotizaciones-');
    await expectXlsx(seller, '/api/sales/orders/xlsx', '.xlsx');
    await expectXlsx(seller, '/api/customers/xlsx', '.xlsx');
    expect((await seller.get('/api/purchases/xlsx')).status()).toBe(403);
    expect((await seller.get('/api/invoicing/receivables/xlsx')).status()).toBe(403);
    await seller.dispose();

    const plantUser = await createUser(admin, 'SUPERVISOR_PLANTA');
    const plant = await apiAs(baseURL!, plantUser);
    await expectXlsx(plant, '/api/purchases/xlsx', '.xlsx');
    expect((await plant.get('/api/invoicing/documents/xlsx')).status()).toBe(403);
    expect((await plant.get('/api/sales/quotations/xlsx')).status()).toBe(403);
    await plant.dispose();
  });

  test('cada pantalla ofrece su Excel', async ({ page }) => {
    // Seis pantallas seguidas: con el web en modo desarrollo cada una se compila al entrar.
    test.setTimeout(150_000);
    const { email, password } = adminCredentials();
    await page.goto('/login');
    await page.getByLabel('Correo electrónico').fill(email);
    await page.getByLabel('Contraseña', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Ingresar' }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });

    // cc31: en las listas el Excel vive en «Más opciones» (el principal es crear); se abre el
    // menú para alcanzarlo.
    for (const [path, api] of [
      ['/comprobantes', '/api/invoicing/documents/xlsx'],
      ['/cotizaciones', '/api/sales/quotations/xlsx'],
      ['/pedidos', '/api/sales/orders/xlsx'],
      ['/compras', '/api/purchases/xlsx'],
      ['/clientes', '/api/customers/xlsx'],
    ] as const) {
      await page.goto(path);
      const item = await headerAction(page, 'Descargar Excel');
      await expect(item).toHaveAttribute('href', new RegExp(`^${api}`));
      await page.keyboard.press('Escape');
    }
    await page.goto('/cobranzas');
    await expect(page.locator('a[href^="/api/invoicing/receivables/xlsx"]').first()).toBeAttached({
      timeout: 30_000,
    });
  });

  test('cc28 (D-446): el clic descarga el archivo y un 400 del tope sale en un aviso', async ({
    page,
  }) => {
    const { email, password } = adminCredentials();
    await page.goto('/login');
    await page.getByLabel('Correo electrónico').fill(email);
    await page.getByLabel('Contraseña', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Ingresar' }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });

    // Un 2xx se descarga con el nombre que manda el API.
    await page.goto('/clientes');
    const link = await headerAction(page, 'Descargar Excel');
    await expect(link).toHaveAttribute('href', /^\/api\/customers\/xlsx/);
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);

    // El 400 del tope (más de 5000 filas) no se abre como JSON: sale en un aviso, y la página
    // sigue donde estaba. Se simula la respuesta: armar 5000 comprobantes no aporta nada.
    const message = 'La exportación tiene 6200 filas y el tope es 5000: acota los filtros.';
    await page.route('**/api/invoicing/documents/xlsx**', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ statusCode: 400, message }),
      }),
    );
    await page.goto('/comprobantes');
    const xlsx = await headerAction(page, 'Descargar Excel');
    await expect(xlsx).toHaveAttribute('href', /^\/api\/invoicing\/documents\/xlsx/);
    await xlsx.click();
    await expect(page.getByText(message)).toBeVisible();
    await expect(page).toHaveURL(/\/comprobantes/);
  });
});
