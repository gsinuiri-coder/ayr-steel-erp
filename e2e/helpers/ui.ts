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

/*
 * Un `SearchSelectField` (D-156) **cambia de forma según cuántas opciones tenga**: hasta
 * `SEARCH_SELECT_THRESHOLD` (20) es un `<select>` nativo y por encima un botón que abre el
 * modal de búsqueda. Los tres helpers de abajo existen por eso, y no por gusto:
 *
 * - **Cuál de las dos formas toca no se sabe de antemano.** Depende de cuántas filas tenga el
 *   maestro cuando la pantalla carga, que es un dato del entorno y no del test.
 * - **Y la forma cambia bajo los pies.** Mientras el maestro viaja hay cero opciones, o sea un
 *   `<select>` vacío que un instante después puede volverse el botón del modal. Mirar la forma
 *   una sola vez es una carrera que falla con «Element is not a <select> element», un error que
 *   no se parece en nada a su causa. Por eso todo va por `expect.poll`.
 *
 * Vivían dentro del spec del importador, que era la única pantalla que usaba el componente.
 * Desde que la cotización lo usa también, están acá.
 */

async function isNativeSelect(field: Locator): Promise<boolean> {
  return (await field.evaluate((el) => el.tagName.toLowerCase())) === 'select';
}

/**
 * Lo que el campo muestra como elegido, sea cual sea su forma. En el `<select>` es el texto de
 * la opción seleccionada y en el botón su propio texto; con nada elegido, los dos dicen el
 * placeholder, así que «no hay nada elegido» también se comprueba con esta función.
 */
export async function chosenLabelOf(field: Locator): Promise<string> {
  return field.evaluate((el) =>
    el instanceof HTMLSelectElement
      ? (el.selectedOptions[0]?.textContent?.trim() ?? '')
      : (el.textContent?.trim() ?? ''),
  );
}

export async function expectChosen(field: Locator, label: string): Promise<void> {
  await expect.poll(() => chosenLabelOf(field), { timeout: 20_000 }).toBe(label);
}

/** Elige una opción por su etiqueta visible, en cualquiera de las dos formas del campo. */
export async function chooseOption(page: Page, field: Locator, optionLabel: string): Promise<void> {
  await expect
    .poll(
      async () => {
        if ((await chosenLabelOf(field)) === optionLabel) return true;
        try {
          if (await isNativeSelect(field)) {
            await field.selectOption({ label: optionLabel }, { timeout: 2_000 });
          } else {
            await field.click({ timeout: 2_000 });
            const modal = page.getByRole('dialog');
            await modal.getByLabel('Filtrar opciones').fill(optionLabel, { timeout: 2_000 });
            await modal
              .getByRole('button', { name: `Seleccionar ${optionLabel}`, exact: true })
              .click({ timeout: 2_000 });
          }
        } catch {
          // El maestro todavía no llegó (la opción no existe) o el campo cambió de forma
          // entre el sondeo y el clic: se reintenta con la forma que tenga en el intento
          // siguiente, que es exactamente lo que haría una persona mirando la pantalla.
          return false;
        }
        return (await chosenLabelOf(field)) === optionLabel;
      },
      { timeout: 30_000, intervals: [300, 700, 1_500] },
    )
    .toBe(true);
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
