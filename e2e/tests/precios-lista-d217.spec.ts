import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials } from '../helpers/api';
import { chooseOption, chooseProductWithStock } from '../helpers/ui';
import { deactivateTrail, putJson } from '../helpers/production';
import { POS_LINE, setupPosStock } from '../helpers/pos';
import {
  createCustomer,
  createQuotationWithLines,
  createSellableProduct,
  purgeSalesTrail,
  stockPanel,
  updateQuotationBody,
} from '../helpers/sales';

/**
 * RF-S1/M1 (D-217) — precios de lista: historial append-only, edición inline en `/catalogo`
 * y carga masiva en `/catalogo/precios/importar`. `Product.listPricePen` y su prellenado en
 * cotización (D-068) ya existían; lo nuevo de esta sesión es todo lo demás.
 *
 * `POS_LINE` (`roofing`, "Coberturas (UPVC)") es la línea de los escenarios: compra-venta
 * pura, sin campos estructurados obligatorios (D-118 solo los exige en Drywall y Metallic
 * Roofing), así que un SKU vendible se arma con lo mínimo.
 *
 * Escribe catálogo, cotizaciones y el historial de precios: nunca contra producción (D-126,
 * regla dura 9).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea/edita catálogo y cotizaciones: nunca contra producción (D-126).');
test.describe.configure({ timeout: 180_000 });

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

/** Fila del catálogo de un SKU, en la pestaña de `POS_LINE` ("Coberturas (UPVC)"). */
async function goToCatalogRow(page: Page, sku: string) {
  await page.goto('/catalogo');
  await page.getByRole('tab', { name: 'Coberturas (UPVC)', exact: true }).click();
  const row = page.getByRole('row', { name: new RegExp(sku) });
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row;
}

test.describe('D-217/M1a+M1b — historial y edición inline del precio de lista', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('editar el precio en el catálogo lo muestra con IGV y deja la fila en el historial', async ({
    page,
  }) => {
    const product = await createSellableProduct(api, { lineCode: POS_LINE });

    try {
      await loginAsAdmin(page);
      const row = await goToCatalogRow(page, product.sku);

      // Sin precio de lista todavía: el botón dice "sin precio", nada de "S/ 0.00".
      await expect(row.getByRole('button', { name: 'sin precio', exact: true })).toBeVisible();

      await row.getByRole('button', { name: 'sin precio', exact: true }).click();
      // 11.80 con IGV ÷ 1.18 = 10.00 exacto: sin ambigüedad de redondeo en la ida y la vuelta.
      await row.getByRole('textbox').fill('11.80');
      await row.getByRole('button', { name: 'Guardar', exact: true }).click();

      const updated = row.getByRole('button', { name: 'S/ 11.80', exact: true });
      await expect(updated).toBeVisible({ timeout: 15_000 });

      await row.getByRole('button', { name: 'Historial', exact: true }).click();
      const dialog = page
        .getByRole('dialog')
        .filter({ hasText: `Historial de precio — ${product.sku}` });
      await expect(dialog).toBeVisible();
      const historyRow = dialog.getByRole('row').filter({ hasText: 'Edición' });
      await expect(historyRow).toHaveCount(1);
      await expect(historyRow).toContainText('sin precio');
      await expect(historyRow).toContainText('S/ 11.80');
    } finally {
      await deactivateTrail(api, { productIds: [product.id] });
    }
  });
});

