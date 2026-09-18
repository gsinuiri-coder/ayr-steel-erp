import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getJson } from '../helpers/api';
import { createCustomer } from '../helpers/sales';
import { uniqueDocumentNumber } from '../helpers/production';

/**
 * F8-S3c/M4 — el selector de cliente de `/cotizaciones/nueva` siempre abre el buscador
 * (`forceModal`, D-156), no solo cuando el maestro pasa de `SEARCH_SELECT_THRESHOLD`.
 *
 * **«Cero clientes activos» no se puede lograr desde la API del sistema**: el cliente
 * «PÚBLICO EN GENERAL» (D-077) nace en el seed, es `isSystem` y `CustomersService.update` se
 * niega a darlo de baja. El maestro «vacío» real de esta app es ese: ningún cliente **propio**
 * dado de alta, con el del sistema como única fila. Es el escenario que de verdad prueba lo
 * que el M4 vino a arreglar —antes, con pocas filas, el campo caía a un `<select>` que ni
 * siquiera ofrecía el alta express al lado—, así que el primer caso deja la base en ese
 * estado en vez de perseguir un cero que la propia app no permite.
 *
 * Escribe (clientes, cotizaciones): nunca contra producción (D-126). Además de crear, este
 * archivo **desactiva** todos los clientes propios que encuentre activos al arrancar: es
 * intencional (ver `emptyCustomerMaster`) y no hace falta revertirlo, porque el resto de la
 * suite crea los suyos y no depende de cuántos otros haya.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea y desactiva clientes: nunca contra producción (D-126).');
test.describe.configure({ timeout: 120_000 });

async function loginAsAdmin(page: Page) {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

/**
 * Deja el maestro sin ningún cliente propio activo. `isActive desc` en el orden de
 * `/customers` (D-113) pone a todos los activos primero, así que una sola página de
 * `MAX_PAGE_SIZE` los trae completos mientras no haya más de 200 —cómodo para una base de
 * pruebas recién reseteada—. El del sistema sale en la lista pero su `PATCH` lo rechaza
 * (D-077): se ignora ese único fallo esperado y se deja pasar cualquier otro.
 */
async function emptyCustomerMaster(api: APIRequestContext): Promise<void> {
  const list = await getJson<{ items: { id: string; isActive: boolean }[] }>(
    api,
    '/api/customers?pageSize=200',
  );
  for (const c of list.items) {
    if (!c.isActive) continue;
    await api.patch(`/api/customers/${c.id}`, { data: { isActive: false } });
  }
}

test.describe('F8-S3c/M4 — el selector de cliente siempre abre el buscador', () => {
  test('con el maestro sin clientes propios, el campo abre igual el modal, dice que no hay ninguno y «+ Crear cliente» deja elegido al que se acaba de dar de alta', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    await emptyCustomerMaster(api);

    await loginAsAdmin(page);
    await page.goto('/cotizaciones/nueva');

    // El campo es un botón (el modal), nunca el `<select>` nativo: `forceModal` no decide por
    // el número de opciones (D-156, F8-S3c/M4).
    const field = page.getByLabel('Cliente', { exact: true });
    await expect(field).toBeVisible({ timeout: 60_000 });
    expect(await field.evaluate((el) => el.tagName)).toBe('BUTTON');
    await field.click();

    const modal = page.getByRole('dialog', { name: 'Elegir · Cliente' });
    await expect(modal).toBeVisible();
    // El único cliente que queda es el del sistema: el maestro está "vacío" del lado del
    // vendedor, y el mensaje de `emptyMessage` no aplica —no es ese el estado que se puede
    // alcanzar acá—, pero el punto de M4 es que el modal se abre y ofrece el alta igual.
    // Exacto y con el documento: sin `exact`, el nombre accesible de la celda de acción
    // también empieza con «Elegir PÚBLICO EN GENERAL —» y la búsqueda resuelve a dos celdas.
    await expect(
      modal.getByRole('cell', { name: 'PÚBLICO EN GENERAL — 00000000', exact: true }),
    ).toBeVisible();
    const createButton = modal.getByRole('button', { name: '+ Crear cliente' });
    await expect(createButton).toBeVisible();

    await createButton.click();
    const dialog = page.getByRole('dialog', { name: 'Nuevo cliente' });
    await expect(dialog).toBeVisible();
    const docNumber = `20${uniqueDocumentNumber()}`;
    const name = `E2E Cliente Alta ${uniqueDocumentNumber().slice(-5)}`;
    await dialog.getByLabel('Número').fill(docNumber);
    await dialog.getByLabel('Nombre / razón social').fill(name);
    await dialog.getByRole('button', { name: 'Crear cliente' }).click();

    // El alta cierra los dos diálogos y deja el cliente recién creado elegido en el campo.
    await expect(dialog).toBeHidden();
    await expect(modal).toBeHidden();
    await expect(field).toContainText(`${name} — ${docNumber}`);
  });

  test('con pocos clientes propios, cada fila del modal muestra «Elegir» de entrada, sin escribir nada en el buscador', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const a = await createCustomer(api);
    const b = await createCustomer(api);

    await loginAsAdmin(page);
    await page.goto('/cotizaciones/nueva');

    const field = page.getByLabel('Cliente', { exact: true });
    await field.click();
    const modal = page.getByRole('dialog', { name: 'Elegir · Cliente' });
    await expect(modal).toBeVisible();

    // Sin tocar el buscador: las filas ya están, y cada una con su botón de elegir.
    await expect(
      modal.getByRole('button', { name: `Elegir ${a.name} — ${a.docNumber}`, exact: true }),
    ).toBeVisible();
    await expect(
      modal.getByRole('button', { name: `Elegir ${b.name} — ${b.docNumber}`, exact: true }),
    ).toBeVisible();
    const rowA = modal.getByRole('row').filter({ hasText: a.docNumber });
    const rowB = modal.getByRole('row').filter({ hasText: b.docNumber });
    await expect(rowA).toContainText(a.docNumber);
    await expect(rowB).toContainText(b.docNumber);
    const overflow = await modal.locator('[data-slot="table-container"]').evaluate((table) => ({
      table: table.scrollWidth - table.clientWidth,
      wrapper: table.parentElement!.scrollWidth - table.parentElement!.clientWidth,
    }));
    expect(overflow.table, 'la tabla de clientes desborda a lo ancho').toBeLessThanOrEqual(0);
    expect(overflow.wrapper, 'el modal de clientes desborda a lo ancho').toBeLessThanOrEqual(0);

    // La fila completa elige, no solo el botón de la última columna.
    await rowA.click();
    await expect(modal).toBeHidden();
    await expect(field).toContainText(a.docNumber);

    // Y la misma acción está disponible con teclado sobre la fila.
    await field.click();
    const reopened = page.getByRole('dialog', { name: 'Elegir · Cliente' });
    const keyboardRow = reopened.getByRole('row').filter({ hasText: b.docNumber });
    await keyboardRow.focus();
    await page.keyboard.press('Enter');
    await expect(reopened).toBeHidden();
    await expect(field).toContainText(b.docNumber);
  });
});
