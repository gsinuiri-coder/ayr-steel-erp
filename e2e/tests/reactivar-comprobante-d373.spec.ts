import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { addDays } from '@ayr/shared';
import { adminApi, adminCredentials, getJson, postJson } from '../helpers/api';
import { today } from '../helpers/production';
import {
  createInvoice,
  getDocument,
  purgeInvoicingTrail,
  setupOrderScenario,
  type FiscalDocumentDto,
  type OrderScenario,
} from '../helpers/invoicing';

/**
 * D-373 — reactivar un comprobante manual anulado por error.
 *
 * La anulación interna solo cambia el estado; reactivar lo devuelve a «aceptado» sin despachar
 * nada. El despacho va aparte, con D-364 y a la fecha del comprobante, y su salida queda en el
 * kardex con esa fecha. La historia completa (anular → reactivar → anular) vive en la
 * auditoría, que copia los campos de anulación que la fila vacía.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea pedidos, despachos y comprobantes: nunca contra producción (D-126, regla dura 9).',
);

test.describe.configure({ timeout: 240_000 });

interface AuditEvent {
  action: string;
  occurredAt: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
}

interface Movement {
  type: string;
  refType: string;
  refId: string | null;
  operationDate: string;
}

/** La bobina entra antes que el comprobante: su salida a la fecha del papel no deja negativo. */
const COIL_RECEIVED_DAYS_AGO = 10;
const ISSUE_DAYS_AGO = 5;

function uniqueCorrelative(): number {
  return Number(String(Date.now()).slice(-7));
}

async function registeredManual(
  api: APIRequestContext,
  scenario: OrderScenario,
  issueDate: string,
  correlative: number,
): Promise<FiscalDocumentDto> {
  const draft = await createInvoice(api, {
    docType: 'FACTURA',
    customerId: scenario.customer.id,
    salesOrderId: scenario.order.id,
    issueDate,
    items: [{ salesOrderItemId: scenario.item.id, qty: scenario.item.qty }],
  });
  return postJson<FiscalDocumentDto>(api, `/api/invoicing/documents/${draft.id}/register-manual`, {
    series: 'F903',
    correlative,
  });
}

