import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { addDays, type FiscalDocumentDto, type SalesReturnDto } from '@ayr/shared';
import { adminApi, adminCredentials, getJson, postJson } from '../helpers/api';
import {
  createInvoice,
  dispatchOrder,
  purgeInvoicingTrail,
  setupOrderScenario,
} from '../helpers/invoicing';
import { today } from '../helpers/production';

/**
 * cc70 (D-730) — **la fecha de una NC con devolución vigente se corrige; la DEV- no se mueve.**
 *
 * Una bobina vendida entera, despachada y facturada a mano; NC 07 de hoy con su DEV-. Se corrige la
 * fecha de la nota a ayer desde el detalle: el diálogo avisa que la devolución se queda en su
 * fecha, la nota cambia y la DEV- sigue con su fecha y su costo.
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
const correlative = () => Math.floor(Math.random() * 90_000_000) + 1_000_000;

test.describe('cc70 — fecha de una NC con devolución vigente', () => {
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

  test('se corrige la fecha de la nota y la DEV- se queda en la suya', async ({ page }) => {
    const scenario = await setupOrderScenario(api, {
      coilKg: '1000',
      coilReceivedOn: addDays(today(), -3),
    });
    orderIds.push(scenario.order.id);
    coilIds.push(scenario.coil.id);
    await dispatchOrder(api, {
      salesOrderId: scenario.order.id,
      dispatchDate: addDays(today(), -2),
      items: [{ salesOrderItemId: scenario.item.id, qty: scenario.item.qty }],
    });
    const draft = await createInvoice(api, {
      docType: 'FACTURA',
      customerId: scenario.customer.id,
      salesOrderId: scenario.order.id,
      issueDate: addDays(today(), -2),
      items: [{ salesOrderItemId: scenario.item.id, qty: scenario.item.qty }],
    });
    const invoice = await postJson<FiscalDocumentDto>(
      api,
      `/api/invoicing/documents/${draft.id}/register-manual`,
      { series: series(), correlative: correlative() },
    );
    documentIds.push(invoice.id);
    const note = await postJson<FiscalDocumentDto>(
      api,
      `/api/invoicing/documents/${invoice.id}/credit-note/register`,
      {
        issueDate: today(),
        reason: 'DEVOLUCION_TOTAL',
        series: series(),
        correlative: correlative(),
      },
    );
    documentIds.push(note.id);
    const devId = note.salesReturn?.id ?? '';
    const devBefore = await getJson<SalesReturnDto>(api, `/api/invoicing/returns/${devId}`);
    const newDate = addDays(today(), -1);

    await loginAsAdmin(page);
    await page.goto(`/comprobantes/${note.id}`);
    await page.getByRole('button', { name: 'Más opciones', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Corregir fecha de emisión' }).click();
    const [, m, d] = devBefore.operationDate.split('-');
    await expect(page.getByTestId('issue-date-sales-return')).toHaveText(
      `La devolución ${devBefore.code} se queda el ${d ?? ''}/${m ?? ''}; cambia solo la fecha fiscal de la nota.`,
    );
    await page.locator('#new-issue-date').fill(newDate);
    await page.locator('#issue-date-reason').fill('La fecha del papel es de ayer');
    await page.getByRole('button', { name: 'Corregir', exact: true }).click();
    await expect(page.getByText(`Fecha de emisión corregida: ${newDate}`)).toBeVisible();

    const noteAfter = await getJson<FiscalDocumentDto>(api, `/api/invoicing/documents/${note.id}`);
    expect(noteAfter.issueDate).toBe(newDate);
    const devAfter = await getJson<SalesReturnDto>(api, `/api/invoicing/returns/${devId}`);
    expect([devAfter.status, devAfter.operationDate, devAfter.totalCostPen]).toEqual([
      devBefore.status,
      devBefore.operationDate,
      devBefore.totalCostPen,
    ]);
    expect(devAfter.creditNoteDate).toBe(newDate);

    // El detalle de la DEV- no atribuye a un despacho la diferencia de fechas (segundo modelo, P2-1).
    await page.goto(`/devoluciones/${devId}`);
    const [ny, nm, nd] = newDate.split('-');
    await expect(
      page.getByText(`La nota es del ${nd ?? ''}/${nm ?? ''}/${ny ?? ''}`),
    ).toBeVisible();
    await expect(page.getByTestId('sales-return-late-entry')).toHaveCount(0);
  });
});
