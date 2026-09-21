import { test, expect } from '@playwright/test';
import { adminApi, createUser, type CreatedUser } from '../helpers/api';
import { loginAndSetPassword } from '../helpers/ui';
import { setupCoilStock, createSellableProduct } from '../helpers/sales';

test.describe('Alcance de Vendedor (UI)', () => {
  let user: CreatedUser;
  let sellerEmail: string;
  let testSku: string;

  test.beforeAll(async ({ baseURL }) => {
    const api = await adminApi(baseURL!);
    user = await createUser(api, 'VENDEDOR', {
      name: 'Vendedor UI',
      password: 'password123',
    });
    sellerEmail = user.email;
    // Ensure we have some stock
    const { finish } = await setupCoilStock(api, {
      lineCode: 'metallic-roofing',
      thicknessMm: '0.43',
    });
    const p = await createSellableProduct(api, {
      lineCode: 'metallic-roofing',
      unit: 'MTR',
      roofingKind: 'A_MEDIDA',
      finishId: finish.id,
      thicknessMm: '0.43',
    });
    testSku = p.sku;
  });

  test('Vendedor agrega producto teórico desde catálogo (sin ver costos)', async ({ page }) => {
    await loginAndSetPassword(page, user, 'password123');

    // Navegar a crear cotización
    await page.goto('/cotizaciones/nueva');
    await expect(page).toHaveURL(/\/cotizaciones\/.+/);

    await page.getByRole('button', { name: 'Agregar producto' }).click();

    await page.getByPlaceholder(/Buscar/i).fill(testSku);
    await page.waitForTimeout(500);

    // El catálogo tiene tarjetas
    const producto = page
      .locator('div')
      .filter({ hasText: new RegExp(`^${testSku}`) })
      .first();

    // Verificar que el stock ML teórico aparece
    await expect(producto).toContainText(/ML/i);

    const textContent = await producto.textContent();
    expect(textContent).not.toMatch(/Rentabilidad/i);
    expect(textContent).not.toMatch(/Costo/i);

    // Agregar a la cotización
    await producto.getByRole('button', { name: 'Agregar' }).first().click();

    // Verificamos que se haya agregado a la tabla de líneas
    await expect(page.locator('table')).toContainText(testSku);
  });

  test('Dashboard del vendedor tiene sus cards y oculta los de admin', async ({ page }) => {
    let firedShortages = false;
    page.on('request', (req) => {
      if (req.url().includes('/sales/quotations/stock-shortages')) firedShortages = true;
    });
    await loginAndSetPassword(page, user, 'password123');
    await page.goto('/');

    await expect(page.getByText('Cotizaciones por vencer')).toBeVisible();
    await expect(page.getByText('Reservas por expirar')).toBeVisible();
    await expect(page.getByText('Pedidos en producci\xf3n')).toBeVisible();
    await expect(page.getByText('Pedidos listos')).toBeVisible();

    await expect(page.getByText('Cotizaciones sin stock disponible')).toBeHidden();
    await expect(page.getByText('Precios bajo el piso')).toBeHidden();

    expect(firedShortages).toBe(false);
  });
});
