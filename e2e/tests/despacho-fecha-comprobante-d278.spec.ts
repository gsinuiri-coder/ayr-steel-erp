import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { addDays } from '@ayr/shared';
import { adminApi, adminCredentials, getJson, postJson } from '../helpers/api';
import { today } from '../helpers/production';
import {
  createInvoice,
  purgeInvoicingTrail,
  setupOrderScenario,
  type FiscalDocumentDto,
  type OrderScenario,
} from '../helpers/invoicing';

/**
 * D-278 — «Despachar a la fecha del comprobante».
 *
 * Un comprobante emitido (o registrado a mano) sin despacho deja el kardex con stock que ya no
 * está y la reserva del pedido viva. La pantalla del comprobante ofrece —no hace— despacharlo
 * con la fecha de emisión; el API decide línea por línea y nunca deja el kardex negativo en una
 * fecha intermedia.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea pedidos, despachos y comprobantes: nunca contra producción (D-126, regla dura 9).',
);

test.describe.configure({ timeout: 240_000 });

interface PlanDto {
  invoiceId: string;
  lines: { lineNumber: number; action: string; reason: string | null; operationDate: string }[];
}

function yesterday(): string {
  return addDays(today(), -1);
}

async function registeredInvoice(
  api: APIRequestContext,
  scenario: OrderScenario,
  issueDate: string,
): Promise<FiscalDocumentDto> {
  const draft = await createInvoice(api, {
    docType: 'FACTURA',
    customerId: scenario.customer.id,
    salesOrderId: scenario.order.id,
    issueDate,
    items: [{ salesOrderItemId: scenario.item.id, qty: scenario.item.qty }],
  });
  return postJson<FiscalDocumentDto>(api, `/api/invoicing/documents/${draft.id}/register-manual`, {
    series: 'F902',
    correlative: Number(String(Date.now()).slice(-7)),
  });
}

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

test.describe('D-278 — despacho a la fecha del comprobante', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('el comprobante sin despacho ofrece el botón; despachar saca la bobina a la fecha de emisión y atiende el pedido', async ({
    page,
  }) => {
    const scenario = await setupOrderScenario(api);
    const trail: string[] = [];
    let dispatchIds: string[] = [];
    try {
      const invoice = await registeredInvoice(api, scenario, today());
      trail.push(invoice.id);

      const plan = await getJson<PlanDto>(api, `/api/dispatches/at-issue-date/${invoice.id}`);
      expect(plan.lines).toHaveLength(1);
      expect(plan.lines[0]).toMatchObject({ action: 'DISPATCH', operationDate: today() });

      await loginAsAdmin(page);
      await page.goto(`/comprobantes/${invoice.id}`);
      const card = page.getByTestId('dispatch-at-issue-date');
      await expect(card).toContainText('sin despacho registrado', { timeout: 60_000 });
      await card.getByRole('button', { name: 'Despachar a la fecha del comprobante' }).click();
      await expect(page.getByText(/despachada\(s\) a la fecha del comprobante/)).toBeVisible();
      await expect(card).toBeHidden();

      const dispatches = await getJson<{ items: { id: string; status: string }[] }>(
        api,
        `/api/dispatches?salesOrderId=${scenario.order.id}`,
      );
      dispatchIds = dispatches.items.map((d) => d.id);
      expect(dispatchIds).toHaveLength(1);

      const order = await getJson<{ status: string; stage: string }>(
        api,
        `/api/sales/orders/${scenario.order.id}`,
      );
      expect(order.status).toBe('FULFILLED');
      expect(order.stage).toBe('FULFILLED');
      // D-170: la venta de la bobina entera la cierra.
      const coil = await getJson<{ status: string }>(api, `/api/coils/${scenario.coil.id}`);
      expect(coil.status).toBe('CLOSED');

      // Nada más que despachar: la tarjeta ya no aparece y el plan viene vacío.
      const after = await getJson<PlanDto>(api, `/api/dispatches/at-issue-date/${invoice.id}`);
      expect(after.lines).toHaveLength(0);
    } finally {
      await purgeInvoicingTrail(api, {
        documentIds: trail,
        dispatchIds,
        orderIds: [scenario.order.id],
        coilIds: [scenario.coil.id],
        purchaseId: scenario.purchaseId,
        supplierId: scenario.supplier.id,
        finish: scenario.finish,
        productIds: [scenario.product.id],
      });
    }
  });

  test('si la salida retroactiva deja el kardex negativo, la línea va a revisión y no se despacha', async () => {
    // La bobina entró hoy: una factura de ayer no puede sacarla ayer.
    const scenario = await setupOrderScenario(api);
    const trail: string[] = [];
    try {
      const invoice = await registeredInvoice(api, scenario, yesterday());
      trail.push(invoice.id);

      const plan = await getJson<PlanDto>(api, `/api/dispatches/at-issue-date/${invoice.id}`);
      expect(plan.lines[0]).toMatchObject({ action: 'REVIEW' });
      expect(plan.lines[0]?.reason).toContain('negativo');

      const res = await api.post(`/api/dispatches/at-issue-date/${invoice.id}`);
      expect(res.status()).toBe(400);
      const order = await getJson<{ status: string }>(
        api,
        `/api/sales/orders/${scenario.order.id}`,
      );
      expect(order.status).toBe('CONFIRMED');
    } finally {
      await purgeInvoicingTrail(api, {
        documentIds: trail,
        orderIds: [scenario.order.id],
        coilIds: [scenario.coil.id],
        purchaseId: scenario.purchaseId,
        supplierId: scenario.supplier.id,
        finish: scenario.finish,
        productIds: [scenario.product.id],
      });
    }
  });
});
