import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, postJson } from '../helpers/api';
import {
  createInvoice,
  dispatchOrder,
  purgeInvoicingTrail,
  setupOrderScenario,
} from '../helpers/invoicing';
import { today } from '../helpers/production';
import { headerAction } from '../helpers/ui';

/**
 * cc52 — D-645..D-647: nota de crédito con fecha y motivo de lista; la de «Devolución de
 * mercadería», al registrarse, genera el documento de devolución y la bobina vuelve al kardex al
 * costo con que salió.
 *
 * Una bobina vendida entera (setupOrderScenario), despachada y facturada a mano. La NC se crea en
 * la pantalla (tipo, motivo y fecha) y se registra a mano en la pantalla.
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

test.describe('cc52 — nota de crédito con devolución', () => {
  test.skip(!allowWrites, 'Vende, despacha y factura: nunca contra producción (D-126).');

  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('la NC de devolución genera el documento DEV- y la bobina vuelve con su peso', async ({
    page,
  }) => {
    const scenario = await setupOrderScenario(api, { coilKg: '1000' });
    const orderIds = [scenario.order.id];
    try {
      await dispatchOrder(api, {
        salesOrderId: scenario.order.id,
        items: [{ salesOrderItemId: scenario.item.id, qty: scenario.item.qty }],
      });
      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: scenario.customer.id,
        salesOrderId: scenario.order.id,
        items: [{ salesOrderItemId: scenario.item.id, qty: scenario.item.qty }],
      });
      const invoice = await postJson<{ id: string; number: string }>(
        api,
        `/api/invoicing/documents/${draft.id}/register-manual`,
        { series: series(), correlative: Number(correlative()) },
      );

      await loginAsAdmin(page);
      await page.goto(`/comprobantes/${invoice.id}`);
      await (await headerAction(page, 'Nota de crédito')).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel('Fecha de la nota')).toHaveValue(today());
      await dialog.getByLabel('Tipo de nota').click();
      await page.getByRole('option', { name: 'Devolución de mercadería' }).click();
      await expect(dialog).toContainText('vuelve al almacén');
      await dialog.getByLabel('Motivo (catálogo 09 de SUNAT)').click();
      await page.getByRole('option', { name: /Devolución total/ }).click();
      await dialog.getByRole('button', { name: 'Crear borrador de nota de crédito' }).click();

      // El borrador de la NC: se registra a mano (Nubefact fuera del alcance).
      await expect(page).not.toHaveURL(new RegExp(invoice.id), { timeout: 30_000 });
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Borrador', {
        timeout: 30_000,
      });
      await (await headerAction(page, 'Registrar manual')).click();
      await page.getByLabel('Serie').fill(series());
      await page.getByLabel('Correlativo').fill(correlative());
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /^Registrar/ })
        .click();

      const returnLink = page.getByRole('link', { name: /^DEV-\d{6}$/ });
      await expect(returnLink).toBeVisible({ timeout: 30_000 });
      await returnLink.click();
      await expect(page.getByRole('heading', { level: 1 })).toContainText(/Devolución DEV-\d{6}/);
      await expect(page.getByText('Vigente')).toBeVisible();
      await expect(page.getByRole('link', { name: scenario.coil.code })).toBeVisible();

      // La bobina volvió abierta, con su peso.
      await page.getByRole('link', { name: scenario.coil.code }).click();
      await expect(page.getByText('Vigente').first()).toBeVisible({ timeout: 30_000 });
    } finally {
      await purgeInvoicingTrail(api, { orderIds, coilIds: [scenario.coil.id] }).catch(
        () => undefined,
      );
    }
  });
});
