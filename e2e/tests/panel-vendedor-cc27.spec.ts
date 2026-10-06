import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, createUser, getJson, postJson, type CreatedUser } from '../helpers/api';
import { fiscalEmissionAllowed, FISCAL_EMISSION_REASON } from '../helpers/invoicing';
import {
  closeSessionQuietly,
  openCashSession,
  POS_LINE,
  posSell,
  setupPosStock,
  type CashSessionDto,
} from '../helpers/pos';
import { apiAs, ROLE_PASSWORD } from '../helpers/production';
import { createCustomer, createQuotation, purgeSalesTrail } from '../helpers/sales';

/**
 * cc27 / M4 (D-457, propuesta de D-450) — el Panel del vendedor: sus ventas del mes sin IGV y su
 * conversión de cotización a pedido, **solo lo suyo**.
 *
 * Un vendedor recién creado emite tres cotizaciones: confirma una, confirma otra y su pedido se
 * anula, y la tercera queda sin pedido; el administrador emite otra. El Panel del vendedor cuenta
 * las tres suyas y una sola convertida (D-459: un pedido anulado no cuenta), 33,3 %, y no la del
 * administrador. Sus ventas son las de su venta de mostrador (S/ 100 sin IGV), no las de otros. Es
 * solo del vendedor: el administrador y el supervisor reciben 403.
 *
 * Crea cotizaciones y un pedido: nunca contra producción (D-126, regla dura 9).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea cotizaciones y pedidos: nunca contra producción (D-126).');
test.describe.configure({ timeout: 240_000 });

interface SellerDashboardDto {
  month: { from: string; to: string };
  salesPen: string;
  documentCount: number;
  quotationsIssued: number;
  quotationsConverted: number;
  conversionPct: string | null;
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

test.describe('cc27 / M4 — Panel del vendedor', () => {
  let api: APIRequestContext;
  let seller: CreatedUser;
  let sellerApi: APIRequestContext;
  const quotationIds: string[] = [];
  const orderIds: string[] = [];

  test.beforeAll(async ({ baseURL }) => {
    test.setTimeout(180_000);
    api = await adminApi(baseURL!);
    seller = await createUser(api, 'VENDEDOR');
    sellerApi = await apiAs(baseURL!, seller);
  });

  test.afterAll(async () => {
    test.setTimeout(180_000);
    await purgeSalesTrail(api, { orderIds, quotationIds });
    await sellerApi.dispose();
    await api.dispose();
  });

  test('cuenta solo lo del vendedor y lo muestra en su Panel; es solo del vendedor', async ({
    page,
    baseURL,
  }) => {
    // La venta propia es de mostrador y emite una boleta (D-081).
    test.skip(!fiscalEmissionAllowed(), FISCAL_EMISSION_REASON);
    const stock = await setupPosStock(api, { qty: '20', listPricePen: '50.0000' });
    const customer = await createCustomer(api);
    const quote = (who: APIRequestContext) =>
      createQuotation(who, {
        customerId: customer.id,
        businessLine: POS_LINE,
        productId: stock.product.id,
        qty: '1',
      });

    // Antes: un vendedor nuevo no tiene nada en el mes.
    const empty = await getJson<SellerDashboardDto>(sellerApi, '/api/reports/seller-dashboard');
    expect(empty).toMatchObject({
      salesPen: '0.0000',
      documentCount: 0,
      quotationsIssued: 0,
      quotationsConverted: 0,
      conversionPct: null,
    });

    // Tres cotizaciones del vendedor (una con pedido vivo, una con pedido anulado, una sin
    // pedido) y una del administrador.
    const mine = await quote(sellerApi);
    const cancelled = await quote(sellerApi);
    const other = await quote(sellerApi);
    const admins = await quote(api);
    quotationIds.push(mine.id, cancelled.id, other.id, admins.id);
    const order = await postJson<{ id: string }>(
      sellerApi,
      `/api/sales/quotations/${mine.id}/confirm`,
      {},
    );
    orderIds.push(order.id);
    const toCancel = await postJson<{ id: string }>(
      sellerApi,
      `/api/sales/quotations/${cancelled.id}/confirm`,
      {},
    );
    orderIds.push(toCancel.id);
    await postJson(api, `/api/sales/orders/${toCancel.id}/cancel`, {
      reason: 'E2E cc28: un pedido anulado no cuenta como conversión',
    });

    const dto = await getJson<SellerDashboardDto>(sellerApi, '/api/reports/seller-dashboard');
    expect(dto).toMatchObject({
      quotationsIssued: 3,
      quotationsConverted: 1,
      conversionPct: '33.3',
      // Sin comprobantes propios: los de otros no le suman.
      salesPen: '0.0000',
      documentCount: 0,
    });

    // Su venta de mostrador sí suma: dos unidades a S/ 50 sin IGV = S/ 100 (A-12 de cc27).
    let session: CashSessionDto | undefined;
    try {
      session = await openCashSession(sellerApi, '0.00');
      const sale = await posSell(sellerApi, {
        items: [{ productId: stock.product.id, qty: '2.000', unitPricePen: '50.0000' }],
      });
      orderIds.push(sale.salesOrderId);
    } finally {
      await closeSessionQuietly(sellerApi, session?.id);
    }
    const withSale = await getJson<SellerDashboardDto>(sellerApi, '/api/reports/seller-dashboard');
    expect(withSale).toMatchObject({ salesPen: '100.0000', documentCount: 1 });

    // Solo del vendedor: el administrador y el supervisor no lo ven.
    expect((await api.get('/api/reports/seller-dashboard')).status()).toBe(403);
    const supervisor = await createUser(api, 'SUPERVISOR_PLANTA');
    const supervisorApi = await apiAs(baseURL!, supervisor);
    expect((await supervisorApi.get('/api/reports/seller-dashboard')).status()).toBe(403);
    await supervisorApi.dispose();

    // En pantalla, en su Panel.
    await login(page, seller.email, ROLE_PASSWORD);
    await expect(page.getByTestId('seller-conversion')).toHaveText('33.3 %', { timeout: 30_000 });
    await expect(page.getByText('1 de 3 cotizaciones emitidas')).toBeVisible();
    await expect(page.getByTestId('seller-sales')).toHaveText('S/ 100.00');
    // Sin costos ni márgenes en su Panel.
    await expect(page.getByRole('main')).not.toContainText(/margen|costo/i);
  });
});
