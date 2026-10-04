import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getJson } from '../helpers/api';
import { deactivateTrail, type ProductDto } from '../helpers/production';
import {
  commitImport,
  customerCell,
  previewImport,
  toInput,
  type SheetRow,
} from '../helpers/quotation-import';
import {
  createCustomer,
  createQuotation,
  createSellableProduct,
  purgeSalesTrail,
  type CustomerDto,
} from '../helpers/sales';

/**
 * D-387 — el comprobante de las cotizaciones importadas, a la vista en la lista.
 *
 * El número de la factura de papel vive solo en la marca del importador (`Factura externa: …`,
 * primera línea de las observaciones, D-152). La lista lo muestra en una columna justo después
 * del número de cotización, lo ordena (serie y correlativo como número) y lo encuentra por el
 * buscador; la cotización que no se importó deja la celda vacía. El detalle lo repite en la
 * cabecera. Todo en la densidad de escritorio: sin scroll horizontal entre 1366 y 1920 px.
 *
 * Importa y anula cotizaciones: nunca contra producción (D-126, regla dura 9).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Importa cotizaciones: nunca contra producción (D-126, regla dura 9).');

test.describe.configure({ timeout: 240_000 });

interface ListedQuotation {
  id: string;
  code: string;
  externalInvoice: string | null;
}

/** Una serie propia de la corrida (`Z` + tres letras): aísla el orden de lo que ya hay en la base. */
function uniqueSeries(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXY';
  let out = 'Z';
  for (let i = 0; i < 3; i++) out += letters[Math.floor(Math.random() * letters.length)];
  return out;
}

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

async function listed(api: APIRequestContext, query: string): Promise<ListedQuotation[]> {
  return (
    await getJson<{ items: ListedQuotation[] }>(api, `/api/sales/quotations?pageSize=50&${query}`)
  ).items;
}

/** La tabla no se sale de su caja ni empuja la página: sin scroll horizontal. */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const table = document.querySelector('main table');
    const box = table?.parentElement;
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      table: box ? box.scrollWidth - box.clientWidth : -1,
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.table).toBeLessThanOrEqual(0);
}

