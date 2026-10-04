import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, createSupplier, getJson, postJson } from '../helpers/api';
import {
  createInvoice,
  purgeInvoicingTrail,
  type FiscalDocumentDto,
  type InvoicingTrail,
} from '../helpers/invoicing';
import {
  deactivateTrail,
  today,
  uniqueDocumentNumber,
  type ProductDto,
} from '../helpers/production';
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
  type SalesOrderDto,
} from '../helpers/sales';

/**
 * D-387 — la columna «Comprobante» de la lista de cotizaciones, en sus cuatro estados.
 *
 * El número del Excel vive solo en la marca del importador (`Factura externa: …`, D-152), y no
 * es un comprobante: hasta que el pedido de la cotización tiene una factura o boleta vigente en
 * el sistema, la columna lo muestra en gris («solo referencia»). Con comprobante vigente muestra
 * el del sistema, con check y enlace («registrado»), o en ámbar si su número no es el del Excel
 * («no coincide»). Sin una cosa ni la otra queda vacía. Un comprobante anulado no cuenta.
 *
 * Importa, confirma y factura: nunca contra producción (D-126, regla dura 9).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Importa y factura: nunca contra producción (D-126, regla dura 9).');

test.describe.configure({ timeout: 300_000 });

const LINE = 'roofing';

interface ListedQuotation {
  id: string;
  code: string;
  externalInvoice: string | null;
  invoiceDocuments: { id: string; number: string }[];
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

test.describe('D-387 — estados de la columna «Comprobante»', () => {
  let api: APIRequestContext;
  let customer: CustomerDto;
  let product: ProductDto;
  let supplierId = '';
  let purchaseId = '';
  const series = uniqueSeries();
  /** Del Excel: los correlativos se eligen para que el orden de texto y el numérico no coincidan. */
  const keys = {
    reference: `${series}-12`,
    registered: `${series}-999`,
    mismatch: `${series}-1000`,
    annulled: `${series}-77`,
  };
  const ids: Record<keyof typeof keys | 'none', string> = {
    reference: '',
    registered: '',
    mismatch: '',
    annulled: '',
    none: '',
  };
  const trail: InvoicingTrail = { documentIds: [], orderIds: [] };

  /** Confirma la cotización y registra a mano su factura con el correlativo indicado. */
  async function invoice(quotationId: string, correlative: number): Promise<FiscalDocumentDto> {
    const order = await postJson<SalesOrderDto>(
      api,
      `/api/sales/quotations/${quotationId}/confirm`,
      {},
    );
    trail.orderIds!.push(order.id);
    const line = order.items[0]!;
    const draft = await createInvoice(api, {
      docType: 'FACTURA',
      customerId: customer.id,
      salesOrderId: order.id,
      items: [{ salesOrderItemId: line.id, qty: line.qty }],
    });
    trail.documentIds!.push(draft.id);
    return postJson<FiscalDocumentDto>(
      api,
      `/api/invoicing/documents/${draft.id}/register-manual`,
      {
        series,
        correlative,
      },
    );
  }

  test.beforeAll(async ({ baseURL }) => {
    // Compra, importación, tres pedidos con su factura y una anulación: más que el tope de un hook.
    test.setTimeout(180_000);
    api = await adminApi(baseURL!);
    customer = await createCustomer(api);
    const supplier = await createSupplier(api, { name: 'E2E Proveedor D-387' });
    supplierId = supplier.id;
    product = await createSellableProduct(api, {
      lineCode: LINE,
      unit: 'KGM',
      listPricePen: '2.0000',
    });
    const purchase = await postJson<{ id: string }>(api, '/api/purchases', {
      supplierId,
      businessLine: LINE,
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
          description: 'Material E2E D-387',
          qty: '1000',
          unit: 'KGM',
          unitPrice: '1',
        },
      ],
    });
    purchaseId = purchase.id;
    await postJson(api, `/api/purchases/${purchase.id}/receive`);

    const rows: SheetRow[] = Object.values(keys).map((documentKey) => ({
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
    const mine = await listed(api, `customerId=${customer.id}`);
    for (const [state, key] of Object.entries(keys) as [keyof typeof keys, string][]) {
      ids[state] = mine.find((q) => q.externalInvoice === key)!.id;
    }
    ids.none = (
      await createQuotation(api, {
        customerId: customer.id,
        businessLine: LINE,
        productId: product.id,
        qty: '10',
      })
    ).id;

    // Registrado: el mismo número que el Excel (el sistema lo guarda con ocho dígitos).
    await invoice(ids.registered, 999);
    // No coincide: otro correlativo.
    await invoice(ids.mismatch, 1001);
    // Anulado: no cuenta como vigente; la fila vuelve a «solo referencia».
    const annulled = await invoice(ids.annulled, 77);
    await postJson(api, `/api/invoicing/documents/${annulled.id}/annul`, {
      reason: 'E2E D-387: un comprobante anulado no cuenta',
    });
  });

  test.afterAll(async () => {
    // Anular tres comprobantes, sus pedidos y la compra pasa del tope de 45 s de un hook.
    test.setTimeout(180_000);
    await purgeInvoicingTrail(api, {
      ...trail,
      purchaseId,
      supplierId,
      productIds: [product.id],
    });
    await purgeSalesTrail(api, { quotationIds: Object.values(ids) });
    await deactivateTrail(api, { customerIds: [customer.id] });
    await api.dispose();
  });

  test('la API trae la marca y los comprobantes vigentes; busca y ordena por el número mostrado', async () => {
    const mine = await listed(api, `customerId=${customer.id}`);
    const byId = new Map(mine.map((q) => [q.id, q]));
    expect(byId.get(ids.reference)?.invoiceDocuments).toEqual([]);
    expect(byId.get(ids.annulled)?.invoiceDocuments).toEqual([]);
    expect(byId.get(ids.registered)?.invoiceDocuments.map((d) => d.number)).toEqual([
      `${series}-00000999`,
    ]);
    expect(byId.get(ids.mismatch)?.invoiceDocuments.map((d) => d.number)).toEqual([
      `${series}-00001001`,
    ]);
    expect(byId.get(ids.none)).toMatchObject({ externalInvoice: null, invoiceDocuments: [] });

    // El buscador encuentra el registrado por su número sin ceros, y el que no coincide por los
    // dos números: el del sistema y el del Excel.
    const ofSeries = (rows: ListedQuotation[]) =>
      rows.filter((q) => q.externalInvoice?.startsWith(series)).map((q) => q.id);
    expect(ofSeries(await listed(api, `search=${series}-999`))).toEqual([ids.registered]);
    expect(ofSeries(await listed(api, `search=${series}-1001`))).toEqual([ids.mismatch]);
    expect(ofSeries(await listed(api, `search=${series}-1000`))).toEqual([ids.mismatch]);

    // Orden por el número mostrado: 12 y 77 (Excel), 999 y 1001 (sistema); la manual al final.
    const asc = await listed(api, `customerId=${customer.id}&sort=invoice&dir=asc`);
    expect(asc.map((q) => q.id)).toEqual([
      ids.reference,
      ids.annulled,
      ids.registered,
      ids.mismatch,
      ids.none,
    ]);
  });

  test('la columna distingue los cuatro estados, ordena y no desborda entre 1366 y 1920 px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAsAdmin(page);
    await page.goto(`/cotizaciones?search=${customer.docNumber}`);
    const table = page.locator('main table');
    await expect(table.getByRole('row')).toHaveCount(1 + 5, { timeout: 60_000 });
    const headers = await table.getByRole('columnheader').allInnerTexts();
    expect(headers.map((h) => h.trim()).slice(0, 2)).toEqual(['Código', 'Comprobante']);

    const cellOf = (id: string) =>
      table
        .getByRole('row')
        .filter({ has: page.locator(`a[href="/cotizaciones/${id}"]`) })
        .getByTestId('quotation-invoice-cell');
    const invoiceOf = (id: string) => cellOf(id).getByTestId('quotation-external-invoice');

    // Solo referencia: el número del Excel, en gris y con el aviso.
    for (const [id, key] of [
      [ids.reference, keys.reference],
      [ids.annulled, keys.annulled],
    ] as const) {
      await expect(invoiceOf(id)).toHaveAttribute('data-state', 'reference');
      await expect(invoiceOf(id)).toHaveText(key);
      await expect(invoiceOf(id)).toHaveAttribute(
        'title',
        'Número del Excel, aún sin comprobante registrado',
      );
      await expect(invoiceOf(id)).toHaveClass(/text-muted-foreground/);
      await expect(invoiceOf(id)).toHaveAttribute(
        'aria-label',
        `${key}: Número del Excel, aún sin comprobante registrado`,
      );
      await expect(invoiceOf(id).getByRole('link')).toHaveCount(0);
    }

    // Registrado: el número del sistema, con check y enlace al comprobante.
    const registered = invoiceOf(ids.registered);
    await expect(registered).toHaveAttribute('data-state', 'registered');
    await expect(registered.getByLabel('Comprobante registrado')).toBeVisible();
    await expect(registered.getByRole('link', { name: `${series}-00000999` })).toHaveAttribute(
      'href',
      /^\/comprobantes\//,
    );
    await expect(registered).not.toHaveClass(/text-muted-foreground|text-tone-warning/);

    // No coincide: ámbar (tono warning), con los dos números en el tooltip.
    const mismatch = invoiceOf(ids.mismatch);
    await expect(mismatch).toHaveAttribute('data-state', 'mismatch');
    await expect(mismatch).toHaveClass(/text-tone-warning-foreground/);
    // No solo color: un ícono con nombre accesible lo dice (WCAG 1.4.1).
    await expect(
      mismatch.getByRole('img', { name: `No coincide con el número del Excel ${keys.mismatch}` }),
    ).toBeVisible();
    await expect(mismatch).toHaveText(`${series}-00001001`);
    await expect(mismatch).toHaveAttribute(
      'title',
      `Comprobante registrado: ${series}-00001001. Número del Excel: ${keys.mismatch}`,
    );

    // Sin nada: la celda vacía.
    await expect(cellOf(ids.none)).toHaveText('');
    await expectNoHorizontalScroll(page);

    // Ordenar por la columna, en los dos sentidos.
    const shown = table.getByTestId('quotation-invoice-cell');
    await table.getByRole('columnheader', { name: 'Comprobante' }).click();
    await expect(page).toHaveURL(/sort=invoice/);
    await expect(shown).toHaveText([
      keys.reference,
      keys.annulled,
      `${series}-00000999`,
      `${series}-00001001`,
      '',
    ]);
    await table.getByRole('columnheader', { name: 'Comprobante' }).click();
    await expect(page).toHaveURL(/dir=desc/);
    await expect(shown).toHaveText([
      `${series}-00001001`,
      `${series}-00000999`,
      keys.annulled,
      keys.reference,
      '',
    ]);

    // El buscador de la lista encuentra por el número del Excel aunque no coincida.
    await page.goto('/cotizaciones');
    await page
      .getByPlaceholder('Buscar por código, comprobante, cliente o documento…')
      .fill(keys.mismatch);
    await expect(page).toHaveURL(new RegExp(`search=${keys.mismatch}`));
    await expect(shown.filter({ hasText: series })).toHaveText([`${series}-00001001`]);

    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`/cotizaciones?search=${customer.docNumber}`);
    await expect(table.getByRole('row')).toHaveCount(1 + 5, { timeout: 60_000 });
    await expectNoHorizontalScroll(page);
  });

  test('la cabecera del detalle muestra el mismo estado', async ({ page }) => {
    await loginAsAdmin(page);
    const header = page.getByTestId('quotation-external-invoice');
    for (const [id, state, text] of [
      [ids.reference, 'reference', keys.reference],
      [ids.registered, 'registered', `${series}-00000999`],
      [ids.mismatch, 'mismatch', `${series}-00001001`],
    ] as const) {
      await page.goto(`/cotizaciones/${id}`);
      await expect(header).toHaveAttribute('data-state', state, { timeout: 60_000 });
      await expect(header).toHaveText(text);
    }
    await page.goto(`/cotizaciones/${ids.none}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
    await expect(header).toHaveCount(0);
  });
});
