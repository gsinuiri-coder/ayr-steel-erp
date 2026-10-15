import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { adminApi, adminCredentials, postJson } from '../helpers/api';
import {
  createInvoice,
  createInvoiceableCustomer,
  dispatchOrder,
  purgeInvoicingTrail,
  setupOrderScenario,
  validRuc,
} from '../helpers/invoicing';
import { addDays } from '@ayr/shared';
import { today } from '../helpers/production';
import { headerAction } from '../helpers/ui';

/**
 * cc54 (D-654..D-663) — **la nota de crédito por motivo SUNAT**, un caso por tarjeta del diálogo:
 * Anular (01 y 02), Devolver (06), Rebajar (05), Corregir (03) y Cambiar el vencimiento (13). Todo
 * en un solo diálogo (D-660): se elige la tarjeta y el código, se completan los datos del motivo,
 * se lee «Qué va a pasar» y se registra con la serie y el número del papel.
 *
 * Una bobina vendida entera (setupOrderScenario), despachada y facturada a mano.
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

interface Sold {
  invoiceId: string;
  invoiceNumber: string;
  orderId: string;
  coilId: string;
  coilCode: string;
}

async function sell(
  api: APIRequestContext,
  options: { dispatch?: boolean; credit?: boolean } = {},
): Promise<Sold> {
  const scenario = await setupOrderScenario(api, { coilKg: '1000' });
  if (options.dispatch !== false) {
    await dispatchOrder(api, {
      salesOrderId: scenario.order.id,
      items: [{ salesOrderItemId: scenario.item.id, qty: scenario.item.qty }],
    });
  }
  const draft = await createInvoice(api, {
    docType: 'FACTURA',
    customerId: scenario.customer.id,
    salesOrderId: scenario.order.id,
    items: [{ salesOrderItemId: scenario.item.id, qty: scenario.item.qty }],
    ...(options.credit ? { paymentTerms: 'CREDITO', dueDate: addDays(today(), 30) } : {}),
  });
  const invoice = await postJson<{ id: string; number: string }>(
    api,
    `/api/invoicing/documents/${draft.id}/register-manual`,
    { series: series(), correlative: Number(correlative()) },
  );
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    orderId: scenario.order.id,
    coilId: scenario.coil.id,
    coilCode: scenario.coil.code,
  };
}

/** Abre el diálogo, elige el código y pasa al paso 2. */
async function openWith(page: Page, invoiceId: string, reason: string): Promise<Locator> {
  await page.goto(`/comprobantes/${invoiceId}`);
  await (await headerAction(page, 'Nota de crédito')).click();
  const dialog = page.getByTestId('credit-note-dialog');
  await expect(dialog).toContainText('¿Qué quieres hacer');
  await dialog.getByTestId(`credit-reason-${reason}`).click();
  await dialog.getByRole('button', { name: 'Continuar' }).click();
  await expect(dialog).toContainText('Motivo SUNAT');
  return dialog;
}

/** La serie y el número del papel, y el único botón principal. */
async function registerPaper(page: Page, dialog: Locator): Promise<void> {
  await dialog.getByLabel('Serie', { exact: true }).fill(series());
  await dialog.getByLabel('Número del papel').fill(correlative());
  const button = dialog.getByRole('button', { name: 'Registrar nota de crédito' });
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.click();
  await expect(page.getByRole('heading', { level: 1 })).not.toContainText('Borrador', {
    timeout: 60_000,
  });
}

