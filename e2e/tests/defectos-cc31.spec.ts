import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { addDays } from '@ayr/shared';
import { adminApi, adminCredentials, getItems, getJson } from '../helpers/api';
import { createCustomer } from '../helpers/sales';
import { randomLetters, today, uniqueDocumentNumber } from '../helpers/production';
import { rowAction } from '../helpers/ui';

/**
 * cc31 (ESPEC §6, «Defectos concretos»): desactivar pide confirmación, el correo se valida en el
 * formulario y el tipo de cambio de una fecha ya cargada no se reemplaza sin avisar.
 *
 * Crea clientes y tipos de cambio: nunca contra producción (D-126).
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos: nunca contra producción (D-126).');
test.describe.configure({ timeout: 120_000 });

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

interface ExchangeRateRow {
  date: string;
  currency: string;
  buy: string;
  sell: string;
}

test.describe('cc31 — defectos concretos de formularios', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('desactivar un cliente pide confirmación y «Cancelar» no lo desactiva', async ({ page }) => {
    const customer = await createCustomer(api);
    await loginAsAdmin(page);
    await page.goto(`/clientes?search=${customer.docNumber}`);
    const row = page.getByRole('row').filter({ hasText: customer.docNumber });
    await expect(row).toHaveCount(1, { timeout: 60_000 });

    await (await rowAction(page, customer.name, 'Desactivar')).click();
    const confirm = page.getByRole('dialog');
    await expect(
      confirm.getByRole('heading', { name: `Desactivar a ${customer.name}` }),
    ).toBeVisible();
    await expect(confirm.getByText('Qué va a pasar')).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancelar' }).click();
    await expect(confirm).toBeHidden();

    // Sigue activo: ni la fila ni el API cambiaron.
    await expect(row).toContainText('Activo');
    const after = await getJson<{ isActive: boolean }>(api, `/api/customers/${customer.id}`);
    expect(after.isActive).toBe(true);
  });

  test('un correo inválido en el alta de cliente no se guarda y dice cómo corregirlo', async ({
    page,
  }) => {
    const docNumber = `20${uniqueDocumentNumber()}`;
    await loginAsAdmin(page);
    await page.goto('/clientes');
    await page.getByRole('button', { name: 'Nuevo cliente' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Número').fill(docNumber);
    await dialog.getByLabel('Nombre / razón social').fill(`E2E Correo ${randomLetters(5)}`);
    await dialog.getByLabel('Correo').fill('no-es-un-correo');
    await dialog.getByRole('button', { name: 'Crear cliente' }).click();

    await expect(
      dialog.getByText('Escribe un correo válido, como nombre@empresa.pe'),
    ).toBeVisible();
    await expect(dialog).toBeVisible();
    const found = await getItems<{ docNumber: string }>(api, `/api/customers?search=${docNumber}`);
    expect(found).toHaveLength(0);
  });

  test('el tipo de cambio de una fecha ya cargada pide confirmación antes de reemplazarlo', async ({
    page,
  }) => {
    // Una fecha del último año poco usada por otros specs, para no pisar un tipo de cambio que
    // otro test esté leyendo.
    const date = addDays(today(), -(120 + Math.floor(Math.random() * 200)));
    const put = await api.put('/api/exchange-rates/manual', {
      data: { date, currency: 'USD', buy: '3.7400', sell: '3.7500' },
    });
    expect(put.ok()).toBe(true);

    await loginAsAdmin(page);
    await page.goto('/configuracion/tipo-cambio');
    await expect(page.getByRole('heading', { name: 'Tipo de cambio' })).toBeVisible({
      timeout: 60_000,
    });
    const [y, m, d] = date.split('-');
    const shown = `${d}/${m}/${y}`;
    // La fecha de la tabla va en dd/mm/aaaa, no en ISO.
    await expect(page.getByRole('cell', { name: shown, exact: true }).first()).toBeVisible();

    await page.getByLabel('Fecha').fill(date);
    await page.getByLabel('Compra').fill('3.7900');
    await page.getByLabel('Venta').fill('3.8000');
    await page.getByRole('button', { name: 'Guardar', exact: true }).click();

    const confirm = page.getByRole('dialog');
    await expect(confirm).toContainText(`Ya hay un tipo de cambio para el ${shown}`);
    await expect(confirm).toContainText('venta S/ 3.7500');
    await expect(confirm).toContainText('venta S/ 3.8000');

    // Cancelar no reemplaza.
    await confirm.getByRole('button', { name: 'Cancelar' }).click();
    await expect(confirm).toBeHidden();
    const rateOf = async () =>
      (await getJson<ExchangeRateRow[]>(api, '/api/exchange-rates')).find(
        (r) => r.date === date && r.currency === 'USD',
      );
    expect((await rateOf())?.sell).toBe('3.7500');

    // Confirmar sí.
    await page.getByRole('button', { name: 'Guardar', exact: true }).click();
    await confirm
      .getByRole('button', { name: `Reemplazar el tipo de cambio del ${shown}` })
      .click();
    await expect(confirm).toBeHidden();
    await expect.poll(async () => (await rateOf())?.sell, { timeout: 30_000 }).toBe('3.8000');
  });
});
