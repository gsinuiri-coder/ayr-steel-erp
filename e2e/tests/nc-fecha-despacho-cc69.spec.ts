import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { addDays } from '@ayr/shared';
import { adminApi, adminCredentials, createSupplier, postJson } from '../helpers/api';
import {
  createInvoice,
  dispatchOrder,
  purgeInvoicingTrail,
  setupOrderScenario,
} from '../helpers/invoicing';
import { today } from '../helpers/production';
import { createSellableProduct } from '../helpers/sales';
import { headerAction, selectOption } from '../helpers/ui';

/**
 * cc69 — **la NC conserva su fecha; lo que sale de un despacho posterior entra al almacén el día de
 * ese despacho** (D-728), y **la línea de compra va en la unidad del producto** (D-729).
 *
 * - Una bobina vendida entera, facturada antes de despacharla. La NC 07 fechada entre el comprobante
 *   y el despacho ya no rebota: «Qué va a pasar» y la DEV- dicen que entra el día del despacho.
 * - Una compra de un producto por caja en «unidad» se rechaza; el formulario fija la unidad.
 *
 * Escribe datos: nunca contra producción (D-126).
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

const series = () => `F${String(Math.floor(Math.random() * 900) + 100)}`;
const correlative = () => String(Math.floor(Math.random() * 90_000_000) + 1_000_000);
const dayMonth = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

test.describe('cc69 — NC fechada antes del despacho y unidad en compras', () => {
  test.skip(!allowWrites, 'Vende, despacha y factura: nunca contra producción (D-126).');

  let api: APIRequestContext;
  const orderIds: string[] = [];
  const coilIds: string[] = [];
  const documentIds: string[] = [];

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await purgeInvoicingTrail(api, { orderIds, coilIds, documentIds }).catch(() => undefined);
    await api.dispose();
  });

  test('NC 07 anterior al despacho: entra al almacén el día del despacho y lo dice', async ({
    page,
  }) => {
    const invoiceDate = addDays(today(), -2);
    const noteDate = addDays(today(), -1);
    const scenario = await setupOrderScenario(api, {
      coilKg: '1000',
      coilReceivedOn: addDays(today(), -3),
    });
    orderIds.push(scenario.order.id);
    coilIds.push(scenario.coil.id);
    const draft = await createInvoice(api, {
      docType: 'FACTURA',
      customerId: scenario.customer.id,
      salesOrderId: scenario.order.id,
      issueDate: invoiceDate,
      items: [{ salesOrderItemId: scenario.item.id, qty: scenario.item.qty }],
    });
    const invoice = await postJson<{ id: string }>(
      api,
      `/api/invoicing/documents/${draft.id}/register-manual`,
      { series: series(), correlative: Number(correlative()) },
    );
    documentIds.push(invoice.id);
    // El despacho de hoy, después del comprobante: lo que en producción trae la carga atrasada.
    const dispatch = await dispatchOrder(api, {
      salesOrderId: scenario.order.id,
      items: [{ salesOrderItemId: scenario.item.id, qty: scenario.item.qty }],
    });
    const notice = `La devolución entra al almacén el ${dayMonth(today())} (fecha del despacho ${dispatch.code}), después de la fecha de la NC.`;

    await loginAsAdmin(page);
    await page.goto(`/comprobantes/${invoice.id}`);
    await (await headerAction(page, 'Nota de crédito')).click();
    const dialog = page.getByTestId('credit-note-dialog');
    await dialog.getByTestId('credit-reason-DEVOLUCION_TOTAL').click();
    await dialog.getByRole('button', { name: 'Continuar' }).click();
    await dialog.getByLabel('Fecha de la nota').fill(noteDate);
    const preview = dialog.getByTestId('credit-note-preview');
    await expect(preview.getByTestId('credit-note-preview-late-entry')).toHaveText(notice, {
      timeout: 30_000,
    });
    await dialog.getByLabel('Serie', { exact: true }).fill(series());
    await dialog.getByLabel('Número del papel').fill(correlative());
    const button = dialog.getByRole('button', { name: 'Registrar nota de crédito' });
    await expect(button).toBeEnabled({ timeout: 30_000 });
    await button.click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });

    const returnLink = page.getByRole('link', { name: /^DEV-\d{6}$/ });
    await expect(returnLink).toBeVisible({ timeout: 30_000 });
    await returnLink.click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Devolución DEV-\d{6}/);
    await expect(page.getByTestId('sales-return-late-entry')).toHaveText(notice);
    const [y, m, d] = noteDate.split('-');
    await expect(page.getByText(`La nota es del ${d}/${m}/${y}`)).toBeVisible();
  });

  test('una compra por caja en «unidad» se rechaza; el formulario fija la unidad del producto', async ({
    page,
  }) => {
    const product = await createSellableProduct(api, { lineCode: 'trading', unit: 'BX' });
    const supplier = await createSupplier(api);
    const res = await api.post('/api/purchases', {
      data: {
        supplierId: supplier.id,
        businessLine: 'trading',
        type: 'FINISHED_GOOD',
        docType: 'FACTURA',
        series: 'F001',
        number: correlative(),
        issueDate: today(),
        currency: 'PEN',
        paymentTerms: 'CONTADO',
        items: [
          {
            productId: product.id,
            description: 'Caja E2E',
            qty: '5',
            unit: 'NIU',
            unitPrice: '10',
          },
        ],
      },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain(
      `Línea 1: ${product.sku} se lleva en Caja (BX) y la línea dice Unidad (NIU)`,
    );

    await loginAsAdmin(page);
    await page.goto('/compras/nueva?tipo=FINISHED_GOOD');
    await expect(page.getByRole('heading', { name: 'Nueva compra' })).toBeVisible({
      timeout: 60_000,
    });
    await selectOption(page, page.getByLabel('Línea de negocio'), 'Reventa');
    await page.getByLabel('Producto').first().click();
    await page.getByRole('option', { name: new RegExp(product.sku) }).click();
    const unit = page.getByLabel('Unidad').first();
    await expect(unit).toHaveText('Caja (BX)');
    await expect(unit).toBeDisabled();
  });
});
