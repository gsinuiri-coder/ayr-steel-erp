import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { FiscalDocumentDto, QuotationDto, SalesOrderDto } from '@ayr/shared';
import { adminApi, adminCredentials, getJson, postJson } from '../helpers/api';
import { createInvoice, createInvoiceableCustomer } from '../helpers/invoicing';
import { createQuotationWithLines, createSellableProduct, purgeSalesTrail } from '../helpers/sales';

/**
 * D-283 — la descripción de una línea se autocompleta con el nombre del producto, se edita en
 * la cotización y se hereda al pedido y al comprobante (que es lo que viaja a Nubefact como
 * `items[].descripcion`).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 150_000 });

test.describe('D-283 — descripción por línea', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('editada en la cotización, llega al pedido y al comprobante', async ({ page }) => {
    const product = await createSellableProduct(api, {
      lineCode: 'services',
      listPricePen: '100',
    });
    const customer = await createInvoiceableCustomer(api);
    const trail = { orderIds: [] as string[], quotationIds: [] as string[] };
    let invoiceId: string | null = null;
    try {
      const quotation = await createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: 'services',
        items: [{ productId: product.id, qty: '2', unitPricePen: '100' }],
      });
      trail.quotationIds.push(quotation.id);
      expect(quotation.items[0]?.description).toBe(product.name);

      await loginAsAdmin(page);
      await page.goto(`/cotizaciones/${quotation.id}/editar`);
      const field = page.getByLabel('Descripción de la línea 1');
      // Autocompletada con el nombre del producto.
      await expect(field).toHaveValue(product.name, { timeout: 60_000 });
      await field.fill('Instalación en obra, techo norte');
      await page.getByRole('button', { name: 'Guardar cambios' }).click();
      await expect(page).toHaveURL(new RegExp(`/cotizaciones/${quotation.id}$`), {
        timeout: 30_000,
      });
      await expect(page.getByText('Instalación en obra, techo norte')).toBeVisible();

      const saved = await getJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}`);
      expect(saved.items[0]?.description).toBe('Instalación en obra, techo norte');

      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
        {},
      );
      trail.orderIds.push(order.id);
      expect(order.items[0]?.description).toBe('Instalación en obra, techo norte');

      const invoice: FiscalDocumentDto = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: customer.id,
        salesOrderId: order.id,
        items: [{ salesOrderItemId: order.items[0]!.id, qty: '2' }],
      });
      invoiceId = invoice.id;
      expect(invoice.items[0]?.description).toBe('Instalación en obra, techo norte');
    } finally {
      if (invoiceId) await api.delete(`/api/invoicing/documents/${invoiceId}`).catch(() => {});
      await purgeSalesTrail(api, trail);
    }
  });
});

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}
