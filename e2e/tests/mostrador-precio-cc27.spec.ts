import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials } from '../helpers/api';
import { fiscalEmissionAllowed, FISCAL_EMISSION_REASON, getDocument } from '../helpers/invoicing';
import {
  cashSessionSales,
  closeSessionQuietly,
  openCashSession,
  setupPosStock,
  type CashSessionDto,
} from '../helpers/pos';
import { purgeSalesTrail } from '../helpers/sales';

/**
 * cc27 / UX26-01 (D-452) — el mostrador muestra el precio **con IGV**, como el catálogo, y el
 * total que cobra es el del comprobante al céntimo.
 *
 * Antes la ficha del mostrador mostraba el valor sin IGV (S/ 50.00) donde el catálogo mostraba
 * S/ 59.00 para el mismo SKU. El importe cobrado ya era el correcto: el defecto era de
 * presentación, y este spec fija las dos cosas.
 *
 * Cada venta gasta un correlativo de boleta: nunca contra producción (D-081, D-126).
 */

const allowWrites = process.env.E2E_ALLOW_WRITES === '1' || !process.env.E2E_BASE_URL;

test.describe.configure({ timeout: 240_000 });

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

/** Busca el SKU en el mostrador y lo agrega al carrito; devuelve la ficha. */
async function addToCart(page: Page, sku: string) {
  await page.getByPlaceholder('Buscar por código o nombre…').fill(sku);
  const card = page.getByRole('button', { name: new RegExp(sku) });
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card;
}

test.describe('cc27 / UX26-01 — precio del mostrador con IGV', () => {
  test.skip(!allowWrites, 'Vende en el mostrador: nunca contra producción (D-126).');
  test.skip(!fiscalEmissionAllowed(), FISCAL_EMISSION_REASON);

  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('el mismo SKU muestra el mismo precio en el catálogo y en el mostrador, y el total es el del comprobante', async ({
    page,
  }) => {
    // Valor de lista 10.01 sin IGV → 11.8118 con IGV: el catálogo y el mostrador dicen S/ 11.81.
    // Tres unidades: gravada 30.03, IGV 5.41 (céntimo de 5.4054), total 35.44 (D-377).
    const stock = await setupPosStock(api, { qty: '20', listPricePen: '10.0100' });
    let session: CashSessionDto | undefined;
    const orderIds: string[] = [];

    try {
      await loginAsAdmin(page);

      // 1. Catálogo: «Precio de lista (con IGV)».
      await page.goto('/catalogo');
      await page.getByRole('tab', { name: 'Coberturas (UPVC)', exact: true }).click();
      const row = page.getByRole('row', { name: new RegExp(stock.product.sku) });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row.getByRole('button', { name: 'S/ 11.81', exact: true })).toBeVisible();

      // 2. Mostrador: la ficha dice el mismo número, rotulado «con IGV».
      session = await openCashSession(api, '0.00');
      await page.goto('/pos');
      const card = await addToCart(page, stock.product.sku);
      await expect(card).toContainText('S/ 11.81 con IGV');
      await card.click();

      // 3. Carrito: precio unitario con IGV, importe de línea con IGV y el pie al céntimo.
      await expect(page.getByLabel('Precio unitario (con IGV)')).toHaveValue('11.81');
      await page.getByLabel(/^Cantidad/).fill('3');
      await expect(page.getByTestId(`pos-line-total-${stock.product.sku}`)).toHaveText('S/ 35.44');
      await expect(page.getByTestId('pos-subtotal')).toHaveText('S/ 30.03');
      await expect(page.getByTestId('pos-igv')).toHaveText('S/ 5.41');
      await expect(page.getByTestId('pos-total')).toHaveText('S/ 35.44');

      // 4. Cobrar: el botón dice el total y el comprobante sale por ese total.
      await page.getByRole('button', { name: 'Efectivo', exact: true }).click();
      await page.getByRole('button', { name: 'Cobrar S/ 35.44' }).click();
      await expect(page.getByRole('dialog')).toContainText('por S/ 35.44', { timeout: 30_000 });

      const [sale] = await cashSessionSales(api, session.id);
      expect(sale).toBeDefined();
      orderIds.push(sale!.salesOrderId);
      expect(sale!.totalPen).toBe('35.4400');
      const document = await getDocument(api, sale!.fiscalDocumentId);
      expect(document.subtotalPen).toBe('30.0300');
      expect(document.igvPen).toBe('5.4100');
      expect(document.totalPen).toBe('35.4400');
    } finally {
      await closeSessionQuietly(api, session?.id);
      await purgeSalesTrail(api, { orderIds });
    }
  });

  test('un precio tipeado con IGV se cobra exacto: cantidad × precio, sin perder céntimos', async ({
    page,
  }) => {
    const stock = await setupPosStock(api, { qty: '20', listPricePen: '50.0000' });
    let session: CashSessionDto | undefined;
    const orderIds: string[] = [];

    try {
      await loginAsAdmin(page);
      session = await openCashSession(api, '0.00');
      await page.goto('/pos');
      const card = await addToCart(page, stock.product.sku);
      await expect(card).toContainText('S/ 59.00 con IGV');
      await card.click();

      // 3 × S/ 12.35 con IGV = S/ 37.05; el valor sin IGV se deriva (D-255): 31.40 + 5.65.
      await page.getByLabel(/^Cantidad/).fill('3');
      await page.getByLabel('Precio unitario (con IGV)').fill('12.35');
      await expect(page.getByTestId('pos-total')).toHaveText('S/ 37.05');
      await expect(page.getByTestId('pos-subtotal')).toHaveText('S/ 31.40');
      await expect(page.getByTestId('pos-igv')).toHaveText('S/ 5.65');

      await page.getByRole('button', { name: 'Efectivo', exact: true }).click();
      await page.getByRole('button', { name: 'Cobrar S/ 37.05' }).click();
      await expect(page.getByRole('dialog')).toContainText('por S/ 37.05', { timeout: 30_000 });

      const [sale] = await cashSessionSales(api, session.id);
      orderIds.push(sale!.salesOrderId);
      const document = await getDocument(api, sale!.fiscalDocumentId);
      expect(document.totalPen).toBe('37.0500');
      expect(document.subtotalPen).toBe('31.4000');
      expect(document.igvPen).toBe('5.6500');
    } finally {
      await closeSessionQuietly(api, session?.id);
      await purgeSalesTrail(api, { orderIds });
    }
  });
});
