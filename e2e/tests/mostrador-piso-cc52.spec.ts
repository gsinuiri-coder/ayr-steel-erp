import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials } from '../helpers/api';
import {
  closeSessionQuietly,
  openCashSession,
  setupPosStock,
  type CashSessionDto,
} from '../helpers/pos';

/**
 * cc52 — D-643: el mostrador tiene el piso de la cotización y el carrito lo muestra; el
 * administrador puede marcar la línea «A costo». D-642: «Fecha de ingreso» en los filtros de
 * bobinas, en la URL.
 *
 * Compra a S/ 20 sin IGV con el margen mínimo de la semilla (10 %): mínimo S/ 26.23 con IGV, a
 * costo S/ 23.60. No vende (no gasta correlativo): lo que se prueba es el carrito.
 */

const allowWrites = process.env.E2E_ALLOW_WRITES === '1' || !process.env.E2E_BASE_URL;

test.describe.configure({ timeout: 180_000 });

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

test.describe('cc52 — mostrador con piso y filtro de bobinas', () => {
  test.skip(!allowWrites, 'Compra y abre caja: nunca contra producción (D-126).');

  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('D-643: el carrito muestra el mínimo, no cobra por debajo y el administrador vende a costo', async ({
    page,
  }) => {
    const stock = await setupPosStock(api, { qty: '10', unitPrice: '20', listPricePen: '50.0000' });
    let session: CashSessionDto | undefined;
    try {
      await loginAsAdmin(page);
      session = await openCashSession(api, '0.00');
      await page.goto('/pos');
      await page.getByPlaceholder('Buscar por código o nombre…').fill(stock.product.sku);
      const card = page.getByRole('button', { name: new RegExp(stock.product.sku) });
      await expect(card).toBeVisible({ timeout: 30_000 });
      await card.click();
      await page.getByRole('button', { name: 'Efectivo', exact: true }).click();

      const floor = page.getByTestId(`pos-line-floor-${stock.product.sku}`);
      await page.getByLabel('Precio unitario (con IGV)').fill('26.22');
      await expect(floor).toContainText('Mínimo: S/ 26.23');
      await expect(floor).toContainText('por debajo del piso');
      await expect(page.getByRole('button', { name: /^Cobrar/ })).toBeDisabled();

      await page.getByLabel('Precio unitario (con IGV)').fill('26.23');
      await expect(floor).not.toContainText('por debajo');
      await expect(page.getByRole('button', { name: /^Cobrar/ })).toBeEnabled();

      // «A costo»: el precio pasa a ser el costo con IGV y la etiqueta lo dice.
      await page.getByRole('button', { name: 'Vender a costo' }).click();
      await page.getByLabel('Motivo').click();
      await page.getByRole('option', { name: 'Liquidación de stock' }).click();
      await page.getByRole('button', { name: 'Aplicar precio a costo' }).click();
      await expect(page.getByLabel('Precio unitario (con IGV)')).toHaveValue('23.60');
      await expect(page.getByText('A costo · Liquidación de stock')).toBeVisible();
      await expect(floor).toContainText('A costo: S/ 23.60');
      await expect(page.getByRole('button', { name: /^Cobrar/ })).toBeEnabled();
    } finally {
      await closeSessionQuietly(api, session?.id);
    }
  });

  test('D-642: «Fecha de ingreso» en los filtros de bobinas, en la URL', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/bobinas?tab=todas');
    await page.getByRole('button', { name: /^Filtros/ }).click();
    await page.getByLabel('Fecha de ingreso desde').fill('2026-02-10');
    await page.getByLabel('Hasta').fill('2026-02-01');
    await page.getByRole('button', { name: 'Aplicar' }).click();
    await expect(
      page.getByText('La fecha de ingreso «Desde» es posterior a «Hasta».'),
    ).toBeVisible();
    await page.getByLabel('Hasta').fill('2026-02-20');
    await page.getByRole('button', { name: 'Aplicar' }).click();
    await expect(page).toHaveURL(/from=2026-02-10/);
    await expect(page).toHaveURL(/to=2026-02-20/);
    await expect(page.getByRole('button', { name: 'Filtros, 1 activo' })).toBeVisible();
  });
});
