import { expect, test, type APIRequestContext } from '@playwright/test';
import type { FiscalDocumentDto } from '@ayr/shared';
import { adminApi, postJson } from '../helpers/api';
import {
  annulImported,
  createCreditNote,
  createInvoice,
  getDocument,
  setupOrderScenario,
} from '../helpers/invoicing';

/**
 * cc33 N3 — una nota de crédito en borrador sobre una factura manual. Antes, anular la factura no
 * miraba los borradores: la nota se registraba después y quedaba viva sobre un comprobante anulado.
 * Ahora la anulación se rechaza nombrando el borrador, y vuelve a andar cuando se descarta.
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea comprobantes y notas de crédito: nunca contra producción (D-126).');
test.describe.configure({ timeout: 180_000 });

function manualSeries(): string {
  return `F9${String(Math.floor(Math.random() * 90) + 10)}`;
}

function manualCorrelative(): number {
  return Math.floor(Math.random() * 90_000) + 1_000;
}

test.describe('cc33 N3 — nota de crédito en borrador', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('factura manual → NC en borrador → anular se rechaza; sin el borrador, se anula', async () => {
    const scenario = await setupOrderScenario(api, { coilKg: '200' });
    const draft = await createInvoice(api, {
      docType: 'FACTURA',
      customerId: scenario.customer.id,
      salesOrderId: scenario.order.id,
      items: [{ salesOrderItemId: scenario.item.id, qty: '2' }],
    });
    const invoice = await postJson<FiscalDocumentDto>(
      api,
      `/api/invoicing/documents/${draft.id}/register-manual`,
      { series: manualSeries(), correlative: manualCorrelative() },
    );
    expect(invoice).toMatchObject({ status: 'ACCEPTED', origin: 'MANUAL' });

    const note = await createCreditNote(api, invoice.id, { reason: 'ANULACION_OPERACION' });
    expect(note.status).toBe('DRAFT');

    const blocked = await annulImported(api, invoice.id, 'Prueba E2E cc33 con NC en borrador');
    expect(blocked.status()).toBe(400);
    const message = await blocked.text();
    expect(message).toContain('una nota de crédito en borrador');
    expect(message).toContain(`por S/ ${Number(note.totalPen).toFixed(2)}`);
    expect((await getDocument(api, invoice.id)).status).toBe('ACCEPTED');

    // Descartado el borrador, la anulación pasa.
    const discarded = await api.delete(`/api/invoicing/documents/${note.id}`, {
      data: { reason: 'Prueba E2E cc33: descartar la NC' },
    });
    expect(discarded.ok(), await discarded.text()).toBe(true);
    const annulled = await annulImported(api, invoice.id, 'Prueba E2E cc33 sin borrador');
    expect(annulled.ok(), await annulled.text()).toBe(true);
    expect((await getDocument(api, invoice.id)).status).toBe('ANNULLED');
  });
});
