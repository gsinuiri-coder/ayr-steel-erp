import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials } from '../helpers/api';
import { purgeRoofingTrail, setupRoofingScenario, type RoofingScenario } from '../helpers/roofing';

/**
 * cc31 (corte 6): lo nuevo del formulario de cotización que ningún spec anterior cubre.
 *
 * - El selector de producto filtra por línea de negocio, y elegir un producto de otra línea
 *   cambia la línea de la fila. cc36: la línea se elige dentro del selector (sin desplegable en la
 *   fila) y se lee bajo el producto, «línea de negocio · subtipo».
 * - Elegir con Enter deja el foco en la cantidad (en una línea a medida, las planchas del primer
 *   largo).
 * - Bajo el mínimo, «Usar X» solo escribe el mínimo en el precio; la barra inferior deja de listar
 *   la línea. La regla del piso sigue siendo la de siempre (D-163): esto es una ayuda.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 120_000 });

function trailOf(s: RoofingScenario) {
  return {
    supplierId: s.supplier.id,
    finishId: s.finish.id,
    colorId: s.color.id,
    productIds: [s.product.id],
    coilIds: [s.coil.id],
    purchaseIds: [s.purchaseId],
    orderIds: [] as string[],
    quotationIds: [] as string[],
  };
}

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

test.describe('cc31 (corte 6) — formulario de cotización', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('el selector cambia la línea de la fila, Enter deja el foco en la cantidad y «Usar» escribe el mínimo', async ({
    page,
  }) => {
    const s = await setupRoofingScenario(api, { weightKg: '500' });
    const trail = trailOf(s);
    try {
      await loginAsAdmin(page);
      await page.goto('/cotizaciones/nueva');

      // La fila nueva abre el selector en «Todas»; se filtra por Drywall y el producto es de
      // Coberturas Aluzinc.
      const productField = page.getByLabel('Producto de la línea 1');
      await productField.click();
      const dialog = page.getByRole('dialog', { name: /^Elegir producto · / });
      await expect(dialog.getByText('Elegir producto · línea 1')).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Todas', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await dialog.getByRole('button', { name: 'Drywall', exact: true }).click();
      const roofing = dialog.getByRole('button', { name: 'Coberturas Aluzinc', exact: true });
      await roofing.click();
      await expect(roofing).toHaveAttribute('aria-pressed', 'true');

      await dialog.getByLabel('Filtrar productos').fill(s.product.sku);
      const row = dialog.getByRole('row', { name: `Elegir ${s.product.sku}` });
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.focus();
      await page.keyboard.press('Enter');

      await expect(dialog).toBeHidden();
      await expect(productField).toContainText(s.product.sku);
      await expect(page.getByRole('cell').filter({ has: productField })).toContainText(
        'Coberturas Aluzinc · a medida',
      );
      const firstPieces = page.getByLabel('Planchas del largo 1 de la línea 1');
      await expect(firstPieces).toBeFocused();

      // Un precio bajo el mínimo: la línea lo dice y la barra la lista.
      await firstPieces.fill('1');
      await page.getByLabel('Largo 1 de la línea 1 en metros').fill('5');
      const price = page.getByLabel('Precio unitario de la línea 1');
      await price.fill('1');
      await expect(page.getByText(/^Bajo el mínimo de /)).toBeVisible({ timeout: 15_000 });
      const barLink = page.getByRole('link', { name: 'Línea 1 · precio bajo el mínimo' });
      await expect(barLink).toBeVisible();

      // «Usar X» solo escribe X en el precio.
      const use = page.getByRole('button', { name: /^Usar / });
      const label = (await use.textContent()) ?? '';
      const minimum = label.replace('Usar', '').replaceAll(',', '').trim();
      expect(minimum).toMatch(/^\d+\.\d{2}$/);
      await use.click();
      await expect(price).toHaveValue(minimum);
      await expect(barLink).toHaveCount(0);
      await expect(page.getByText(/^Bajo el mínimo de /)).toHaveCount(0);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});
