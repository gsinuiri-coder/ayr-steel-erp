import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getItems, postJson } from '../helpers/api';
import {
  createInvoice,
  dispatchOrder,
  invoiceBody,
  purgeInvoicingTrail,
  setupOrderScenario,
  type FiscalDocumentDto,
  type InvoicingTrail,
  type OrderScenario,
} from '../helpers/invoicing';

/**
 * F8-S7/M3 — al facturar se **declara** qué despacho cubre el comprobante (D-213).
 *
 * `POST /invoicing/documents` acepta `dispatchId` opcional y con él escribe
 * `dispatches.invoice_id`, que antes solo poblaba el mostrador. El enlace se declara y
 * **nunca se infiere**: un pedido puede tener varios despachos parciales y varias facturas
 * parciales, y en auditoría un link falso pesa más que un guion.
 *
 * Lo que estos casos protegen:
 *
 * - **Que el camino feliz responda 201 y no 500.** Es el caso que existe por un defecto
 *   real: una versión anterior escribía `dispatchId` en `fiscal_documents`, donde esa
 *   columna significa «esta **guía de remisión** es del despacho X» y el CHECK
 *   `fiscal_documents_shape_ck` la exige nula en todo lo que no sea una GRE. Emitir con
 *   despacho declarado reventaba con un 500 de base. El enlace vive del otro lado, en
 *   `dispatches.invoice_id`.
 * - **Que el despacho declarado sea del pedido que se factura** (400): con un uuid mal
 *   copiado el enlace apuntaría al despacho de otro cliente.
 * - **Que un despacho ya cubierto por un comprobante vivo no se vuelva a declarar** (409).
 * - **Que facturar sin declarar nada siga funcionando igual que siempre.** El campo es
 *   opcional y el flujo anterior a M3 no se toca.
 *
 * Ningún caso llega al PSE: el comprobante «vivo» del 409 se consigue registrando el papel
 * como manual (D-153), que nace `ACCEPTED` sin salir a Nubefact.
 *
 * Todos escriben (pedidos, despachos, comprobantes): nunca contra producción (regla dura 9,
 * D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea pedidos, despachos y comprobantes: nunca contra producción (D-126, regla dura 9).',
);

test.describe.configure({ timeout: 240_000 });

/** Kilos que cada caso despacha y factura, sobre una bobina que tiene de sobra. */
const DISPATCHED_KG = '100';

/**
 * Fila del listado de despachos con el enlace de D-213. Vive acá porque `DispatchDto` de
 * `helpers/invoicing.ts` todavía no declara estos tres campos y ningún otro spec los mira.
 */
interface DispatchRow {
  id: string;
  salesOrderId: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
}

async function dispatchesOfOrder(
  api: APIRequestContext,
  salesOrderId: string,
): Promise<DispatchRow[]> {
  return getItems<DispatchRow>(api, `/api/dispatches?salesOrderId=${salesOrderId}`);
}

async function dispatchRow(
  api: APIRequestContext,
  salesOrderId: string,
  dispatchId: string,
): Promise<DispatchRow> {
  const row = (await dispatchesOfOrder(api, salesOrderId)).find((d) => d.id === dispatchId);
  expect(row, `el despacho ${dispatchId} tiene que estar en el listado del pedido`).toBeDefined();
  return row!;
}

/** El cuerpo que manda el web, con el despacho declarado. */
function invoiceWithDispatch(
  scenario: OrderScenario,
  dispatchId?: string,
): Record<string, unknown> {
  return {
    ...invoiceBody({
      docType: 'FACTURA',
      customerId: scenario.customer.id,
      salesOrderId: scenario.order.id,
      items: [{ salesOrderItemId: scenario.item.id, qty: DISPATCHED_KG }],
    }),
    ...(dispatchId === undefined ? {} : { dispatchId }),
  };
}

function trailOf(scenario: OrderScenario): InvoicingTrail {
  return {
    documentIds: [],
    dispatchIds: [],
    orderIds: [scenario.order.id],
    coilIds: [scenario.coil.id],
    purchaseId: scenario.purchaseId,
    supplierId: scenario.supplier.id,
    finish: scenario.finish,
    productIds: [scenario.product.id],
  };
}

/**
 * Cierra los comprobantes del rastro **antes** de purgar: descarta los borradores y anula por
 * dentro los manuales (D-153/D-110).
 *
 * `purgeInvoicingTrail` deja los borradores en pie e intenta la baja ante SUNAT del resto;
 * cuando falla —un manual no la admite— cae en emitir una nota de crédito real contra la
 * cuenta demo de Nubefact. Acá no hace falta gastar cupo: la reversa propia de un manual es
 * la anulación interna, y un borrador simplemente se descarta (RF-70).
 * Nunca lanza: es limpieza de `finally`.
 */