test.describe('cc54 — nota de crédito por motivo SUNAT', () => {
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

  const track = (s: Sold) => {
    orderIds.push(s.orderId);
    coilIds.push(s.coilId);
    documentIds.push(s.invoiceId);
  };

  test('Devolver (06): la bobina vuelve con su DEV- y el (i) explica el código', async ({
    page,
  }) => {
    const s = await sell(api);
    track(s);
    await loginAsAdmin(page);
    await page.goto(`/comprobantes/${s.invoiceId}`);
    await (await headerAction(page, 'Nota de crédito')).click();
    const dialog = page.getByTestId('credit-note-dialog');
    await dialog.getByRole('button', { name: 'Qué es 06' }).click();
    await expect(
      page.getByText('El cliente devuelve toda la mercadería despachada.'),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await dialog.getByTestId('credit-reason-DEVOLUCION_TOTAL').click();
    await dialog.getByRole('button', { name: 'Continuar' }).click();
    const preview = dialog.getByTestId('credit-note-preview');
    await expect(preview).toContainText(s.coilCode, { timeout: 30_000 });
    await expect(preview).toContainText('(DEV-)');
    await registerPaper(page, dialog);
    const returnLink = page.getByRole('link', { name: /^DEV-\d{6}$/ });
    await expect(returnLink).toBeVisible({ timeout: 30_000 });
    // cc52 (D-646): el documento de devolución, vigente, y la bobina vuelve abierta con su peso.
    await returnLink.click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Devolución DEV-\d{6}/);
    await expect(page.getByText('Vigente')).toBeVisible();
    await page.getByRole('link', { name: s.coilCode }).click();
    await expect(page.getByText('Vigente').first()).toBeVisible({ timeout: 30_000 });
  });

  test('Anular (01) sin despacho: no mueve el almacén y lo dice antes de confirmar', async ({
    page,
  }) => {
    const s = await sell(api, { dispatch: false });
    track(s);
    await loginAsAdmin(page);
    const dialog = await openWith(page, s.invoiceId, 'ANULACION_OPERACION');
    const preview = dialog.getByTestId('credit-note-preview');
    await expect(preview).toContainText('Nada: no se mueve mercadería', { timeout: 30_000 });
    await expect(preview).toContainText('no salió del almacén');
    await registerPaper(page, dialog);
    await expect(page.getByText('Motivo SUNAT 01')).toBeVisible();
  });

  test('Rebajar (05): precio nuevo por línea, la venta baja y el almacén no se mueve', async ({
    page,
  }) => {
    const s = await sell(api);
    track(s);
    await loginAsAdmin(page);
    const dialog = await openWith(page, s.invoiceId, 'DESCUENTO_ITEM');
    await dialog.getByTestId('cn-lines').getByRole('textbox').fill('8.26');
    const preview = dialog.getByTestId('credit-note-preview');
    await expect(preview).toContainText('Nada: no se mueve mercadería', { timeout: 30_000 });
    await expect(preview).toContainText('el costo no cambia');
    await registerPaper(page, dialog);
    await expect(page.getByText('Motivo SUNAT 05')).toBeVisible();
  });

  test('Corregir (03): importe cero y la línea muestra la descripción corregida', async ({
    page,
  }) => {
    const s = await sell(api);
    track(s);
    await loginAsAdmin(page);
    const dialog = await openWith(page, s.invoiceId, 'CORRECCION_DESCRIPCION');
    await dialog.getByTestId('cn-lines').getByRole('textbox').fill('Bobina corregida cc54');
    const preview = dialog.getByTestId('credit-note-preview');
    await expect(preview).toContainText('No cambia: ni venta ni costo', { timeout: 30_000 });
    await registerPaper(page, dialog);
    await page.goto(`/comprobantes/${s.invoiceId}`);
    await expect(page.getByTestId('corrected-description')).toContainText('Bobina corregida cc54');
  });

  test('Cambiar el vencimiento (13): factura al crédito, importe cero, vence otro día', async ({
    page,
  }) => {
    const s = await sell(api, { credit: true });
    track(s);
    const due = addDays(today(), 45);
    await loginAsAdmin(page);
    const dialog = await openWith(page, s.invoiceId, 'OTROS_AJUSTES');
    await dialog.getByLabel('Vencimiento nuevo (pago único)').fill(due);
    const preview = dialog.getByTestId('credit-note-preview');
    await expect(preview).toContainText('vence el', { timeout: 30_000 });
    await registerPaper(page, dialog);
    await page.goto(`/comprobantes/${s.invoiceId}`);
    await expect(page.getByTestId('due-changed-by')).toBeVisible();
  });

  test('Anular por error en el RUC (02): reemplazo al cliente correcto, sin salida nueva', async ({
    page,
  }) => {
    const s = await sell(api);
    track(s);
    const ruc = validRuc();
    const right = await createInvoiceableCustomer(api, { docNumber: ruc });
    await loginAsAdmin(page);
    const dialog = await openWith(page, s.invoiceId, 'ANULACION_ERROR_RUC');
    await dialog.getByRole('button', { name: 'Elegir cliente…' }).click();
    const picker = page.getByRole('dialog', { name: 'Cliente correcto' });
    await picker.getByRole('textbox').fill(ruc);
    await picker
      .getByRole('row', { name: new RegExp(right.name) })
      .getByRole('button')
      .click();
    await dialog.getByLabel('Serie', { exact: true }).fill(series());
    await dialog.getByLabel('Número del papel').fill(correlative());
    await dialog.locator('#cn-r-series').fill(series());
    await dialog.locator('#cn-r-number').fill(correlative());
    const preview = dialog.getByTestId('credit-note-preview');
    await expect(preview).toContainText(right.name, { timeout: 30_000 });
    await expect(preview).toContainText('Nada: no se mueve mercadería');
    const button = dialog.getByRole('button', { name: 'Registrar nota de crédito' });
    await expect(button).toBeEnabled({ timeout: 30_000 });
    await button.click();
    await expect(page.getByText('Motivo SUNAT 02')).toBeVisible({ timeout: 60_000 });
    // El pedido pasó al cliente correcto.
    const order = await (await api.get(`/api/sales/orders/${s.orderId}`)).json();
    expect((order as { customerId: string }).customerId).toBe(right.id);
  });
});
