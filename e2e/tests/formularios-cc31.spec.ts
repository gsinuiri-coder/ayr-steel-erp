import { FINISH_FIELD_LABEL } from '@ayr/shared';
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  adminApi,
  createFinish,
  createSupplier,
  createUser,
  finishOptionLabel,
  getItems,
} from '../helpers/api';
import { uniqueDocumentNumber } from '../helpers/production';
import { createCustomer } from '../helpers/sales';
import { loginAndSetPassword, selectOption } from '../helpers/ui';

/**
 * cc31 (ESPEC §6) — formularios de página con el modelo de despacho:
 *
 * - el botón principal no se apaga por un dato faltante: al pulsarlo no crea nada, marca el
 *   campo y la barra de abajo lista lo que falta, con enlace a cada campo;
 * - una línea libre del comprobante sin descripción ya no pasa;
 * - cambiar el tipo de compra con líneas cargadas pregunta antes de borrarlas.
 *
 * Crea un usuario, un proveedor, un acabado y un cliente de prueba (prefijo E2E) y los desactiva
 * al final; ninguna compra ni comprobante llega a crearse.
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea maestros de prueba: nunca contra producción (D-126).');
test.describe.configure({ timeout: 120_000 });

const ADMIN_PASSWORD = 'ClaveAdminE2E-2026';

let api: APIRequestContext;

test.beforeAll(async ({ baseURL }) => {
  api = await adminApi(baseURL!);
});

test.afterAll(async () => {
  await api.dispose();
});

test('nueva compra: con un dato faltante el botón sigue encendido, no crea nada y lista lo que falta', async ({
  page,
}) => {
  const admin = await createUser(api, 'ADMINISTRADOR');
  const supplier = await createSupplier(api);
  const finish = await createFinish(api);
  try {
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);
    await page.goto('/compras/nueva?tipo=COIL');
    await expect(page.getByRole('heading', { name: 'Nueva compra' })).toBeVisible({
      timeout: 60_000,
    });

    await selectOption(
      page,
      page.getByRole('combobox', { name: 'Proveedor' }),
      `${supplier.code} — ${supplier.name}`,
    );
    await page.getByLabel('Serie').fill('F001');
    await page.getByLabel('Número').fill(uniqueDocumentNumber());
    await selectOption(
      page,
      page.getByRole('combobox', { name: FINISH_FIELD_LABEL }),
      finishOptionLabel(finish),
    );
    await page.getByLabel('Descripción').fill('Bobina E2E sin peso');
    await page.getByLabel('Ancho', { exact: true }).fill('1200');
    await page.getByLabel('Espesor', { exact: true }).fill('0.9');
    await page.getByLabel('Precio por kg').fill('4');
    // Falta solo el peso.

    const submit = page.getByRole('button', { name: 'Registrar compra' });
    await expect(submit).toBeEnabled();
    await submit.click();

    const bar = page.locator('[data-slot="sticky-action-bar"]');
    await expect(bar).toContainText('Falta 1 dato:');
    await expect(bar.getByRole('link', { name: 'Bobina 1 · Peso' })).toBeVisible();
    await expect(page.getByText('Escribe una cantidad mayor que cero')).toBeVisible();
    await expect(page.getByLabel('Peso', { exact: true })).toBeFocused();
    await expect(submit).toBeEnabled();
    await expect(page).toHaveURL(/\/compras\/nueva/);

    // No se creó ninguna compra del proveedor.
    const purchases = await getItems<{ id: string }>(
      api,
      `/api/purchases?supplierId=${supplier.id}`,
    );
    expect(purchases).toHaveLength(0);

    // Completar el dato vacía la lista de faltantes.
    await page.getByLabel('Peso', { exact: true }).fill('2000');
    await expect(bar).not.toContainText('Falta');
  } finally {
    await api
      .patch(`/api/suppliers/${supplier.id}`, { data: { isActive: false } })
      .catch(() => undefined);
    await api
      .patch(`/api/finishes/${finish.id}`, { data: { isActive: false } })
      .catch(() => undefined);
  }
});

test('nuevo comprobante: una línea libre sin descripción no se puede guardar', async ({ page }) => {
  const admin = await createUser(api, 'ADMINISTRADOR');
  const customer = await createCustomer(api);
  try {
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);
    await page.goto('/comprobantes/nuevo');
    await expect(page.getByRole('heading', { name: 'Nuevo comprobante' })).toBeVisible({
      timeout: 60_000,
    });

    await selectOption(
      page,
      page.getByRole('combobox', { name: 'Cliente' }),
      `${customer.name} · ${customer.docNumber}`,
    );
    await page.getByLabel('Cantidad de la línea 1').fill('2');
    await page.getByLabel('Valor unitario de la línea 1').fill('10');

    const submit = page.getByRole('button', { name: 'Crear borrador' });
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(page.getByText('Escribe la descripción de la línea')).toBeVisible();
    await expect(page.getByLabel('Descripción de la línea 1')).toBeFocused();
    const bar = page.locator('[data-slot="sticky-action-bar"]');
    await expect(bar).toContainText('Falta 1 dato:');
    await expect(bar.getByRole('link', { name: 'Línea 1 · descripción' })).toBeVisible();
    await expect(page).toHaveURL(/\/comprobantes\/nuevo/);
  } finally {
    await api
      .patch(`/api/customers/${customer.id}`, { data: { isActive: false } })
      .catch(() => undefined);
  }
});

test('nueva compra: cambiar el tipo con líneas cargadas pide confirmación; sin líneas, cambia directo', async ({
  page,
}) => {
  const admin = await createUser(api, 'ADMINISTRADOR');
  await loginAndSetPassword(page, admin, ADMIN_PASSWORD);
  await page.goto('/compras/nueva?tipo=COIL');
  await expect(page.getByRole('heading', { name: 'Nueva compra' })).toBeVisible({
    timeout: 60_000,
  });
  const typeField = page.getByRole('combobox', { name: 'Tipo de compra' });
  const description = page.getByLabel('Descripción');

  await description.fill('Línea que no se debe perder');
  await selectOption(page, typeField, 'Gasto');

  const dialog = page.getByRole('dialog', { name: 'Cambiar el tipo de compra' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Cambiar el tipo borra la línea cargada.');

  // Cancelar deja el tipo y la línea como estaban.
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toBeHidden();
  await expect(typeField).toContainText('Bobinas');
  await expect(description).toHaveValue('Línea que no se debe perder');

  // Confirmar cambia el tipo y rehace las líneas.
  await selectOption(page, typeField, 'Gasto');
  await dialog.getByRole('button', { name: 'Cambiar igual' }).click();
  await expect(dialog).toBeHidden();
  await expect(typeField).toContainText('Gasto');
  await expect(description).toHaveValue('');

  // Sin nada escrito en las líneas, cambia sin preguntar.
  await selectOption(page, typeField, 'Servicio');
  await expect(typeField).toContainText('Servicio');
  await expect(dialog).toHaveCount(0);
});
