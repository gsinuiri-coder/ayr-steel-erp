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
            // El botón de la fila no siempre dice «Seleccionar» — F8-S3c/M4 le puso «Elegir»
            // al campo de cliente (`actionLabel`) — así que se busca por la fila, no por el
            // nombre accesible del botón.
            await modal
              .getByRole('row', { name: optionLabel })
              .getByRole('button')
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
 * Elige un producto en el picker de stock de una línea de cotización o pedido (D-188): el
 * campo **siempre** abre el modal —nunca decide por un `<select>` nativo, a diferencia de
 * `chooseOption`— porque el punto del picker es mostrar el disponible, que un `<option>` de
 * un desplegable no puede llevar. `productField` es el botón con
 * `aria-label="Producto de la línea N"`.
 */
export async function chooseProductWithStock(
  page: Page,
  productField: Locator,
  sku: string,
): Promise<void> {
  await productField.click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('Filtrar productos').fill(sku);
  await modal.getByRole('button', { name: `Elegir ${sku}`, exact: true }).click();
}

/**
 * F8-S3c/M1: en la vista de producción de un pedido (`/planta?pedido=`) la franja de chips
 * (`aria-label="Órdenes del pedido"`) trae de entrada **todas** las órdenes del pedido,
 * iniciadas o no — ya no hay un card de «Cola de producción» separado donde abrirlas primero.
 * Abrir una es un clic directo en su chip.
 *
 * El chip es un `<button>` cuyo rol accesible es `tab` (o ninguno en la forma de lista, con
 * más de `MAX_ORDER_TABS` órdenes) y no `button`: por eso se busca por la etiqueta de la
 * franja y no por `getByRole('button', …)`, que no lo encontraría.
 */
export async function openQueuedOrder(page: Page, code: string): Promise<void> {
  // Substring plano, no `\bcode\b`: el `textContent` del chip no lleva espacio entre el
  // código y el badge que sigue (`"OP-000001Sin bobina…"`, sin nodo de texto entre los dos
  // `<span>`), así que el `\b` de cierre nunca encuentra frontera de palabra —dígito seguido
  // de letra, los dos son `\w`— y el filtro no matchea nada: `chip.click()` queda esperando
  // por siempre a que aparezca un elemento que existe, pero con otro nombre. Un substring
  // simple es seguro porque los códigos son de ancho fijo con cero-relleno (`OP-000001` nunca
  // es substring de otro código real).
  const chip = page
    .locator('[aria-label="Órdenes del pedido"]')
    .locator('button')
    .filter({ hasText: code });
  await chip.click();
  await expect(chip).toHaveCount(1);
}

/**
 * F8-S3b/M3: una acción de la cabecera de una vista (`HeaderActions`). La principal es un
 * botón o enlace a la vista; las secundarias viven en el menú «Más acciones». Devuelve el
 * elemento a clickear, abriendo el menú si hace falta, para que el test no dependa de cuál de
 * las dos le tocó a la acción en el estado del documento.
 */
export async function headerAction(page: Page, name: string): Promise<Locator> {
  // Acotado a la cabecera: una tarjeta de la vista puede tener un botón con el mismo nombre.
  const header = page.locator('[data-slot="header-actions"]');
  const visible = header
    .getByRole('button', { name, exact: true })
    .or(header.getByRole('link', { name, exact: true }));
  const more = header.getByRole('button', { name: 'Más acciones' });
  await expect(visible.or(more).first()).toBeVisible({ timeout: 30_000 });
  if ((await visible.count()) > 0) return visible.first();
  await more.click();
  const item = page.getByRole('menuitem', { name, exact: true });
  await expect(item).toBeVisible();
  return item;
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
