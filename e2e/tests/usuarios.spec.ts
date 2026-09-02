import { expect, test } from '@playwright/test';
import { adminApi, createUser } from '../helpers/api';

test.describe('Usuarios (RF-04)', () => {
  test.skip(!!process.env.E2E_BASE_URL, 'Crea datos: solo local/CI');

  test('un administrador crea un usuario desde la UI y aparece en la tabla', async ({
    page,
    baseURL,
  }) => {
    // Administrador desechable: no toca la contraseña del admin sembrado.
    const api = await adminApi(baseURL!);
    const admin = await createUser(api, 'ADMINISTRADOR');
    const newPassword = 'ClaveAdminE2E-2026';

    await page.goto('/login');
    await page.getByLabel('Correo electrónico').fill(admin.email);
    await page.getByLabel('Contraseña', { exact: true }).fill(admin.password);
    await page.getByRole('button', { name: 'Ingresar' }).click();

    // Primer ingreso: cambio de contraseña obligatorio.
    await expect(page).toHaveURL(/\/cambiar-contrasena$/);
    await page.getByLabel('Contraseña actual').fill(admin.password);
    await page.getByLabel('Nueva contraseña', { exact: true }).fill(newPassword);
    await page.getByLabel('Confirmar nueva contraseña').fill(newPassword);
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(page).toHaveURL(/\/$/);

    await page.getByRole('link', { name: 'Usuarios' }).click();
    await expect(page.getByRole('heading', { name: 'Usuarios' })).toBeVisible();

    const newEmail = `e2e-ui-${Date.now()}@ayr.test`;
    await page.getByRole('button', { name: 'Nuevo usuario' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Nombre').fill('Usuario E2E');
    await dialog.getByLabel('Correo electrónico').fill(newEmail);
    await dialog.getByLabel('Contraseña temporal').fill('Temporal123!');
    await dialog.getByRole('combobox', { name: 'Rol' }).click();
    await page.getByRole('option', { name: 'Vendedor' }).click();
    await dialog.getByRole('button', { name: 'Crear usuario' }).click();

    await expect(dialog).toBeHidden();
    const row = page.getByRole('row').filter({ hasText: newEmail });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Vendedor');
    await expect(row).toContainText('Activo');

    // El formulario de alta arranca vacío la segunda vez.
    await page.getByRole('button', { name: 'Nuevo usuario' }).click();
    await expect(page.getByRole('dialog').getByLabel('Correo electrónico')).toHaveValue('');
  });
});
