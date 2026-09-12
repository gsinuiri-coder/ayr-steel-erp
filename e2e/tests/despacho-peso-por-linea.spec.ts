import { expect, test, type Page } from '@playwright/test';
import { adminApi, adminCredentials, createSupplier, postJson } from '../helpers/api';
import { today, uniqueDocumentNumber } from '../helpers/production';
import { createCustomer, createDirectOrder, createSellableProduct } from '../helpers/sales';

/**
 * F8-S1/M3 — el formulario de despacho pide el peso por línea que el API exige.
 *
 * Hallazgo (b) de S11 (docs/analisis/s11-inspeccion-flujos.md, F2-01): con transporte, el
 * API rechaza cualquier línea que no se mida en kilos si no llega `weightKg`, y el
 * formulario nunca lo pedía. La suite existente nunca lo vio porque despacha por API
 * (`e2e/helpers/invoicing.ts` arma el payload a mano); este caso pasa por la pantalla.
 *
 * Escenario: un producto de drywall (`NIU`, `pieceWeightKg = 6`) con stock propio — no
 * hace falta producción, un `PURCHASED` con `FINISHED_GOOD` recibido alcanza. Un pedido
 * directo (D-065) lo reserva de una. El despacho se arma en `/despachos/nuevo` con
 * transporte privado, que es exactamente la modalidad que antes no tenía dónde escribir
 * el peso.
 */

const isProduction = !!process.env.E2E_BASE_URL;

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  const logged = page.waitForResponse(
    (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Ingresar' }).click();
  expect((await logged).ok(), 'El login del admin debía responder 2xx').toBe(true);
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

/**
 * El campo no tiene `htmlFor`/`id` (S11/F2-02, no se toca en esta sesión): la única forma
 * estable de llegar al `<input>` es por el `<label>` hermano que lo antecede en el DOM.
 */
function inputAfterLabel(page: Page, label: string) {
  return page.locator(
    `xpath=//label[normalize-space(text())="${label}"]/following-sibling::input[1]`,
  );
}

function fieldGroup(page: Page, exactLabel: string) {
  return page.locator('div.space-y-1', { has: page.getByText(exactLabel, { exact: true }) });
}

test.describe('F8-S1/M3 — peso por línea en el despacho', () => {
  test('despacho con transporte de una línea que no se mide en kilos, por el formulario', async ({
    page,
    baseURL,
  }) => {
    test.skip(
      isProduction,
      'Crea proveedor, producto, pedido y despacho: nunca contra producción (D-126, regla dura 9).',
    );

    const api = await adminApi(baseURL!);
    const supplier = await createSupplier(api, { name: 'E2E Proveedor peso de línea' });
    // `pieceWeightKg: '6'` es lo que hace computable el kg teórico por unidad (D-118): el
    // formulario debería proponer 6 kg × la cantidad a despachar, sin que nadie lo calcule.
    const product = await createSellableProduct(api, {
      lineCode: 'drywall',
      listPricePen: '50.0000',
    });

    const purchase = await postJson<{ id: string }>(api, '/api/purchases', {
      supplierId: supplier.id,
      businessLine: 'drywall',
      type: 'FINISHED_GOOD',
      docType: 'FACTURA',
      series: 'F001',
      number: uniqueDocumentNumber(),
      issueDate: today(),
      currency: 'PEN',
      igvRate: '18',
      paymentTerms: 'CONTADO',
      items: [
        {
          productId: product.id,
          description: 'Producto E2E de drywall con stock propio',
          qty: '10',
          unit: 'NIU',
          unitPrice: '30',
        },
      ],
    });
    await postJson(api, `/api/purchases/${purchase.id}/receive`);

    const customer = await createCustomer(api);
    const order = await createDirectOrder(api, {
      customerId: customer.id,
      businessLine: 'drywall',
      items: [{ productId: product.id, qty: '5', unitPricePen: '50.0000' }],
    });

    await loginAsAdmin(page);
    await page.goto('/despachos/nuevo');
    await expect(page.getByRole('heading', { name: 'Nuevo despacho', level: 1 })).toBeVisible();

    const pedidoField = fieldGroup(page, 'Pedido').getByRole('combobox');
    await pedidoField.click();
    await page.getByRole('option', { name: `${order.code} · ${customer.name}` }).click();

    // La fila con el producto tiene que estar pintada antes de tocar sus campos.
    await expect(page.getByText(product.sku, { exact: true }).first()).toBeVisible({
      timeout: 20_000,
    });

    // Peso teórico propuesto: 6.000 kg/unidad × 5 unidades a despachar = 30.000 kg. Nadie
    // lo escribió — es la propuesta que F8-S1/M3 agrega, y es lo que antes no existía.
    const weightInput = page
      .locator('table tbody tr', { hasText: product.sku })
      .locator('input')
      .nth(1);
    await expect(weightInput).toHaveValue('30.000', { timeout: 20_000 });

    // Modalidad por defecto es "Transporte privado": es exactamente el caso que F2-01
    // reprodujo (no se podía despachar ninguna línea que no fuera en kilos).
    await inputAfterLabel(page, 'Dirección de partida').fill('Av. Almacén 100, Lima');
    await inputAfterLabel(page, 'Ubigeo de partida').fill('150101');
    await inputAfterLabel(page, 'Dirección de llegada').fill('Av. Cliente 200, Lima');
    await inputAfterLabel(page, 'Ubigeo de llegada').fill('150132');
    await inputAfterLabel(page, 'Placa').fill('ABC-123');
    await inputAfterLabel(page, 'Nombres del conductor').fill('Juan');
    await inputAfterLabel(page, 'Apellidos del conductor').fill('Pérez');
    await inputAfterLabel(page, 'Número de documento').fill('45678912');
    await inputAfterLabel(page, 'Licencia').fill('Q12345678');

    const created = page.waitForResponse(
      (r) => r.url().includes('/api/dispatches') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Despachar' }).click();
    const response = await created;
    expect(response.ok(), 'El despacho debía crearse con el peso propuesto por línea').toBe(true);

    await expect(page).toHaveURL(/\/despachos\/[0-9a-f-]+$/, { timeout: 20_000 });
    await expect(page.getByText('30.000 kg')).toBeVisible();
  });
});
