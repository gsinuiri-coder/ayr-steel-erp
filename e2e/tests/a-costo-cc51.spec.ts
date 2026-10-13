import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, createUser, getJson, postJson } from '../helpers/api';
import { setupPosStock } from '../helpers/pos';
import { apiAs, deactivateTrail, ROLE_PASSWORD, today } from '../helpers/production';
import { createCustomer, purgeSalesTrail } from '../helpers/sales';

/**
 * cc51 (D-641) — vender a costo. Un producto comprado a S/ 20.00: el piso normal (margen mínimo
 * de la línea) es mayor; a costo, S/ 23.60 con IGV. El ADMINISTRADOR ve «Vender a costo» en la
 * línea de la cotización y la etiqueta «A costo» sale en la cotización y en el pedido; el
 * VENDEDOR, en la misma cotización, no ve la opción.
 */
test.describe.configure({ timeout: 600_000 });

let api: APIRequestContext;

test.beforeAll(async ({ baseURL }) => {
  api = await adminApi(baseURL!);
});

test.afterAll(async () => {
  await api.dispose();
});

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

interface QuotationDto {
  id: string;
  items: { atCostReason: string | null; unitPricePen: string }[];
}

test('el ADMINISTRADOR vende una línea a costo; el VENDEDOR no ve la opción', async ({
  baseURL,
  browser,
}) => {
  const stock = await setupPosStock(api, { qty: '40', unitPrice: '20' });
  const customer = await createCustomer(api);
  const seller = await createUser(api, 'VENDEDOR');
  const sellerApi = await apiAs(baseURL!, seller);
  const quotationIds: string[] = [];
  const orderIds: string[] = [];
  try {
    // La cotización es del vendedor, con una línea a un precio normal (sobre el piso).
    const quotation = await postJson<QuotationDto>(sellerApi, '/api/sales/quotations', {
      customerId: customer.id,
      issueDate: today(),
      items: [{ productId: stock.product.id, qty: '2.000', unitPriceWithIgvPen: '40.00' }],
    });
    quotationIds.push(quotation.id);

    // 1. El VENDEDOR edita su cotización: ve el mínimo, no «Vender a costo».
    const sellerContext = await browser.newContext();
    try {
      const page = await sellerContext.newPage();
      await login(page, seller.email, ROLE_PASSWORD);
      await page.goto(`/cotizaciones/${quotation.id}/editar`);
      await expect(page.getByLabel('Precio unitario de la línea 1')).toHaveValue('40.00', {
        timeout: 60_000,
      });
      await expect(page.getByText(/Mín\. /).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('button', { name: 'Vender a costo' })).toHaveCount(0);
      // La captura del informe (cc51): el vendedor, sin la opción.
      await page.screenshot({ path: test.info().outputPath('vendedor-sin-opcion.png') });
    } finally {
      await sellerContext.close();
    }

    // 2. El ADMINISTRADOR la pone a costo desde la misma pantalla y la guarda.
    const page = await browser.newPage();
    const { email, password } = adminCredentials();
    await login(page, email, password);
    await page.goto(`/cotizaciones/${quotation.id}/editar`);
    await expect(page.getByLabel('Precio unitario de la línea 1')).toHaveValue('40.00', {
      timeout: 60_000,
    });
    await page.getByRole('button', { name: 'Vender a costo' }).click();
    await page.getByLabel('Motivo').click();
    await page.getByRole('option', { name: 'Liquidación de stock' }).click();
    await page.getByRole('button', { name: 'Aplicar precio a costo' }).click();
    await expect(page.getByLabel('Precio unitario de la línea 1')).toHaveValue('23.60');
    await expect(page.getByText('A costo · Liquidación de stock')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('admin-linea-a-costo.png') });
    const put = page.waitForResponse(
      (r) =>
        r.request().method() === 'PUT' && r.url().includes(`/api/sales/quotations/${quotation.id}`),
    );
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    const response = await put;
    expect(response.status(), await response.text()).toBe(200);

    const saved = await getJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}`);
    expect(saved.items[0]).toMatchObject({ atCostReason: 'LIQUIDACION', unitPricePen: '20.0000' });

    // 3. La etiqueta, en el detalle de la cotización y en el del pedido.
    await page.goto(`/cotizaciones/${quotation.id}`);
    await expect(page.getByText('A costo · Liquidación de stock')).toBeVisible({ timeout: 60_000 });
    const order = await postJson<{ id: string }>(
      api,
      `/api/sales/quotations/${quotation.id}/confirm`,
      {},
    );
    orderIds.push(order.id);
    await page.goto(`/pedidos/${order.id}`);
    await expect(page.getByText('A costo · Liquidación de stock')).toBeVisible({ timeout: 60_000 });
    await page.close();
  } finally {
    await sellerApi.dispose();
    await purgeSalesTrail(api, { orderIds, quotationIds });
    await deactivateTrail(api, {
      purchaseId: stock.purchaseId,
      supplierId: stock.supplier.id,
      productIds: [stock.product.id],
    });
  }
});