test.describe('D-387 — comprobante en la lista de cotizaciones', () => {
  let api: APIRequestContext;
  let customer: CustomerDto;
  let product: ProductDto;
  const series = uniqueSeries();
  /** Correlativos elegidos para que el orden de texto y el numérico no coincidan. */
  const keys = [`${series}-1000`, `${series}-999`, `${series}-12`];
  const quotationIds: string[] = [];
  let manualId = '';

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
    customer = await createCustomer(api);
    product = await createSellableProduct(api, {
      lineCode: 'roofing',
      unit: 'KGM',
      listPricePen: '2.0000',
    });
    const rows: SheetRow[] = keys.map((documentKey) => ({
      issueDate: '03/08/2026',
      docType: 'Factura',
      documentKey,
      customer: customerCell(customer),
      sku: product.sku,
      productName: 'Material E2E D-387',
      unit: 'KILOGRAMO',
      qty: '100.000',
      netAmount: '200.00',
    }));
    const preview = await previewImport(api, rows);
    expect(preview.rows.flatMap((r) => r.issues.filter((i) => i.severity === 'error'))).toEqual([]);
    await commitImport(api, preview.rows.map(toInput));
    const manual = await createQuotation(api, {
      customerId: customer.id,
      businessLine: 'roofing',
      productId: product.id,
      qty: '10',
    });
    manualId = manual.id;
    const mine = await listed(api, `customerId=${customer.id}`);
    quotationIds.push(...mine.map((q) => q.id));
  });

  test.afterAll(async () => {
    await purgeSalesTrail(api, { quotationIds });
    await deactivateTrail(api, { productIds: [product.id], customerIds: [customer.id] });
    await api.dispose();
  });

  test('la API trae el comprobante, lo busca y lo ordena como número', async () => {
    const mine = await listed(api, `customerId=${customer.id}`);
    expect(mine.map((q) => q.externalInvoice).sort()).toEqual([...keys, null].sort());
    expect(mine.find((q) => q.id === manualId)?.externalInvoice).toBeNull();

    // El buscador: por la serie, por el número entero y sin distinguir mayúsculas.
    const bySeries = await listed(api, `search=${series.toLowerCase()}`);
    expect(bySeries.map((q) => q.externalInvoice).sort()).toEqual([...keys].sort());
    // Los dígitos del texto también se comparan con el número de cotización (`COT-…999`, que en
    // una base longeva existe): se miran solo las filas con comprobante.
    const byNumber = await listed(api, `search=${series}-999`);
    expect(byNumber.flatMap((q) => q.externalInvoice ?? [])).toEqual([`${series}-999`]);

    // Serie y correlativo como número: 12 < 999 < 1000 (como texto sería 1000 < 12 < 999).
    const asc = await listed(api, `search=${series}&sort=invoice&dir=asc`);
    expect(asc.map((q) => q.externalInvoice)).toEqual([
      `${series}-12`,
      `${series}-999`,
      `${series}-1000`,
    ]);
    const desc = await listed(api, `search=${series}&sort=invoice&dir=desc`);
    expect(desc.map((q) => q.externalInvoice)).toEqual([
      `${series}-1000`,
      `${series}-999`,
      `${series}-12`,
    ]);
    // Con la no importada en la lista, va detrás en los dos sentidos.
    const withManual = await listed(api, `customerId=${customer.id}&sort=invoice&dir=desc`);
    expect(withManual.at(-1)?.id).toBe(manualId);
  });

  test('la columna va después del código, ordena, se busca y no desborda entre 1366 y 1920 px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAsAdmin(page);
    await page.goto(`/cotizaciones?search=${customer.docNumber}`);
    const table = page.locator('main table');
    await expect(table.getByRole('row')).toHaveCount(1 + 4, { timeout: 60_000 });

    const headers = await table.getByRole('columnheader').allInnerTexts();
    expect(headers.map((h) => h.trim()).slice(0, 2)).toEqual(['Código', 'Comprobante']);

    const manualRow = table
      .getByRole('row')
      .filter({ has: page.locator(`a[href="/cotizaciones/${manualId}"]`) });
    await expect(manualRow.getByTestId('quotation-external-invoice')).toHaveText('');
    await expectNoHorizontalScroll(page);

    // Ordenar por la columna: clic asc, clic desc.
    const invoiceCells = table.getByTestId('quotation-external-invoice');
    await table.getByRole('columnheader', { name: 'Comprobante' }).click();
    await expect(page).toHaveURL(/sort=invoice/);
    await expect(invoiceCells).toHaveText([`${series}-12`, `${series}-999`, `${series}-1000`, '']);
    await table.getByRole('columnheader', { name: 'Comprobante' }).click();
    await expect(page).toHaveURL(/dir=desc/);
    await expect(invoiceCells).toHaveText([`${series}-1000`, `${series}-999`, `${series}-12`, '']);

    // El buscador de la lista encuentra por el comprobante.
    await page.goto('/cotizaciones');
    await page
      .getByPlaceholder('Buscar por código, comprobante, cliente o documento…')
      .fill(`${series}-999`);
    await expect(page).toHaveURL(new RegExp(`search=${series}-999`));
    await expect(invoiceCells.filter({ hasText: series })).toHaveText([`${series}-999`]);

    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`/cotizaciones?search=${customer.docNumber}`);
    await expect(table.getByRole('row')).toHaveCount(1 + 4, { timeout: 60_000 });
    await expectNoHorizontalScroll(page);
  });

  test('el detalle de la importada muestra el comprobante en la cabecera; la manual no', async ({
    page,
  }) => {
    const imported = (await listed(api, `search=${series}-999`)).find(
      (q) => q.externalInvoice === `${series}-999`,
    );
    await loginAsAdmin(page);
    await page.goto(`/cotizaciones/${imported!.id}`);
    await expect(page.getByTestId('quotation-external-invoice')).toHaveText(`${series}-999`, {
      timeout: 60_000,
    });
    await page.goto(`/cotizaciones/${manualId}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('quotation-external-invoice')).toHaveCount(0);
  });
});