async function auditOf(api: APIRequestContext, id: string): Promise<AuditEvent[]> {
  const params = new URLSearchParams({
    entityType: 'fiscal_documents',
    entityId: id,
    from: addDays(today(), -1),
    to: addDays(today(), 1),
    pageSize: '50',
  });
  const page = await getJson<{ items: AuditEvent[] }>(api, `/api/audit?${params.toString()}`);
  // El visor lista del más nuevo al más viejo; acá se leen en el orden en que ocurrieron.
  return [...page.items].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

test.describe('D-373 — reactivar un comprobante manual anulado por error', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('anular → reactivar desde el menú de la fila → despachar con D-364 a la fecha del comprobante', async ({
    page,
  }) => {
    const scenario = await setupOrderScenario(api, {
      coilReceivedOn: addDays(today(), -COIL_RECEIVED_DAYS_AGO),
    });
    const issueDate = addDays(today(), -ISSUE_DAYS_AGO);
    const trail: string[] = [];
    let dispatchIds: string[] = [];
    try {
      const invoice = await registeredManual(api, scenario, issueDate, uniqueCorrelative());
      trail.push(invoice.id);
      const number = invoice.number ?? '';
      await postJson(api, `/api/invoicing/documents/${invoice.id}/annul`, {
        reason: 'mal despacho (E2E D-373)',
      });

      await loginAsAdmin(page);
      await page.goto(`/comprobantes?status=VOIDED,ANNULLED&search=${encodeURIComponent(number)}`);
      await page.getByRole('button', { name: `Más acciones de ${number}` }).click();
      await page.getByRole('menuitem', { name: 'Reactivar', exact: true }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('mal despacho (E2E D-373)');
      const confirm = dialog.getByRole('button', { name: 'Reactivar' });
      await dialog.getByLabel('Motivo de la reactivación').fill('Anulado por error (E2E)');
      // Sin la casilla no se puede confirmar.
      await expect(confirm).toBeDisabled();
      await dialog.getByLabel(/sigue vigente en Nubefact\/SUNAT/).check();
      await confirm.click();

      await expect(page).toHaveURL(
        new RegExp(`/comprobantes/${invoice.id}\\?despacho=fecha-comprobante`),
        { timeout: 60_000 },
      );
      const card = page.getByTestId('dispatch-at-issue-date');
      await expect(card.getByTestId('dispatch-suggested-date')).toContainText(
        'pendiente de despacho',
        { timeout: 60_000 },
      );
      await expect(card.getByLabel('Fecha de despacho')).toHaveValue(issueDate);
      await card.getByRole('button', { name: 'Despachar en la fecha seleccionada' }).click();
      await expect(page.getByText(/despachada\(s\) en la fecha seleccionada/)).toBeVisible();

      const after = await getDocument(api, invoice.id);
      expect(after.status).toBe('ACCEPTED');
      expect(after.annulledAt).toBeNull();
      expect(after.annulReason).toBeNull();

      const dispatches = await getJson<{ items: { id: string }[] }>(
        api,
        `/api/dispatches?salesOrderId=${scenario.order.id}`,
      );
      dispatchIds = dispatches.items.map((d) => d.id);
      expect(dispatchIds).toHaveLength(1);

      // La salida de la bobina quedó en el kardex con la fecha del comprobante.
      const movements = await getJson<{ items: Movement[] }>(
        api,
        `/api/inventory/movements?itemType=COIL&itemId=${scenario.coil.id}&pageSize=50`,
      );
      const out = movements.items.find((m) => m.type === 'OUT' && m.refType === 'SALE');
      expect(out, JSON.stringify(movements.items)).toBeDefined();
      expect(out?.operationDate).toBe(issueDate);
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

  test('reingresar el número sigue rechazado; el borrador bloquea; reactivar y volver a anular deja tres eventos', async () => {
    const scenario = await setupOrderScenario(api, {
      coilReceivedOn: addDays(today(), -COIL_RECEIVED_DAYS_AGO),
    });
    const issueDate = addDays(today(), -ISSUE_DAYS_AGO);
    const correlative = uniqueCorrelative();
    const trail: string[] = [];
    try {
      const invoice = await registeredManual(api, scenario, issueDate, correlative);
      trail.push(invoice.id);
      await postJson(api, `/api/invoicing/documents/${invoice.id}/annul`, {
        reason: 'primera anulación (E2E D-373)',
      });

      // El reingreso: un borrador sobre la misma línea, con el mismo número, choca.
      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: scenario.customer.id,
        salesOrderId: scenario.order.id,
        issueDate,
        items: [{ salesOrderItemId: scenario.item.id, qty: scenario.item.qty }],
      });
      trail.push(draft.id);
      const clash = await api.post(`/api/invoicing/documents/${draft.id}/register-manual`, {
        data: { series: 'F903', correlative },
      });
      expect(clash.status()).toBe(409);
      expect(await clash.text()).toContain('Ya hay un comprobante registrado con el número');

      // Ese borrador bloquea la reactivación y no se borra solo.
      const blocked = await api.post(`/api/invoicing/documents/${invoice.id}/reactivate`, {
        data: { reason: 'Anulado por error (E2E)', confirmStillValid: true },
      });
      expect(blocked.status()).toBe(409);
      expect(await blocked.text()).toContain('borrador');
      expect((await getDocument(api, draft.id)).status).toBe('DRAFT');

      // Sin la casilla, tampoco.
      const unchecked = await api.post(`/api/invoicing/documents/${invoice.id}/reactivate`, {
        data: { reason: 'Anulado por error (E2E)', confirmStillValid: false },
      });
      expect(unchecked.status()).toBe(400);

      const discarded = await api.delete(`/api/invoicing/documents/${draft.id}`, {
        data: { reason: 'Borrador del reingreso (E2E D-373)' },
      });
      expect(discarded.status()).toBe(204);
      trail.splice(trail.indexOf(draft.id), 1);

      const reactivated = await postJson<FiscalDocumentDto>(
        api,
        `/api/invoicing/documents/${invoice.id}/reactivate`,
        { reason: 'Anulado por error (E2E)', confirmStillValid: true },
      );
      expect(reactivated.status).toBe('ACCEPTED');
      expect(reactivated.balancePen).toBe(invoice.balancePen);

      // Un segundo intento ve el estado ya cambiado.
      const again = await api.post(`/api/invoicing/documents/${invoice.id}/reactivate`, {
        data: { reason: 'Anulado por error (E2E)', confirmStillValid: true },
      });
      expect(again.status()).toBe(409);

      // Volver a anular funciona.
      await postJson(api, `/api/invoicing/documents/${invoice.id}/annul`, {
        reason: 'segunda anulación (E2E D-373)',
      });
      expect((await getDocument(api, invoice.id)).status).toBe('ANNULLED');

      const events = (await auditOf(api, invoice.id)).filter((e) =>
        ['invoicing.import.annul', 'invoicing.document.reactivate'].includes(e.action),
      );
      expect(events.map((e) => e.action)).toEqual([
        'invoicing.import.annul',
        'invoicing.document.reactivate',
        'invoicing.import.annul',
      ]);
      const reactivation = events[1]!;
      expect(reactivation.reason).toBe('Anulado por error (E2E)');
      expect(reactivation.before).toMatchObject({
        status: 'ANNULLED',
        statusBeforeAnnul: 'ACCEPTED',
        annulReason: 'primera anulación (E2E D-373)',
      });
      expect(reactivation.before?.annulledAt).toEqual(expect.any(String));
      expect(reactivation.before?.annulledById).toEqual(expect.any(String));
      expect(reactivation.after).toMatchObject({ status: 'ACCEPTED', confirmedStillValid: true });

      // Y el número sigue ocupado: reingresarlo sigue rechazado.
      const draft2 = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: scenario.customer.id,
        salesOrderId: scenario.order.id,
        issueDate,
        items: [{ salesOrderItemId: scenario.item.id, qty: scenario.item.qty }],
      });
      trail.push(draft2.id);
      const clash2 = await api.post(`/api/invoicing/documents/${draft2.id}/register-manual`, {
        data: { series: 'F903', correlative },
      });
      expect(clash2.status()).toBe(409);
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

  test('si la línea ya se facturó en otro comprobante, no se reactiva y lo nombra', async () => {
    const scenario = await setupOrderScenario(api, {
      coilReceivedOn: addDays(today(), -COIL_RECEIVED_DAYS_AGO),
    });
    const issueDate = addDays(today(), -ISSUE_DAYS_AGO);
    const trail: string[] = [];
    try {
      const invoice = await registeredManual(api, scenario, issueDate, uniqueCorrelative());
      trail.push(invoice.id);
      await postJson(api, `/api/invoicing/documents/${invoice.id}/annul`, {
        reason: 'anulación (E2E D-373, refacturada)',
      });
      // Mientras estuvo anulado, la misma línea se facturó en otro manual con otro número.
      const other = await registeredManual(api, scenario, issueDate, uniqueCorrelative() + 1);
      trail.push(other.id);

      const refused = await api.post(`/api/invoicing/documents/${invoice.id}/reactivate`, {
        data: { reason: 'Anulado por error (E2E)', confirmStillValid: true },
      });
      expect(refused.status()).toBe(409);
      expect(await refused.text()).toContain(
        `La línea ${String(scenario.item.lineNumber)} del pedido ya se volvió a facturar en ${other.number ?? ''}`,
      );
      expect((await getDocument(api, invoice.id)).status).toBe('ANNULLED');
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
