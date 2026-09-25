import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { addDays } from '@ayr/shared';
import { adminApi, adminCredentials, getJson, postJson } from '../helpers/api';
import { movementsOf, today } from '../helpers/production';
import {
  createInvoice,
  purgeInvoicingTrail,
  setupOrderScenario,
  type FiscalDocumentDto,
  type OrderScenario,
} from '../helpers/invoicing';

/**
 * D-288 — corregir la fecha de emisión re-fecha el despacho «a la fecha del comprobante».
 *
 * Caso real: FFA1-00001386 se registró con 19-09 en lugar de 19-08; su despacho (D-278) quedó
 * al 19-09 y, al corregir la emisión, la salida de kardex siguió en la fecha vieja. Ahora la
 * corrección ofrece re-fechar en la misma operación: revierte el despacho como corrección de
 * fecha (el movimiento inverso a la fecha del que anula: el par queda neto el mismo día) y
 * vuelve a despachar a la fecha nueva. Todo o nada.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea pedidos, despachos y comprobantes: nunca contra producción (D-126, regla dura 9).',
);

test.describe.configure({ timeout: 240_000 });

interface DispatchRow {
  id: string;
  status: string;
  dispatchDate: string;
}

const day = (offset: number): string => addDays(today(), offset);

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

async function dispatchesOf(api: APIRequestContext, orderId: string): Promise<DispatchRow[]> {
  const res = await getJson<{ items: DispatchRow[] }>(
    api,
    `/api/dispatches?salesOrderId=${orderId}`,
  );
  return res.items;
}

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

test.describe('D-288 — re-fechar el despacho al corregir la fecha de emisión', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('el diálogo lo ofrece; re-fechar revierte al día viejo y despacha al nuevo, neto en cero', async ({
    page,
  }) => {
    const scenario = await setupOrderScenario(api, { coilReceivedOn: day(-6) });
    const trail: string[] = [];
    try {
      const invoice = await registeredInvoice(api, scenario, day(-1));
      trail.push(invoice.id);
      await postJson(api, `/api/dispatches/at-issue-date/${invoice.id}`);
      const [original] = await dispatchesOf(api, scenario.order.id);
      expect(original).toMatchObject({ status: 'ISSUED', dispatchDate: day(-1) });

      const linked = await getJson<{ dispatches: { id: string; atIssueDate: boolean }[] }>(
        api,
        `/api/dispatches/at-issue-date/${invoice.id}/linked`,
      );
      expect(linked.dispatches).toEqual([
        expect.objectContaining({ id: original!.id, atIssueDate: true }),
      ]);

      // La pantalla avisa y ofrece re-fechar, marcado por defecto.
      await loginAsAdmin(page);
      await page.goto(`/comprobantes/${invoice.id}`);
      await page.getByRole('button', { name: 'Más acciones', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Corregir fecha de emisión' }).click();
      await page.locator('#new-issue-date').fill(day(-3));
      await page.locator('#issue-date-reason').fill('Se tipeó mal la fecha del papel');
      const offer = page.getByTestId('issue-date-redate');
      await expect(offer).toContainText('se despachó a la fecha del comprobante');
      await expect(offer.getByRole('checkbox')).toBeChecked();
      await page.getByRole('button', { name: 'Corregir', exact: true }).click();
      await expect(page.getByText(`Fecha de emisión corregida: ${day(-3)}`)).toBeVisible();

      const after = await dispatchesOf(api, scenario.order.id);
      expect(after.find((x) => x.id === original!.id)?.status).toBe('REVERSED');
      const fresh = after.filter((x) => x.status === 'ISSUED');
      expect(fresh).toHaveLength(1);
      expect(fresh[0]!.dispatchDate).toBe(day(-3));

      // Kardex de la bobina: la salida vieja y su reversa el mismo día (netas en cero), y la
      // salida nueva a la fecha corregida. Saldo final: cero, como antes.
      const moves = await movementsOf(api, 'COIL', scenario.coil.id);
      const oldOut = moves.find((m) => m.type === 'OUT' && m.reversedById !== null);
      const reversal = moves.find((m) => m.reversalOfId === oldOut?.id);
      const newOut = moves.find(
        (m) => m.type === 'OUT' && m.reversedById === null && m.reversalOfId === null,
      );
      expect(oldOut?.operationDate).toBe(day(-1));
      expect(reversal?.operationDate).toBe(day(-1));
      expect(reversal?.totalCost).toBe(oldOut?.totalCost);
      expect(newOut?.operationDate).toBe(day(-3));
      expect(newOut?.qty).toBe(oldOut?.qty);

      const order = await getJson<{ status: string }>(
        api,
        `/api/sales/orders/${scenario.order.id}`,
      );
      expect(order.status).toBe('FULFILLED');
    } finally {
      await purgeInvoicingTrail(api, {
        documentIds: trail,
        dispatchIds: (await dispatchesOf(api, scenario.order.id)).map((x) => x.id),
        orderIds: [scenario.order.id],
        coilIds: [scenario.coil.id],
        purchaseId: scenario.purchaseId,
        supplierId: scenario.supplier.id,
        finish: scenario.finish,
        productIds: [scenario.product.id],
      });
    }
  });

  test('sin decidir no se toca nada; con «no» cambia la fecha y el despacho queda', async () => {
    const scenario = await setupOrderScenario(api, { coilReceivedOn: day(-6) });
    const trail: string[] = [];
    try {
      const invoice = await registeredInvoice(api, scenario, day(-1));
      trail.push(invoice.id);
      await postJson(api, `/api/dispatches/at-issue-date/${invoice.id}`);
      const [original] = await dispatchesOf(api, scenario.order.id);

      const undecided = await api.patch(`/api/invoicing/documents/${invoice.id}/issue-date`, {
        data: { issueDate: day(-3), reason: 'Se tipeó mal', confirmDueDateShift: true },
      });
      expect(undecided.status()).toBe(409);
      expect(await undecided.text()).toContain('indicá si se re-fechan');
      const unchanged = await getJson<FiscalDocumentDto>(
        api,
        `/api/invoicing/documents/${invoice.id}`,
      );
      expect(unchanged.issueDate).toBe(day(-1));

      const kept = await api.patch(`/api/invoicing/documents/${invoice.id}/issue-date`, {
        data: {
          issueDate: day(-3),
          reason: 'Se tipeó mal',
          confirmDueDateShift: true,
          redateDispatches: false,
        },
      });
      expect(kept.ok()).toBe(true);
      const after = await dispatchesOf(api, scenario.order.id);
      expect(after).toEqual([
        expect.objectContaining({ id: original!.id, status: 'ISSUED', dispatchDate: day(-1) }),
      ]);
    } finally {
      await purgeInvoicingTrail(api, {
        documentIds: trail,
        dispatchIds: (await dispatchesOf(api, scenario.order.id)).map((x) => x.id),
        orderIds: [scenario.order.id],
        coilIds: [scenario.coil.id],
        purchaseId: scenario.purchaseId,
        supplierId: scenario.supplier.id,
        finish: scenario.finish,
        productIds: [scenario.product.id],
      });
    }
  });

  test('si a la fecha nueva el kardex quedaría negativo, no se escribe nada', async () => {
    // La bobina entra anteayer: re-fechar la salida a hace tres días la dejaría negativa.
    const scenario = await setupOrderScenario(api, { coilReceivedOn: day(-2) });
    const trail: string[] = [];
    try {
      const invoice = await registeredInvoice(api, scenario, day(-1));
      trail.push(invoice.id);
      await postJson(api, `/api/dispatches/at-issue-date/${invoice.id}`);
      const [original] = await dispatchesOf(api, scenario.order.id);

      const refused = await api.patch(`/api/invoicing/documents/${invoice.id}/issue-date`, {
        data: {
          issueDate: day(-3),
          reason: 'Se tipeó mal',
          confirmDueDateShift: true,
          redateDispatches: true,
        },
      });
      expect(refused.status()).toBe(400);
      expect(await refused.text()).toContain('kardex negativo');

      // Todo o nada: ni la fecha, ni la reversa, ni un despacho nuevo.
      const unchanged = await getJson<FiscalDocumentDto>(
        api,
        `/api/invoicing/documents/${invoice.id}`,
      );
      expect(unchanged.issueDate).toBe(day(-1));
      expect(await dispatchesOf(api, scenario.order.id)).toEqual([
        expect.objectContaining({ id: original!.id, status: 'ISSUED', dispatchDate: day(-1) }),
      ]);
    } finally {
      await purgeInvoicingTrail(api, {
        documentIds: trail,
        dispatchIds: (await dispatchesOf(api, scenario.order.id)).map((x) => x.id),
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
