import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getJson, postJson } from '../helpers/api';
import { optionalBalanceOf, postExpectingError } from '../helpers/production';
import {
  addPayment,
  annulImported,
  createInvoice,
  getDocument,
  purgeInvoicingTrail,
  setupOrderScenario,
  type FiscalDocumentDto,
  type OrderScenario,
} from '../helpers/invoicing';

/**
 * Comprobantes **manuales** junto a los electrónicos (D-153).
 *
 * La empresa sigue emitiendo desde otra app mientras dura la migración, y esos comprobantes
 * tienen que quedar registrados acá con su cuenta por cobrar. Lo que estos casos protegen:
 *
 * - **Un borrador tiene dos terminales y son excluyentes.** `send` toma un correlativo del ERP
 *   y va al PSE; `register-manual` cierra el comprobante con el número del papel. Las dos
 *   parten del mismo borrador, así que un manual pasa por **las mismas validaciones** que un
 *   electrónico — que es la razón entera de que compartan el primer paso.
 * - **El manual no toca la numeración del ERP.** Registrar `F900-1349` no adelanta ninguna
 *   serie: adelantarla quemaría rango de las series con las que se factura de verdad.
 * - **El kardex es idéntico en los dos modos**, y no porque se comparta código: porque el
 *   comprobante no mueve stock en ninguno. Lo mueve el despacho (D-074).
 * - **Un número repetido se rechaza**, que es lo único que la base no puede recuperar sola.
 * - **La reversa existe**: un manual mal registrado se anula internamente (D-110/D-153) y su
 *   deuda desaparece; uno que el ERP emitió, no.
 *
 * Todos los casos escriben (pedidos, despachos, comprobantes): nunca contra producción
 * (regla dura 9, D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea pedidos, despachos y comprobantes: nunca contra producción (D-126, regla dura 9).',
);

test.describe.configure({ timeout: 180_000 });

/** Serie del talonario de la otra app. `F9xx` para no chocar con ninguna serie del ERP. */
function manualSeries(): string {
  return `F9${String(Math.floor(Math.random() * 90) + 10)}`;
}

function manualCorrelative(): number {
  return Math.floor(Math.random() * 90_000) + 1_000;
}

async function registerManual(
  api: APIRequestContext,
  id: string,
  series: string,
  correlative: number,
): Promise<FiscalDocumentDto> {
  return postJson<FiscalDocumentDto>(api, `/api/invoicing/documents/${id}/register-manual`, {
    series,
    correlative,
  });
}

interface SeriesRow {
  id: string;
  series: string;
  correlative: number;
}

