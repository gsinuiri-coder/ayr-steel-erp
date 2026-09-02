import { expect, type Locator, type Page } from '@playwright/test';
import type { CreatedUser } from './api';

/**
 * Elige una opción de un Select de shadcn/Radix: el disparador tiene rol `combobox` y
 * las opciones se montan en un portal fuera del formulario, por eso la opción se busca
 * en la página y no dentro del contenedor del campo.
 */
export async function selectOption(
  page: Page,
  combobox: Locator,
  optionName: string,
): Promise<void> {
  await combobox.click();
  await page.getByRole('option', { name: optionName }).click();
}

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