async function settleDocuments(api: APIRequestContext, documentIds: string[]): Promise<void> {
  const reason = 'Limpieza de prueba E2E';
  for (const id of documentIds) {
    const document = await api
      .get(`/api/invoicing/documents/${id}`)
      .then((r) => (r.ok() ? (r.json() as Promise<FiscalDocumentDto>) : null))
      .catch(() => null);
    if (!document) continue;
    if (document.status === 'DRAFT') {
      await api.delete(`/api/invoicing/documents/${id}`).catch(() => undefined);
      continue;
    }
    if (document.origin !== 'MANUAL') continue;
    await api
      .post(`/api/invoicing/documents/${id}/annul`, { data: { reason } })
      .catch(() => undefined);
  }
}

test.describe('D-213 — el despacho que cubre el comprobante se declara al facturar', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('facturar declarando el despacho responde 201 y deja el despacho enlazado al comprobante', async () => {
    const scenario = await setupOrderScenario(api);
    const trail = trailOf(scenario);

    try {
      const dispatch = await dispatchOrder(api, {
        salesOrderId: scenario.order.id,
        items: [{ salesOrderItemId: scenario.item.id, qty: DISPATCHED_KG }],
      });
      trail.dispatchIds!.push(dispatch.id);

      // Antes de facturar el despacho no declara ningún comprobante: `null` no es "sin
      // facturar", es "no enlazado", y es lo que tiene todo despacho anterior a M3.
      expect(await dispatchRow(api, scenario.order.id, dispatch.id)).toMatchObject({
        invoiceId: null,
        invoiceStatus: null,
      });

      // **El caso que existe por el defecto**: con `dispatchId` esto devolvía 500 porque el
      // enlace se escribía en `fiscal_documents.dispatch_id`, que el CHECK de la base reserva
      // para las guías de remisión.
      const res = await api.post('/api/invoicing/documents', {
        data: invoiceWithDispatch(scenario, dispatch.id),
      });
      expect(res.status(), await res.text()).toBe(201);
      const invoice = (await res.json()) as FiscalDocumentDto;
      trail.documentIds!.push(invoice.id);
      expect(invoice.status).toBe('DRAFT');

      // El enlace quedó del lado del despacho, que es la pregunta "qué comprobante cubre esta
      // salida". Del lado del comprobante, `dispatchId` sigue siendo nulo a propósito: ahí
      // significa otra cosa —"esta GRE es del despacho X"— y una factura no es una guía.
      expect(invoice.dispatchId, 'una factura nunca se hace pasar por la guía del despacho').toBe(
        null,
      );

      const linked = await dispatchRow(api, scenario.order.id, dispatch.id);
      expect(linked.invoiceId).toBe(invoice.id);
      expect(linked.invoiceStatus).toBe('DRAFT');
    } finally {
      await settleDocuments(api, trail.documentIds ?? []);
      await purgeInvoicingTrail(api, trail);
    }
  });

  test('el despacho de otro pedido no se puede declarar', async () => {
    const own = await setupOrderScenario(api);
    const other = await setupOrderScenario(api);
    const ownTrail = trailOf(own);
    const otherTrail = trailOf(other);

    try {
      const foreign = await dispatchOrder(api, {
        salesOrderId: other.order.id,
        items: [{ salesOrderItemId: other.item.id, qty: DISPATCHED_KG }],
      });
      otherTrail.dispatchIds!.push(foreign.id);

      const refused = await api.post('/api/invoicing/documents', {
        data: invoiceWithDispatch(own, foreign.id),
      });
      expect(refused.status()).toBe(400);
      expect(await refused.text()).toContain('no pertenece al pedido');

      // Una venta directa —sin pedido— tampoco puede adoptar el despacho de uno: es la misma
      // regla mirada desde el lado en el que no hay pedido con el cual comparar.
      const direct = await api.post('/api/invoicing/documents', {
        data: {
          ...invoiceBody({
            docType: 'FACTURA',
            customerId: own.customer.id,
            items: [{ description: 'E2E servicio', qty: '1', unit: 'NIU', unitPricePen: '10.00' }],
          }),
          dispatchId: foreign.id,
        },
      });
      expect(direct.status()).toBe(400);

      // Y el despacho ajeno quedó como estaba: ningún rechazo lo enlazó a medias.
      expect(await dispatchRow(api, other.order.id, foreign.id)).toMatchObject({
        invoiceId: null,
        invoiceStatus: null,
      });
    } finally {
      await settleDocuments(api, [
        ...(ownTrail.documentIds ?? []),
        ...(otherTrail.documentIds ?? []),
      ]);
      await purgeInvoicingTrail(api, ownTrail);
      await purgeInvoicingTrail(api, otherTrail);
    }
  });

  test('un despacho ya enlazado a un comprobante vivo no se vuelve a declarar', async () => {
    const scenario = await setupOrderScenario(api);
    const trail = trailOf(scenario);

    try {
      const dispatch = await dispatchOrder(api, {
        salesOrderId: scenario.order.id,
        items: [{ salesOrderItemId: scenario.item.id, qty: DISPATCHED_KG }],
      });
      trail.dispatchIds!.push(dispatch.id);

      const first = await postJson<FiscalDocumentDto>(
        api,
        '/api/invoicing/documents',
        invoiceWithDispatch(scenario, dispatch.id),
      );
      trail.documentIds!.push(first.id);

      // Se cierra como manual para que el comprobante quede **vivo** (`ACCEPTED`) sin pasar
      // por el PSE: un borrador todavía no ocupa el despacho, justamente porque el enlace se
      // toma antes de saber si ese comprobante va a existir de verdad.
      const series = `F9${String(Math.floor(Math.random() * 90) + 10)}`;
      const registered = await postJson<FiscalDocumentDto>(
        api,
        `/api/invoicing/documents/${first.id}/register-manual`,
        { series, correlative: Math.floor(Math.random() * 90_000) + 1_000 },
      );
      expect(registered.status).toBe('ACCEPTED');
      expect(await dispatchRow(api, scenario.order.id, dispatch.id)).toMatchObject({
        invoiceId: first.id,
        invoiceStatus: 'ACCEPTED',
      });

      const refused = await api.post('/api/invoicing/documents', {
        data: invoiceWithDispatch(scenario, dispatch.id),
      });
      expect(refused.status()).toBe(409);
      // El mensaje nombra al comprobante que lo ocupa: sin eso, quien factura no sabe si el
      // despacho ya se facturó o si copió mal el id.
      expect(await refused.text()).toContain(registered.number!);

      // El rechazo no le robó el enlace al primero.
      expect(await dispatchRow(api, scenario.order.id, dispatch.id)).toMatchObject({
        invoiceId: first.id,
      });
    } finally {
      await settleDocuments(api, trail.documentIds ?? []);
      await purgeInvoicingTrail(api, trail);
    }
  });

  test('facturar sin declarar despacho sigue funcionando y no enlaza nada', async () => {
    const scenario = await setupOrderScenario(api);
    const trail = trailOf(scenario);

    try {
      const dispatch = await dispatchOrder(api, {
        salesOrderId: scenario.order.id,
        items: [{ salesOrderItemId: scenario.item.id, qty: DISPATCHED_KG }],
      });
      trail.dispatchIds!.push(dispatch.id);

      // El flujo de siempre, sin el campo nuevo: `dispatchId` es opcional y lo que ya existía
      // no puede empezar a pedir un dato que nadie mandaba.
      const invoice = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: scenario.customer.id,
        salesOrderId: scenario.order.id,
        items: [{ salesOrderItemId: scenario.item.id, qty: DISPATCHED_KG }],
      });
      trail.documentIds!.push(invoice.id);
      expect(invoice.status).toBe('DRAFT');
      expect(invoice.totalPen).not.toBe('0.0000');

      // Sin declaración no hay enlace, y eso es lo correcto: inferirlo por ser el único
      // despacho sin facturar es exactamente lo que D-213 descartó por diseño.
      expect(await dispatchRow(api, scenario.order.id, dispatch.id)).toMatchObject({
        invoiceId: null,
        invoiceStatus: null,
      });
    } finally {
      await settleDocuments(api, trail.documentIds ?? []);
      await purgeInvoicingTrail(api, trail);
    }
  });

  test('un borrador descartado suelta el despacho y se puede volver a facturar', async () => {
    const scenario = await setupOrderScenario(api);
    const trail = trailOf(scenario);

    try {
      const dispatch = await dispatchOrder(api, {
        salesOrderId: scenario.order.id,
        items: [{ salesOrderItemId: scenario.item.id, qty: DISPATCHED_KG }],
      });
      trail.dispatchIds!.push(dispatch.id);

      const discarded = await postJson<FiscalDocumentDto>(
        api,
        '/api/invoicing/documents',
        invoiceWithDispatch(scenario, dispatch.id),
      );
      expect(await dispatchRow(api, scenario.order.id, dispatch.id)).toMatchObject({
        invoiceId: discarded.id,
      });

      // **El enlace se toma al crear el borrador, que es antes de saber si ese comprobante va
      // a existir.** Descartarlo (RF-70) tiene que devolver el despacho a la lista de los que
      // se pueden facturar; con `invoice_id !== null` a secas quedaba ocupado para siempre por
      // un comprobante que ya no existe.
      const dropped = await api.delete(`/api/invoicing/documents/${discarded.id}`);
      expect(dropped.ok(), await dropped.text()).toBe(true);
      expect(await dispatchRow(api, scenario.order.id, dispatch.id)).toMatchObject({
        invoiceId: null,
        invoiceStatus: null,
      });

      // Y el segundo intento entra: el despacho volvió a estar libre de verdad, no solo en la
      // pantalla.
      const retried = await api.post('/api/invoicing/documents', {
        data: invoiceWithDispatch(scenario, dispatch.id),
      });
      expect(retried.status(), await retried.text()).toBe(201);
      const invoice = (await retried.json()) as FiscalDocumentDto;
      trail.documentIds!.push(invoice.id);
      expect((await dispatchRow(api, scenario.order.id, dispatch.id)).invoiceId).toBe(invoice.id);
    } finally {
      await settleDocuments(api, trail.documentIds ?? []);
      await purgeInvoicingTrail(api, trail);
    }
  });
});
