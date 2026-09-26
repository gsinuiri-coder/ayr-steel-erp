import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getJson } from '../helpers/api';
import { createCustomer } from '../helpers/sales';
import { rowAction } from '../helpers/ui';

/**
 * D-327 (correcciones 04, M5): en una tabla con varias acciones por fila, una principal visible y
 * el resto en un menú «⋯» (`RowActions`). Una tabla con una sola acción por fila no cambia.
 *
 * Crea clientes: nunca contra producción (D-126).
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea clientes: nunca contra producción (D-126).');
test.describe.configure({ timeout: 120_000 });

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

test.describe('D-327 — acciones de fila en un menú', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('clientes: «Editar» a la vista, «Desactivar» en «⋯»; el menú lleva el nombre de la fila', async ({
    page,
  }) => {
    const customer = await createCustomer(api);
    await loginAsAdmin(page);
    await page.goto(`/clientes?search=${customer.docNumber}`);
    const row = page.getByRole('row').filter({ hasText: customer.docNumber });
    await expect(row).toHaveCount(1, { timeout: 60_000 });

    // La principal está a la vista y las demás no: no hay un botón «Desactivar» suelto en la fila.
    await expect(row.getByRole('button', { name: 'Editar', exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Desactivar', exact: true })).toHaveCount(0);

    // El menú dice de qué fila es.
    const more = row.getByRole('button', { name: `Más acciones de ${customer.name}` });
    await more.click();
    await expect(page.getByRole('menuitem', { name: 'Desactivar', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Editar', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    // Esperar a que el menú termine de cerrarse: el helper de abajo lo vuelve a abrir con un clic.
    await expect(page.getByRole('menuitem', { name: 'Desactivar', exact: true })).toBeHidden();

    // Desactivar desde el menú (con el helper de los E2E) cambia el estado de verdad.
    await (await rowAction(page, customer.name, 'Desactivar')).click();
    await expect
      .poll(
        async () =>
          (await getJson<{ isActive: boolean }>(api, `/api/customers/${customer.id}`)).isActive,
        {
          timeout: 30_000,
        },
      )
      .toBe(false);
    // Y la fila ofrece lo contrario. Primero se espera a que la lista se reordene (el inactivo baja
    // al final): abrir el menú mientras la fila cambia de lugar lo cierra.
    await expect(row).toContainText('Inactivo', { timeout: 30_000 });
    // La lista puede volver a traerse y reordenarse justo después, y eso cierra un menú recién
    // abierto (falló en CI aun con la espera de arriba): se reintenta abrirlo hasta verlo.
    await expect(async () => {
      await page.keyboard.press('Escape');
      await row.getByRole('button', { name: `Más acciones de ${customer.name}` }).click();
      await expect(page.getByRole('menuitem', { name: 'Activar', exact: true })).toBeVisible({
        timeout: 3_000,
      });
    }).toPass({ timeout: 30_000 });
    await page.keyboard.press('Escape');
  });

  test('una lista sin acciones por fila (pedidos) no genera menús de fila', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/pedidos');
    await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-slot="row-actions"]')).toHaveCount(0);
  });
});
