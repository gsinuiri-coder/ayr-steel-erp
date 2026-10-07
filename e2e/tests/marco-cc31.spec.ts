import { expect, test, type Page } from '@playwright/test';
import { adminApi, adminCredentials, createUser } from '../helpers/api';
import { loginAndSetPassword } from '../helpers/ui';

/**
 * cc31 (corte 2): el marco de la app — «Ir a» con Ctrl K, la ruta de la barra superior, el menú
 * de usuario con «Cambiar contraseña» y la campana de pendientes. Lee y navega; el vendedor se
 * crea, así que nunca contra producción (D-126).
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea un usuario: nunca contra producción (D-126).');

async function loginAsAdmin(page: Page) {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
  // El atajo lo escucha el marco ya hidratado: se espera a que el menú esté en pantalla.
  await expect(page.getByRole('button', { name: /Ir a…/ })).toBeVisible({ timeout: 60_000 });
}

test.describe('cc31 — marco de la app', () => {
  test('Ctrl K abre «Ir a», busca sin tildes y Enter abre la pantalla', async ({ page }) => {
    await loginAsAdmin(page);
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Ir a' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Buscar pantalla o acción' }).fill('bob');
    await expect(dialog.getByRole('option').first()).toContainText('Bobinas');
    await expect(dialog.getByRole('group', { name: 'Crear' })).toContainText(
      'Nueva bobina desde XML',
    );
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/bobinas$/);
    await expect(dialog).toBeHidden();

    // La ruta de la barra superior reemplaza al «Volver»: grupo / lista.
    const crumbs = page.getByRole('navigation', { name: 'Ruta' });
    await expect(crumbs).toContainText('Almacén');
    await expect(crumbs.getByText('Bobinas')).toHaveAttribute('aria-current', 'page');

    // El botón del menú abre lo mismo; «Nueva cotización» lleva a crear.
    await page.getByRole('button', { name: /Ir a…/ }).click();
    await dialog.getByRole('combobox').fill('nueva cotizacion');
    await dialog.getByRole('option', { name: /Nueva cotización/ }).click();
    await expect(page).toHaveURL(/\/cotizaciones\/nueva$/);
    await expect(crumbs).toContainText('Nueva cotización');
    await crumbs.getByRole('link', { name: 'Cotizaciones' }).click();
    await expect(page).toHaveURL(/\/cotizaciones$/);
  });

  test('el menú de usuario lleva a «Cambiar contraseña»; la campana se abre', async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByRole('button', { name: /^Menú de / }).click();
    await page.getByRole('menuitem', { name: 'Cambiar contraseña' }).click();
    await expect(page).toHaveURL(/\/cambiar-contrasena$/);
    await expect(page.getByRole('heading', { name: 'Cambiar contraseña' })).toBeVisible();
    await expect(page.getByLabel('Contraseña actual')).toBeVisible();

    await page.getByRole('button', { name: /^Pendientes/ }).click();
    await expect(page.getByText('se actualiza cada minuto')).toBeVisible();
  });

  test('«Ir a» del vendedor no ofrece lo que su rol no puede abrir', async ({ page, baseURL }) => {
    const api = await adminApi(baseURL!);
    const seller = await createUser(api, 'VENDEDOR');
    await loginAndSetPassword(page, seller, 'ClaveVendedorCc31!');
    await expect(page.getByRole('button', { name: /Ir a…/ })).toBeVisible({ timeout: 60_000 });
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Ir a' });
    await dialog.getByRole('combobox').fill('compra');
    await expect(dialog).toContainText('Nada coincide con «compra».');
    await dialog.getByRole('combobox').fill('cotiz');
    await expect(dialog.getByRole('option', { name: /Nueva cotización/ })).toBeVisible();
  });
});
