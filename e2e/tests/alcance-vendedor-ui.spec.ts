import { test, expect } from '@playwright/test';
import { createUser, login } from '../helpers/api';
import { setupCoilStock } from '../helpers/sales';
import { Role } from '@ayr/shared';

test.describe('Alcance de Vendedor (UI)', () => {
  let sellerEmail: string;

  test.beforeAll(async ({ request }) => {
    sellerEmail = `vendedor-ui-${Date.now()}@test.com`;
    await createUser(request, {
      name: 'Vendedor UI',
      email: sellerEmail,
      role: Role.VENDEDOR,
      password: 'password123',
    });
    // Ensure we have some stock
    await setupCoilStock(request);
  });

  test('Vendedor agrega producto teórico desde catálogo (sin ver costos)', async ({ page }) => {
    await login(page, sellerEmail, 'password123');

    // Navegar a crear cotización
    await page.goto('/cotizaciones/nueva');
    await expect(page).toHaveURL(/\/cotizaciones\/.+/);

    await page.getByRole('button', { name: 'Agregar producto' }).click();

    await page.getByPlaceholder(/Buscar/i).fill('TR4');
    await page.waitForTimeout(500);

    // El catálogo tiene tarjetas
    const producto = page.locator('div').filter({ hasText: /^TR4/ }).first();

    // Verificar que el stock ML teórico aparece
    await expect(producto).toContainText(/ML/i);

    const textContent = await producto.textContent();
    expect(textContent).not.toMatch(/Rentabilidad/i);
    expect(textContent).not.toMatch(/Costo/i);

    // Agregar a la cotización
    await producto.getByRole('button', { name: 'Agregar' }).first().click();

    // Verificamos que se haya agregado a la tabla de líneas
    await expect(page.locator('table')).toContainText('TR4');
  });
});