test.describe('D-153 — comprobantes manuales', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('registro manual desde el pedido: nace aceptado, con su número y sin tocar la numeración del ERP', async () => {
    const scenario: OrderScenario = await setupOrderScenario(api);
    const trail: string[] = [];

    try {
      // La numeración propia del ERP, **antes**: registrar un manual no puede moverla.
      const seriesBefore = await getJson<SeriesRow[]>(api, '/api/invoicing/series');

      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: scenario.customer.id,
        salesOrderId: scenario.order.id,
        items: [{ salesOrderItemId: scenario.item.id, qty: '2' }],
      });
      trail.push(draft.id);
      expect(draft.status).toBe('DRAFT');
      // Un borrador no tiene número en ningún modo (D-072).
      expect(draft.number).toBeNull();
      expect(draft.origin).toBe('ISSUED_HERE');

      const series = manualSeries();
      const correlative = manualCorrelative();
      const registered = await registerManual(api, draft.id, series, correlative);

      expect(registered.origin).toBe('MANUAL');
      // Nace aceptado por el mismo motivo que un importado (D-105): el papel existe y la otra
      // app ya lo declaró. No pasa por emitido-pendiente-de-envío.
      expect(registered.status).toBe('ACCEPTED');
      expect(registered.number).toBe(`${series}-${String(correlative).padStart(8, '0')}`);
      // La serie sale de su propio número, no de una `fiscal_series`: el papel no es del ERP.
      expect(registered.series).toBe(series);
      expect(registered.correlative).toBe(correlative);

      // **La numeración del ERP quedó intacta**, serie por serie.
      const seriesAfter = await getJson<SeriesRow[]>(api, '/api/invoicing/series');
      for (const before of seriesBefore) {
        const after = seriesAfter.find((s) => s.id === before.id);
        expect(after?.correlative, `la serie ${before.series} no se movió`).toBe(
          before.correlative,
        );
      }

      // Y debe: la cuenta por cobrar es la misma que la de un electrónico aceptado.
      const detail = await getDocument(api, registered.id);
      expect(detail.balancePen).toBe(detail.totalPen);
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

  test('el mismo número no se puede registrar dos veces', async () => {
    const scenario = await setupOrderScenario(api);
    const trail: string[] = [];

    try {
      const series = manualSeries();
      const correlative = manualCorrelative();

      const first = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: scenario.customer.id,
        salesOrderId: scenario.order.id,
        items: [{ salesOrderItemId: scenario.item.id, qty: '1' }],
      });
      trail.push(first.id);
      await registerManual(api, first.id, series, correlative);

      const second = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: scenario.customer.id,
        salesOrderId: scenario.order.id,
        items: [{ salesOrderItemId: scenario.item.id, qty: '1' }],
      });
      trail.push(second.id);

      const refused = await postExpectingError(
        api,
        `/api/invoicing/documents/${second.id}/register-manual`,
        { series, correlative },
      );
      expect(refused.status).toBe(409);
      expect(refused.message).toContain(series);

      // El rechazo no dejó el segundo a medio registrar: sigue siendo un borrador.
      expect((await getDocument(api, second.id)).status).toBe('DRAFT');

      // Con otro correlativo entra sin problema: lo que se rechaza es el número, no el modo.
      const ok = await registerManual(api, second.id, series, correlative + 1);
      expect(ok.status).toBe('ACCEPTED');
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

  test('el kardex es el mismo con o sin comprobante: lo mueve el despacho, no el modo', async () => {
    const scenario = await setupOrderScenario(api, { coilKg: '1000' });
    const trail: string[] = [];

    try {
      // El saldo del producto antes de facturar nada. Se lee con `optionalBalanceOf` porque
      // puede no haber **ninguna** fila de saldo todavía: este producto se fabrica desde la
      // bobina y no existe en el kardex hasta que algo lo mueva. Que siga sin existir después
      // de registrar el comprobante es justamente lo que el caso quiere probar.
      const before = await optionalBalanceOf(api, 'PRODUCT', scenario.product.id);

      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: scenario.customer.id,
        salesOrderId: scenario.order.id,
        items: [{ salesOrderItemId: scenario.item.id, qty: '2' }],
      });
      trail.push(draft.id);
      await registerManual(api, draft.id, manualSeries(), manualCorrelative());

      // **El comprobante no movió un gramo**, y no porque el modo manual lo evite: porque
      // ningún comprobante mueve kardex. La salida es del despacho (D-074).
      const after = await optionalBalanceOf(api, 'PRODUCT', scenario.product.id);
      expect(after?.qty ?? null).toBe(before?.qty ?? null);
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

  test('un manual con un cobro vigente no se anula hasta revertir el cobro', async () => {
    const scenario = await setupOrderScenario(api);
    const trail: string[] = [];

    try {
      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: scenario.customer.id,
        salesOrderId: scenario.order.id,
        items: [{ salesOrderItemId: scenario.item.id, qty: '2' }],
      });
      trail.push(draft.id);
      const registered = await registerManual(api, draft.id, manualSeries(), manualCorrelative());

      // Con un cobro vigente encima, la anulación se frena: el dinero recibido quedaría sin
      // causa. Es el mismo guardrail que la baja ante SUNAT.
      await addPayment(api, registered.id, { amountPen: '10.00' });
      const blocked = await annulImported(api, registered.id, 'Prueba E2E con cobro');
      expect(blocked.status()).toBe(400);
      expect(await blocked.text()).toContain('cobros vigentes');
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

  test('un manual mal registrado se anula por dentro y su deuda desaparece', async () => {
    const scenario = await setupOrderScenario(api);
    const trail: string[] = [];

    try {
      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: scenario.customer.id,
        salesOrderId: scenario.order.id,
        items: [{ salesOrderItemId: scenario.item.id, qty: '2' }],
      });
      trail.push(draft.id);
      const registered = await registerManual(api, draft.id, manualSeries(), manualCorrelative());
      expect(registered.balancePen).toBe(registered.totalPen);

      // **La reversa del manual, de verdad.** Es la mitad que el `CHECK` de la base prohibía
      // hasta esta sesión: `fiscal_documents_annulled_origin_ck` reservaba `ANNULLED` a lo
      // importado, así que un manual mal registrado era deuda falsa permanente.
      const annulled = await annulImported(api, registered.id, 'Registrado por error (prueba E2E)');
      expect(annulled.ok(), await annulled.text()).toBe(true);

      const after = await getDocument(api, registered.id);
      expect(after.status).toBe('ANNULLED');
      expect(after.balancePen).toBe('0.0000');
      expect(after.annulledAt).not.toBeNull();

      // Idempotente (D-052): el segundo intento no vuelve a anular ni finge que hizo algo.
      const again = await annulImported(api, registered.id, 'Segundo intento (prueba E2E)');
      expect(again.status()).toBe(409);
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

  test('un manual registrado no tiene ningún camino al PSE', async () => {
    const scenario = await setupOrderScenario(api);
    const trail: string[] = [];

    try {
      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: scenario.customer.id,
        salesOrderId: scenario.order.id,
        items: [{ salesOrderItemId: scenario.item.id, qty: '2' }],
      });
      trail.push(draft.id);
      const manual = await registerManual(api, draft.id, manualSeries(), manualCorrelative());

      // Las cuatro puertas al PSE, cerradas. Es el caso que hace que la próxima refactorización
      // que vuelva estas guardas a `!== IMPORTED` se ponga roja en vez de mandar a Nubefact un
      // comprobante que la otra app ya declaró — o sea, dos veces la misma venta ante SUNAT.
      for (const action of ['send', 'retry', 'refresh']) {
        const refused = await api.post(`/api/invoicing/documents/${manual.id}/${action}`);
        expect(refused.ok(), `${action} no debería aceptar un manual`).toBe(false);
      }
      const voided = await api.post(`/api/invoicing/documents/${manual.id}/void`, {
        data: { reason: 'Intento de baja sobre un manual (prueba E2E)' },
      });
      expect(voided.ok(), 'la baja ante SUNAT no debería aceptar un manual').toBe(false);
      expect(await voided.text()).toContain('se registró como manual');

      // El barrido de pendientes queda **fuera de este test a propósito**, y la primera versión
      // se equivocó justamente ahí: `send-pending` es global —recorre hasta veinte documentos de
      // toda la base, no los de este escenario—, así que asertar `sent === 0` era pedirle a una
      // base compartida que estuviera vacía, y llamarlo mandaba al PSE demo comprobantes de otras
      // pruebas, quemando cupo de la cuenta (el límite de la Fase 5b) y moviéndoles el estado.
      //
      // Lo que sí se puede afirmar sin efectos es la mitad del filtro que vive en el dato: el
      // barrido toma `status ∈ RETRYABLE`, y un manual nace `ACCEPTED`, que no está en esa lista.
      // La otra mitad —`origin: ISSUED_HERE` en el `where` de `sendPending`— la sostienen las
      // cuatro puertas de arriba, que son las que un refactor a `!== IMPORTED` rompería.
      expect(
        ['ISSUED', 'SEND_ERROR'],
        'un manual nace fuera de los estados reintentables',
      ).not.toContain(manual.status);

      // Sigue como lo dejamos: el rechazo no lo movió de estado ni de origen.
      const after = await getDocument(api, manual.id);
      expect(after.status).toBe('ACCEPTED');
      expect(after.origin).toBe('MANUAL');
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

  test('el flujo electrónico sigue intacto: un borrador se emite y toma correlativo del ERP', async () => {
    const scenario = await setupOrderScenario(api);
    const trail: string[] = [];

    try {
      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: scenario.customer.id,
        salesOrderId: scenario.order.id,
        items: [{ salesOrderItemId: scenario.item.id, qty: '1' }],
      });
      trail.push(draft.id);

      const seriesBefore = await getJson<SeriesRow[]>(api, '/api/invoicing/series');
      const sent = await postJson<FiscalDocumentDto>(
        api,
        `/api/invoicing/documents/${draft.id}/send`,
      );

      // Sigue siendo del ERP y sigue tomando número de la serie propia — que es justo lo que
      // el modo manual no hace.
      expect(sent.origin).toBe('ISSUED_HERE');
      expect(sent.number).not.toBeNull();
      const seriesAfter = await getJson<SeriesRow[]>(api, '/api/invoicing/series');
      const moved = seriesAfter.filter((a) => {
        const b = seriesBefore.find((s) => s.id === a.id);
        return b !== undefined && a.correlative > b.correlative;
      });
      expect(moved, 'emitir tiene que adelantar exactamente una serie').toHaveLength(1);

      // Y no admite el otro terminal: ya dejó de ser un borrador.
      const refused = await postExpectingError(
        api,
        `/api/invoicing/documents/${draft.id}/register-manual`,
        { series: manualSeries(), correlative: manualCorrelative() },
      );
      expect(refused.status).toBe(409);
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
