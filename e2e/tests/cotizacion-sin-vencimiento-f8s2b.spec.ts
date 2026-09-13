import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getJson } from '../helpers/api';
import { clearQuotationValidity } from '../helpers/db';
import {
  createCustomer,
  createQuotation,
  createSellableProduct,
  purgeSalesTrail,
} from '../helpers/sales';

/**
 * F8-S2b/M3 — el campo de vigencia en una cotización sin vencimiento (D-157).
 *
 * `PUT /sales/quotations/:id` no puede expresar "sin vencimiento" (D-157: la única forma de
 * llegar ahí es el importador, por código): editar una cotización así la deja sin vencimiento
 * igual, ignorando lo que traiga `validityDays`. Antes el formulario mostraba el campo
 * `Vigencia (días)` como si tipear algo ahí cambiara eso — no cambiaba nada, y el vendedor no
 * tenía forma de saberlo.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 60_000 });

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

test.describe('F8-S2b/M3 — vigencia de una cotización sin vencimiento', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('D-157: el formulario no pide vigencia, y guardar la deja igual de sin vencimiento', async ({
    page,
  }) => {
    const product = await createSellableProduct(api, {
      lineCode: 'roofing',
      listPricePen: '10.0000',
    });
    const customer = await createCustomer(api);
    const quotation = await createQuotation(api, {
      customerId: customer.id,
      businessLine: 'roofing',
      productId: product.id,
      qty: '2',
      unitPricePen: '10',
    });
    await clearQuotationValidity(quotation.id);
    const before = await getJson<{ validUntil: string | null }>(
      api,
      `/api/sales/quotations/${quotation.id}`,
    );
    expect(before.validUntil).toBeNull();

    try {
      await loginAsAdmin(page);
      await page.goto(`/cotizaciones/${quotation.id}/editar`);
      await expect(page.getByLabel('Precio unitario de la línea 1')).toHaveValue('11.8000', {
        timeout: 30_000,
      });

      // Ni el campo editable ni su rótulo de siempre: solo la nota de que no aplica acá.
      await expect(page.getByLabel('Vigencia (días)')).toHaveCount(0);
      await expect(page.getByText(/[Ss]in vencimiento/)).toBeVisible();

      await page.getByLabel('Precio unitario de la línea 1').fill('12.00');
      const put = page.waitForResponse(
        (r) =>
          r.request().method() === 'PUT' &&
          r.url().includes(`/api/sales/quotations/${quotation.id}`),
      );
      await page.getByRole('button', { name: 'Guardar cambios' }).click();
      const response = await put;
      expect(response.status(), await response.text()).toBe(200);

      const after = await getJson<{ validUntil: string | null }>(
        api,
        `/api/sales/quotations/${quotation.id}`,
      );
      expect(after.validUntil, 'sigue sin vencimiento después de editarla').toBeNull();
    } finally {
      await purgeSalesTrail(api, { quotationIds: [quotation.id] });
    }
  });
});
