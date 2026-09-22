import { test, expect } from '@playwright/test';
import { adminApi, createUser, type CreatedUser } from '../helpers/api';
import { loginAndSetPassword } from '../helpers/ui';
import { setupCoilStock, createSellableProduct } from '../helpers/sales';

test.describe('Alcance de Vendedor (UI)', () => {
  let api: any;
  let finish: any;
  let testSku: string;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
    const res = await setupCoilStock(api, {
      lineCode: 'metallic-roofing',
      thicknessMm: '0.43',
    });
    finish = res.finish;
    const p = await createSellableProduct(api, {
      lineCode: 'metallic-roofing',
      unit: 'MTR',
      listPricePen: '15.00',
      roofingKind: 'A_MEDIDA',
      finishId: finish.id,
      thicknessMm: '0.43',
    });
    testSku = p.sku;
  });

  test('Vendedor agrega producto te贸rico desde cat谩logo (sin ver costos)', async ({
    page,
    baseURL,
  }) => {
    const user = await createUser(api, 'VENDEDOR', { name: 'Vendedor UI' });
    await loginAndSetPassword(page, user, 'Temp1234!');

    // Navegar a crear cotizaci贸n
    await page.goto('/cotizaciones/nueva');
    await expect(page).toHaveURL(/\/cotizaciones\/.+/);

    await page.getByRole('button', { name: 'Producto de la l韓ea 1' }).click();

    await page.getByPlaceholder(/Buscar/i).fill(testSku);
    await page.waitForTimeout(500);

    // El cat谩logo tiene tarjetas
    const producto = page
      .locator('div')
      .filter({ hasText: new RegExp(`^${testSku}`) })
      .first();

    // Verificar que el stock ML te贸rico aparece
    await expect(producto).toContainText(/ML/i);

    const textContent = await producto.textContent();
    expect(textContent).not.toMatch(/Rentabilidad/i);
    expect(textContent).not.toMatch(/Costo/i);

    // Agregar a la cotizaci贸n
    await producto.getByRole('button', { name: 'Agregar' }).first().click();

    // Verificamos que se haya agregado a la tabla de l铆neas
    await expect(page.locator('table')).toContainText(testSku);
  });

  test('Dashboard del vendedor tiene sus cards y oculta los de admin', async ({
    page,
    baseURL,
  }) => {
    const user = await createUser(api, 'VENDEDOR', { name: 'Vendedor UI 2' });
    let firedShortages = false;
    page.on('request', (req) => {
      if (req.url().includes('/sales/quotations/stock-shortages')) firedShortages = true;
    });
    await loginAndSetPassword(page, user, 'Temp1234!');
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