test.describe('D-217/M1c — carga masiva del precio de lista', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  async function goToImportPage(page: Page): Promise<void> {
    await page.goto('/catalogo/precios/importar');
    await expect(page.getByRole('heading', { name: 'Cargar precios de lista' })).toBeVisible({
      timeout: 30_000,
    });
  }

  function csvOf(rows: [string, string][]): { name: string; mimeType: string; buffer: Buffer } {
    const lines = ['SKU,PRECIO CON IGV', ...rows.map(([sku, price]) => `${sku},${price}`)];
    return {
      name: 'precios.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(lines.join('\n'), 'utf8'),
    };
  }

  test('un SKU inexistente marca error en el resumen y deja "Confirmar" deshabilitado', async ({
    page,
  }) => {
    const fakeSku = `E2E-NOEXISTE-${Date.now()}`;
    await loginAsAdmin(page);
    await goToImportPage(page);

    await page.locator('input[type="file"]').setInputFiles(csvOf([[fakeSku, '10.00']]));

    const row = page.getByRole('row', { name: new RegExp(fakeSku) });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('Error');
    await expect(row).toContainText('El SKU no existe en el catálogo');
    await expect(page.getByRole('alert').filter({ hasText: 'Hay filas con error' })).toBeVisible();

    const confirm = page.getByRole('button', { name: /^Confirmar/ });
    await expect(confirm).toBeDisabled();
  });

  test('una carga válida confirma, el catálogo refleja el precio nuevo y habilita revertir', async ({
    page,
  }) => {
    const stock = await setupPosStock(api, { qty: '10', unitPrice: '20' });

    try {
      // Sanity: 35.0000 (valor sin IGV, tras el import) queda bien por encima del piso de
      // D-163 para este costo. Si algún día el margen mínimo configurado lo empujara más
      // arriba, este assert falla con una señal clara en vez de colar una fila WARNING.
      const panel = await stockPanel(api, { productIds: [stock.product.id] });
      const floor = panel.products.find((p) => p.productId === stock.product.id);
      expect(Number(floor?.minValuePen ?? '0')).toBeLessThan(35);

      await loginAsAdmin(page);
      await goToImportPage(page);

      // 41.30 con IGV = 35.0000 sin IGV exacto (35 × 1.18 = 41.3): la ida y la vuelta no
      // dejan margen de redondeo para el assert de más abajo.
      await page.locator('input[type="file"]').setInputFiles(csvOf([[stock.product.sku, '41.30']]));

      const previewRow = page.getByRole('row', { name: new RegExp(stock.product.sku) });
      await expect(previewRow).toBeVisible({ timeout: 15_000 });
      await expect(previewRow).toContainText('Cambia');
      await expect(previewRow).toContainText('50.0000'); // antes (setupPosStock por defecto)
      await expect(previewRow).toContainText('35.0000'); // después

      const confirm = page.getByRole('button', { name: /^Confirmar 1 cambio/ });
      await expect(confirm).toBeEnabled();
      await confirm.click();
      // `getByRole('alert')` y no `getByText` a propósito: el toast de éxito (sonner) repite
      // el mismo texto y un `getByText` suelto choca contra las dos apariciones.
      await expect(
        page.getByRole('alert').filter({ hasText: /Lote confirmado: 1 precio\(s\) actualizado/ }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: 'Revertir este lote' })).toBeVisible();

      const catalogRow = await goToCatalogRow(page, stock.product.sku);
      await expect(catalogRow.getByRole('button', { name: 'S/ 41.30', exact: true })).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await deactivateTrail(api, {
        purchaseId: stock.purchaseId,
        supplierId: stock.supplier.id,
        productIds: [stock.product.id],
      });
    }
  });

  test('revertir un lote restaura el precio anterior y lo deja marcado como reversa en el historial', async ({
    page,
  }) => {
    const stock = await setupPosStock(api, { qty: '10', unitPrice: '20' });

    try {
      await loginAsAdmin(page);
      await goToImportPage(page);

      await page.locator('input[type="file"]').setInputFiles(csvOf([[stock.product.sku, '41.30']]));
      await expect(page.getByRole('row', { name: new RegExp(stock.product.sku) })).toBeVisible({
        timeout: 15_000,
      });
      await page.getByRole('button', { name: /^Confirmar 1 cambio/ }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'Lote confirmado' })).toBeVisible({
        timeout: 15_000,
      });

      await page.getByRole('button', { name: 'Revertir este lote' }).click();
      await expect(
        page.getByRole('alert').filter({ hasText: /Lote revertido: 1 precio\(s\) restaurado/ }),
      ).toBeVisible({ timeout: 15_000 });
      // Una vez revertido, el botón de revertir de nuevo ya no está: es un lote, no un toggle.
      await expect(page.getByRole('button', { name: 'Revertir este lote' })).toHaveCount(0);

      // El precio vuelve al de antes de la carga: 50.0000 de valor → S/ 59.00 con IGV.
      const catalogRow = await goToCatalogRow(page, stock.product.sku);
      await expect(catalogRow.getByRole('button', { name: 'S/ 59.00', exact: true })).toBeVisible({
        timeout: 15_000,
      });

      await catalogRow.getByRole('button', { name: 'Historial', exact: true }).click();
      const dialog = page
        .getByRole('dialog')
        .filter({ hasText: `Historial de precio — ${stock.product.sku}` });
      await expect(dialog).toBeVisible();
      // Más reciente primero: la reversa arriba, la carga original abajo.
      const rows = dialog.getByRole('row').filter({ hasText: 'Carga masiva' });
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toContainText('reversa');
      await expect(rows.nth(0)).toContainText('S/ 41.30'); // antes de revertir
      await expect(rows.nth(0)).toContainText('S/ 59.00'); // después de revertir
      await expect(rows.nth(1)).not.toContainText('reversa');
    } finally {
      await deactivateTrail(api, {
        purchaseId: stock.purchaseId,
        supplierId: stock.supplier.id,
        productIds: [stock.product.id],
      });
    }
  });
});

