import { expect, type Page } from '@playwright/test';
import type { CreatedUser } from './api';

/**
 * Inicia sesión con un usuario efímero recién creado (contraseña temporal) y
 * completa el cambio de contraseña obligatorio del primer ingreso.
 */
export async function loginAndSetPassword(
  page: Page,
  user: Pick<CreatedUser, 'email' | 'password'>,
  newPassword: string,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(user.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();

  await expect(page).toHaveURL(/\/cambiar-contrasena$/);
  await page.getByLabel('Contraseña actual').fill(user.password);
  await page.getByLabel('Nueva contraseña', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirmar nueva contraseña').fill(newPassword);
  await page.getByRole('button', { name: 'Guardar contraseña' }).click();
  await expect(page).toHaveURL(/\/$/);
}