test.describe('D-068 (regresión) — prellenado de precio y congelamiento en cotización emitida', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('elegir un producto con precio de lista prellena el precio de la línea nueva', async ({
    page,
  }) => {
    const product = await createSellableProduct(api, {
      lineCode: POS_LINE,
      listPricePen: '10.0000',
    });
    const customer = await createCustomer(api);

    try {
      await loginAsAdmin(page);
      await page.goto('/cotizaciones/nueva');
      await chooseOption(
        page,
        page.getByLabel('Cliente', { exact: true }),
        `${customer.name} — ${customer.docNumber}`,
      );
      await page.getByLabel('Línea de negocio de la línea 1').click();
      await page.getByRole('option', { name: 'Coberturas (UPVC)', exact: true }).click();

      await chooseProductWithStock(page, page.getByLabel('Producto de la línea 1'), product.sku);

      // 10.0000 de valor × 1.18 = 11.8000 con IGV, formateado a 4 decimales (D-162).
      await expect(page.getByLabel('Precio unitario de la línea 1')).toHaveValue('11.8000');
    } finally {
      await deactivateTrail(api, { productIds: [product.id], customerIds: [customer.id] });
    }
  });

  test('editar una cotización emitida no re-precia una línea que no se tocó, aunque el precio de lista haya cambiado después', async () => {
    const product = await createSellableProduct(api, {
      lineCode: POS_LINE,
      listPricePen: '10.0000',
    });
    const customer = await createCustomer(api);
    const quotationIds: string[] = [];

    try {
      // Precio negociado (8.0000), distinto del precio de lista (10.0000) a propósito: si
      // alguna vez `PUT` empezara a re-derivar del precio de lista vigente, este valor
      // cambiaría y el test lo vería.
      const quotation = await createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: POS_LINE,
        items: [{ productId: product.id, qty: '2', unitPricePen: '8.0000' }],
      });
      quotationIds.push(quotation.id);
      expect(quotation.items[0]!.unitPricePen).toBe('8.0000');

      // El precio de lista sube después de emitida la cotización.
      const res = await api.patch(`/api/catalog/${product.id}`, {
        data: { listPricePen: '20.0000' },
      });
      expect(res.ok(), `PATCH /catalog/${product.id} falló: ${await res.text()}`).toBe(true);

      // Editar la cotización reenviando la misma línea (como haría el formulario, que carga
      // el precio guardado y no el de lista vigente) tiene que conservar 8.0000.
      const edited = await putJson<{ items: { unitPricePen: string }[] }>(
        api,
        `/api/sales/quotations/${quotation.id}`,
        updateQuotationBody({
          customerId: customer.id,
          items: [{ productId: product.id, qty: '2', unitPricePen: '8.0000' }],
        }),
      );
      expect(edited.items[0]!.unitPricePen).toBe('8.0000');
    } finally {
      await purgeSalesTrail(api, { quotationIds });
      await deactivateTrail(api, { productIds: [product.id], customerIds: [customer.id] });
    }
  });
});
