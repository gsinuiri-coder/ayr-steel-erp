import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getItems, getJson, postJson } from '../helpers/api';
import { balanceOf, live, movementsOf, postExpectingError } from '../helpers/production';
import { availabilityOf, createDirectOrder, type SalesOrderDto } from '../helpers/sales';
import {
  addPayment,
  fiscalEmissionAllowed,
  FISCAL_EMISSION_REASON,
  createAndSend,
  createInvoiceableCustomer,
  createSeries,
  dispatchOrder,
  expectNotRejected,
  expectPendingWithNumber,
  freeLine,
  genericCustomer,
  getDispatch,
  getDocument,
  invalidRuc,
  invoicingSettings,
  issueDispatchNote,
  listSeries,
  orderProgress,
  probePse,
  purgeInvoicingTrail,
  reversePayment,
  sendDocument,
  sendPending,
  setProviderOffline,
  setSeriesActive,
  settleWithPse,
  setupOrderScenario,
  voidDocument,
  testSeriesCode,
  waitForStatus,
  DISPATCH_LINE,
  type FiscalDocumentDto,
  type FiscalSeriesDto,
  type InvoicingTrail,
  type PseProbe,
} from '../helpers/invoicing';

/**
 * Fase 5b — bordes, contingencia y reversas (RF-74..RF-79, RF-87; D-072..D-074).
 *
 * Lo que estos tests protegen es lo que la fase promete cuando **algo sale mal**: que un
 * rechazo del PSE no queme el correlativo de la corrección, que una caída del PSE no
 * detenga el camión, que deshacer un despacho devuelva el stock **y la promesa**, y que
 * ninguna de esas reversas pueda pasar por encima de un papel que SUNAT ya vio.
 *
 * Los que dependen de una aceptación del PSE se saltan con el motivo real (ver el
 * encabezado de `fase5b.spec.ts`).
 */

const allowWrites = process.env.E2E_ALLOW_WRITES === '1' || !process.env.E2E_BASE_URL;
/** Emitir gasta numeración fiscal real: apagado contra una URL externa (D-072). */
const fiscalEmission = fiscalEmissionAllowed();

test.describe.configure({ timeout: 240_000 });

test.describe('Fase 5b — bordes, contingencia y reversas', () => {
  test.skip(
    !allowWrites,
    'Escrituras contra producción deshabilitadas: exporta E2E_ALLOW_WRITES=1',
  );

  let api: APIRequestContext;
  let pse: PseProbe;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
    pse = await probePse(api);
  });

  test.afterAll(async () => {
    // Nunca dejar el entorno en contingencia: sería un interruptor global encendido por
    // un test, y todo lo que corriera después quedaría con error de envío.
    await setProviderOffline(api, false).catch(() => undefined);
    await api.dispose();
  });

  // -------------------------------------------------------------------------
  // 1. RF-74 — un rechazado conserva su número; la corrección toma uno nuevo
  // -------------------------------------------------------------------------

  /**
   * El rechazo se fuerza con un **RUC de forma válida y dígito verificador incorrecto**:
   * el PSE lo valida antes que nada y devuelve un 4xx, que es un rechazo terminal del
   * contenido del documento y no un error de transporte. Es la vía determinista, y por eso
   * el cliente se crea acá y no con el helper de clientes facturables.
   */
  test('un comprobante rechazado conserva su número y la corrección toma un correlativo nuevo', async () => {
    test.skip(!fiscalEmission, FISCAL_EMISSION_REASON);

    const customer = await createInvoiceableCustomer(api, { docNumber: invalidRuc() });
    const trail: InvoicingTrail = { documentIds: [] };

    try {
      const rejected = await createAndSend(api, {
        docType: 'FACTURA',
        customerId: customer.id,
        items: [freeLine('2', '60.0000', 'servicio rechazado a propósito')],
      });
      trail.documentIds!.push(rejected.id);

      test.skip(
        rejected.status !== 'REJECTED',
        `El PSE no rechazó el documento con RUC de dígito verificador inválido; quedó ${rejected.status} (${rejected.lastSendError ?? 'sin detalle'})`,
      );

      // El rechazado **conserva su número** (D-072): el intento existió y queda a la vista.
      expect(rejected.number).toMatch(/^F001-\d{8}$/);
      expect(rejected.rejectionMessage).not.toBeNull();
      expect(rejected.balancePen, 'un rechazado no debe nada').toBe('0.0000');

      // Y un rechazo es terminal: no se reemite sobre el mismo documento.
      const resend = await postExpectingError(api, `/api/invoicing/documents/${rejected.id}/send`);
      expect(resend.status).toBe(409);
      expect(resend.message).toContain('corrígelo');

      // RF-74: la corrección es un borrador nuevo que apunta al rechazado.
      const draft = await postJson<FiscalDocumentDto>(
        api,
        `/api/invoicing/documents/${rejected.id}/correct`,
      );
      trail.documentIds!.push(draft.id);
      expect(draft).toMatchObject({
        status: 'DRAFT',
        number: null,
        replacesDocumentId: rejected.id,
        replacesDocumentNumber: rejected.number,
        totalPen: rejected.totalPen,
      });
      expect(draft.items).toHaveLength(rejected.items.length);

      // Un rechazado se corrige una sola vez.
      const twice = await postExpectingError(
        api,
        `/api/invoicing/documents/${rejected.id}/correct`,
      );
      expect(twice.status).toBe(409);

      // Al enviarla, la corrección toma un correlativo **distinto**: el del rechazado no
      // se reutiliza nunca.
      const corrected = await sendDocument(api, draft.id);
      expect(corrected.number).toMatch(/^F001-\d{8}$/);
      expect(corrected.number).not.toBe(rejected.number);
      expect(Number(corrected.correlative)).toBeGreaterThan(Number(rejected.correlative));

      // Y el rechazado sigue tal cual, con su número y su motivo.
      const stillRejected = await getDocument(api, rejected.id);
      expect(stillRejected).toMatchObject({
        status: 'REJECTED',
        number: rejected.number,
        rejectionMessage: rejected.rejectionMessage,
      });
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 2. D-073 — el PSE se cae y la operación sigue
  // -------------------------------------------------------------------------

  test('con el PSE en contingencia el comprobante toma correlativo, el despacho sale igual y el barrido lo recupera @pse', async () => {
    test.skip(!fiscalEmission, FISCAL_EMISSION_REASON);

    // D-134: `setupOrderScenario` vende la bobina entera (RF-73); ya no hay `qty` de por
    // medio. El escenario compra exactamente los 100 kg que la factura y el despacho usan.
    const sc = await setupOrderScenario(api, {
      coilKg: '100',
      unitPricePen: '8.0000',
    });
    const trail: InvoicingTrail = {
      documentIds: [],
      dispatchIds: [],
      orderIds: [sc.order.id],
      coilIds: [sc.coil.id],
      purchaseId: sc.purchaseId,
      supplierId: sc.supplier.id,
      finish: sc.finish,
      productIds: [sc.product.id],
    };

    try {
      const offline = await setProviderOffline(api, true);
      expect(offline.providerOffline).toBe(true);

      // (a) El comprobante **toma correlativo igual**: el documento ya existe para la
      // empresa aunque el PSE no lo haya visto (D-073, fase 1).
      const invoice = await createAndSend(api, {
        docType: 'FACTURA',
        customerId: sc.customer.id,
        salesOrderId: sc.order.id,
        items: [{ salesOrderItemId: sc.item.id, qty: '100' }],
      });
      trail.documentIds!.push(invoice.id);
      expect(invoice.number).toMatch(/^F001-\d{8}$/);
      expect(invoice.issuedAt).not.toBeNull();

      // (b) Y queda pendiente de envío, con el motivo escrito y sin contar el intento:
      // un envío que nunca salió a la red no es un intento fallido.
      expect(['ISSUED', 'SEND_ERROR']).toContain(invoice.status);
      expect(invoice.lastSendError).toContain('contingencia');
      expect(invoice.sendAttempts).toBe(0);

      // Un comprobante con correlativo tomado ya consume pedido, esté enviado o no: sin
      // esto, justo durante la caída la misma línea se podría facturar dos veces.
      const progress = await orderProgress(api, sc.order.id);
      expect(progress.lines[0]).toMatchObject({
        invoicedQty: '100.000',
        pendingInvoiceQty: '0.000',
      });

      // (c) **El despacho se hace igual**: la mercadería no espera al PSE.
      const dispatch = await dispatchOrder(api, {
        salesOrderId: sc.order.id,
        items: [{ salesOrderItemId: sc.item.id, qty: '100' }],
      });
      trail.dispatchIds!.push(dispatch.id);
      expect(dispatch.status).toBe('ISSUED');
      expect(await balanceOf(api, 'COIL', sc.coil.id)).toMatchObject({ qty: '0.000' });
      const fulfilled = await getJson<SalesOrderDto>(api, `/api/sales/orders/${sc.order.id}`);
      expect(fulfilled.status).toBe('FULFILLED');

      // La guía también sale, con su correlativo y sin declarar todavía.
      const note = await issueDispatchNote(api, dispatch.id);
      trail.documentIds!.push(note.id);
      expect(note.number).toMatch(/^T001-\d{8}$/);
      expect(['ISSUED', 'SEND_ERROR']).toContain(note.status);

      // Durante la contingencia el barrido no sale a la red: no tiene sentido insistir.
      expect(await sendPending(api)).toEqual({ sent: 0 });

      // Se levanta la contingencia y el barrido recupera lo pendiente (D-073, la red).
      const back = await setProviderOffline(api, false);
      expect(back.providerOffline).toBe(false);
      const swept = await sendPending(api);
      expect(swept.sent).toBeGreaterThan(0);

      // **Solo se espera si hay a quién esperar.** Sin PSE, el documento se queda
      // pendiente por diseño y ningún barrido lo va a mover: insistir no cambia el
      // resultado y sí multiplica el trabajo, porque cada pasada reprocesa una cola que
      // sin proveedor solo crece. Es lo que agotaba el timeout del job en CI.
      const resolved = pse.providerConfigured
        ? await waitForStatus(api, invoice.id, ['ACCEPTED', 'REJECTED'], {
            attempts: 3,
            kick: () => sendPending(api),
          })
        : await getDocument(api, invoice.id);

      if (pse.providerConfigured) {
        // Con un PSE atado, el barrido saca al documento de la cola: deja de estar
        // pendiente de envío.
        expect(
          resolved.status,
          'tras el barrido el comprobante deja de estar pendiente de envío',
        ).not.toBe('SEND_ERROR');
        if (pse.accepts) {
          expect(resolved.status).toBe('ACCEPTED');
          expect(resolved.acceptedAt).not.toBeNull();
        }
      } else {
        // Sin PSE no hay a quién enviarlo: que siga pendiente **es lo diseñado** (D-073).
        // Lo que el barrido no puede hacer es empeorarlo —darlo por rechazado o por
        // aceptado sin que nadie lo haya visto— ni quitarle el número que ya tomó.
        expectPendingWithNumber(resolved, 'el comprobante emitido sin PSE');
        expect(resolved.number).toBe(invoice.number);
      }
    } finally {
      await setProviderOffline(api, false).catch(() => undefined);
      await purgeInvoicingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 2.b D-072 — "SUNAT todavía no la procesó" no es un rechazo
  // -------------------------------------------------------------------------

  /**
   * La regresión del defecto que quemaba un correlativo por boleta y por guía: el PSE
   * recibe el documento y contesta **sin veredicto** —ni código de respuesta, ni
   * descripción, ni errores— porque SUNAT lo procesa por resumen, en diferido. Leer eso
   * como rechazo lo daba por muerto con su número gastado.
   *
   * Lo que se exige acá es lo único que siempre vale: **no vuelve rechazado sin motivo**, y
   * la consulta posterior lo resuelve. Que después de varios intentos siga esperando no es
   * un fallo: SUNAT tarda lo que tarda, y el barrido lo sigue reintentando.
   */
  test('un comprobante que SUNAT todavía no procesó queda pendiente, no rechazado, y la consulta lo resuelve @pse', async () => {
    test.skip(!fiscalEmission, FISCAL_EMISSION_REASON);
    test.skip(!pse.accepts, pse.reason);

    const generic = await genericCustomer(api);
    const trail: InvoicingTrail = { documentIds: [] };

    try {
      const boleta = await createAndSend(api, {
        docType: 'BOLETA',
        customerId: generic.id,
        items: [freeLine('3', '20.0000', 'venta de mostrador pendiente de SUNAT')],
        notes: 'E2E boleta que espera el resumen de SUNAT',
      });
      trail.documentIds!.push(boleta.id);

      // Emitida: número tomado, y el veredicto todavía no está.
      expect(boleta.number).toMatch(/^B001-\d{8}$/);
      expect(boleta.issuedAt).not.toBeNull();
      expectNotRejected(boleta, 'la boleta recién emitida', pse);
      // Sin motivo no hay rechazo: ni código ni mensaje de rechazo.
      expect(boleta.rejectionCode).toBeNull();

      // Y la consulta al PSE la resuelve —o la deja esperando, que también es correcto—.
      const settled = await settleWithPse(api, boleta.id);
      expectNotRejected(settled, 'la boleta tras consultar al PSE', pse);
      if (settled.status === 'ACCEPTED') {
        expect(settled.acceptedAt).not.toBeNull();
      } else {
        // Sigue en camino —SUNAT tarda, o no hay PSE a quien preguntar— y el barrido la
        // recoge. En los dos casos conserva su número, que es lo que importa.
        expectPendingWithNumber(settled, 'la boleta tras consultar');
        console.log(
          `[informe] ${settled.number} sigue pendiente tras consultar (${settled.status}); no es un fallo`,
        );
      }
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });

  /**
   * La otra mitad, separada a propósito porque falla por un motivo distinto: **el barrido
   * no puede romper lo que viene a rescatar**.
   *
   * Un documento que ya llegó al PSE y espera a SUNAT no se reenvía: reenviarlo con la
   * misma serie y correlativo vuelve como duplicado, y un duplicado se lee como rechazo.
   * El resultado es que el barrido de D-073 mata el comprobante que existía para
   * rescatarlo, y su correlativo no se recupera.
   */
  test('el barrido no convierte en rechazado un comprobante que ya está en el PSE esperando a SUNAT @pse', async () => {
    test.skip(!fiscalEmission, FISCAL_EMISSION_REASON);
    test.skip(!pse.accepts, pse.reason);

    const generic = await genericCustomer(api);
    const trail: InvoicingTrail = { documentIds: [] };

    try {
      const boleta = await createAndSend(api, {
        docType: 'BOLETA',
        customerId: generic.id,
        items: [freeLine('2', '25.0000', 'venta de mostrador que pasa por el barrido')],
        notes: 'E2E boleta que pasa por el barrido',
      });
      trail.documentIds!.push(boleta.id);
      expectNotRejected(boleta, 'la boleta recién emitida', pse);

      await sendPending(api);
      const afterSweep = await getDocument(api, boleta.id);
      expectNotRejected(afterSweep, 'la boleta tras el barrido', pse);
      // Y sobre todo: **no por duplicado**. Ese era el síntoma exacto del defecto —el
      // barrido reemitía con el mismo correlativo y el PSE lo devolvía como repetido—, así
      // que se nombra el mensaje en vez de mirar el contador de intentos: una consulta
      // también suma intento, y confundir las dos cosas haría fallar el test por algo que
      // está bien.
      expect(afterSweep.rejectionMessage ?? '').not.toContain('ya existe');
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 3. RF-79 — revertir un despacho sin comprobante
  // -------------------------------------------------------------------------

  test('revertir un despacho sin comprobante devuelve el stock, la reserva y el estado del pedido', async () => {
    // D-134: el pedido base ya no reserva 100 kg de una bobina de 1000; vende la bobina
    // entera, así que la promesa del pedido pasa a ser 1000 kg completos.
    const sc = await setupOrderScenario(api, {
      coilKg: '1000',
      unitPricePen: '8.0000',
    });
    const trail: InvoicingTrail = {
      dispatchIds: [],
      orderIds: [sc.order.id],
      coilIds: [sc.coil.id],
      purchaseId: sc.purchaseId,
      supplierId: sc.supplier.id,
      finish: sc.finish,
      productIds: [sc.product.id],
    };

    try {
      const dispatch = await dispatchOrder(api, {
        salesOrderId: sc.order.id,
        items: [{ salesOrderItemId: sc.item.id, qty: '60' }],
      });
      trail.dispatchIds!.push(dispatch.id);
      expect(await balanceOf(api, 'COIL', sc.coil.id)).toMatchObject({ qty: '940.000' });

      const reversed = await api.post(`/api/dispatches/${dispatch.id}/reverse`, {
        data: { reason: 'Reversa de prueba E2E' },
      });
      expect(reversed.ok(), await reversed.text()).toBe(true);
      const detail = (await reversed.json()) as { status: string; reversedAt: string | null };
      expect(detail.status).toBe('REVERSED');
      expect(detail.reversedAt).not.toBeNull();

      // El stock vuelve por una reversa de kardex, nunca por un DELETE (§3.2).
      expect(await balanceOf(api, 'COIL', sc.coil.id)).toMatchObject({ qty: '1000.000' });
      const movements = await movementsOf(api, 'COIL', sc.coil.id);
      expect(movements.some((m) => m.reversalOfId !== null)).toBe(true);
      expect(live(movements)).toHaveLength(1);

      // Y la **promesa vuelve con el material** (D-074): si no, la primera merma se lleva
      // lo que el pedido sigue debiendo.
      const restored = await getJson<SalesOrderDto>(api, `/api/sales/orders/${sc.order.id}`);
      expect(restored.status).toBe('CONFIRMED');
      expect(restored.reservations[0]).toMatchObject({ status: 'ACTIVE', qty: '1000.000' });
      expect(await availabilityOf(api, 'COIL', sc.coil.id)).toMatchObject({
        qty: '1000.000',
        reservedQty: '1000.000',
        availableQty: '0.000',
      });

      // El progreso del pedido lo recalcula desde los despachos vigentes, no desde un
      // contador: un despacho revertido no consumió nada.
      const progress = await orderProgress(api, sc.order.id);
      expect(progress.lines[0]).toMatchObject({
        dispatchedQty: '0.000',
        pendingDispatchQty: '1000.000',
      });

      // Revertir dos veces no duplica la devolución.
      const twice = await postExpectingError(api, `/api/dispatches/${dispatch.id}/reverse`, {
        reason: 'Segundo intento',
      });
      expect(twice.status).toBe(409);
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 4. D-074 — un comprobante vigente bloquea la reversa
  // -------------------------------------------------------------------------

  test('una factura aceptada de esas líneas bloquea la reversa del despacho y la nombra @pse', async () => {
    test.skip(!fiscalEmission, FISCAL_EMISSION_REASON);
    test.skip(!pse.accepts, pse.reason);

    // D-134: el pedido base vende la bobina entera; se compra exactamente lo que se
    // despacha y factura, para que "todo" siga siendo 100.
    const sc = await setupOrderScenario(api, {
      coilKg: '100',
      unitPricePen: '8.0000',
    });
    const trail: InvoicingTrail = {
      documentIds: [],
      dispatchIds: [],
      orderIds: [sc.order.id],
      coilIds: [sc.coil.id],
      purchaseId: sc.purchaseId,
      supplierId: sc.supplier.id,
      finish: sc.finish,
      productIds: [sc.product.id],
    };

    try {
      const dispatch = await dispatchOrder(api, {
        salesOrderId: sc.order.id,
        items: [{ salesOrderItemId: sc.item.id, qty: '100' }],
      });
      trail.dispatchIds!.push(dispatch.id);

      const invoice = await createAndSend(api, {
        docType: 'FACTURA',
        customerId: sc.customer.id,
        salesOrderId: sc.order.id,
        items: [{ salesOrderItemId: sc.item.id, qty: '100' }],
      });
      trail.documentIds!.push(invoice.id);
      expect(invoice.status).toBe('ACCEPTED');

      // El detalle del despacho ya lo anuncia antes de intentarlo.
      const withDocument = await getDispatch(api, dispatch.id);
      expect(withDocument.blockingDocumentNumbers).toContain(invoice.number);

      const blocked = await postExpectingError(api, `/api/dispatches/${dispatch.id}/reverse`, {
        reason: 'Intento con la factura vigente',
      });
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain(invoice.number!);
      expect(blocked.message).toContain('nota de crédito');

      // Y el stock no se movió: el bloqueo corta antes de tocar el kardex.
      expect(await balanceOf(api, 'COIL', sc.coil.id)).toMatchObject({ qty: '0.000' });

      // La baja entra —con un reintento si SUNAT ya recibió hoy el archivo de bajas, que
      // es su forma de trabajar y no un fallo del sistema—.
      const voided = await voidDocument(api, invoice.id, 'Baja para deshacer el despacho');
      expect(voided.ok, `la baja no entró: ${voided.lastError}`).toBe(true);
      if (voided.attempts > 1) {
        console.log('[informe] la baja necesitó un reintento (archivo del día ya presentado)');
      }

      // La baja también es asíncrona: puede quedar **en trámite** hasta que SUNAT confirme.
      // Una consulta la resuelve si ya está; si sigue en trámite, el comprobante todavía
      // declara el traslado y **debe seguir bloqueando** la reversa, que es lo correcto.
      let afterVoid = await getDocument(api, invoice.id);
      expect(['VOIDED', 'VOID_PENDING']).toContain(afterVoid.status);
      if (afterVoid.status === 'VOID_PENDING') {
        await api.post(`/api/invoicing/documents/${invoice.id}/refresh`).catch(() => undefined);
        afterVoid = await getDocument(api, invoice.id);
      }

      const reverse = await api.post(`/api/dispatches/${dispatch.id}/reverse`, {
        data: { reason: 'Reversa tras dar de baja el comprobante' },
      });
      if (afterVoid.status === 'VOIDED') {
        expect(reverse.ok(), await reverse.text()).toBe(true);
        expect(await balanceOf(api, 'COIL', sc.coil.id)).toMatchObject({ qty: '100.000' });
      } else {
        // Baja en trámite: el papel sigue vivo ante SUNAT y el stock no vuelve todavía.
        expect(reverse.status()).toBe(400);
        expect(await balanceOf(api, 'COIL', sc.coil.id)).toMatchObject({ qty: '0.000' });
        console.log(
          `[informe] la baja de ${invoice.number} quedó en trámite; la reversa sigue bloqueada, que es lo correcto`,
        );
      }
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 4.b D-073/D-074 — la guía pendiente de envío también bloquea la reversa
  // -------------------------------------------------------------------------

  /**
   * El caso que la contingencia hace posible y que es el más fácil de dejar abierto: la
   * guía tomó correlativo, el camión salió con ella, y el PSE todavía no la vio. Revertir
   * el despacho ahí deja al job declarando, cuando el PSE vuelva, un traslado que ya no
   * existe. Un documento en `SEND_ERROR` declara tanto como uno emitido.
   */
  test('un despacho con la guía pendiente de envío no se puede revertir hasta resolverla', async () => {
    test.skip(!fiscalEmission, FISCAL_EMISSION_REASON);

    // D-134: el pedido base vende la bobina entera; se compra exactamente lo despachado.
    const sc = await setupOrderScenario(api, {
      coilKg: '100',
      unitPricePen: '8.0000',
    });
    const trail: InvoicingTrail = {
      documentIds: [],
      dispatchIds: [],
      orderIds: [sc.order.id],
      coilIds: [sc.coil.id],
      purchaseId: sc.purchaseId,
      supplierId: sc.supplier.id,
      finish: sc.finish,
      productIds: [sc.product.id],
    };

    try {
      await setProviderOffline(api, true);
      const dispatch = await dispatchOrder(api, {
        salesOrderId: sc.order.id,
        items: [{ salesOrderItemId: sc.item.id, qty: '100' }],
      });
      trail.dispatchIds!.push(dispatch.id);
      const note = await issueDispatchNote(api, dispatch.id);
      trail.documentIds!.push(note.id);
      expect(note.number).toMatch(/^T001-\d{8}$/);
      expect(['ISSUED', 'SEND_ERROR']).toContain(note.status);

      const blocked = await postExpectingError(api, `/api/dispatches/${dispatch.id}/reverse`, {
        reason: 'Intento con la guía todavía sin enviar',
      });
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain(note.number!);
      expect(blocked.message).toContain('baja');

      // Y el corte es antes de tocar el kardex: la mercadería sigue afuera.
      expect(await balanceOf(api, 'COIL', sc.coil.id)).toMatchObject({ qty: '0.000' });

      // Resuelta la guía, la reversa depende de lo que contestó el PSE: una guía rechazada
      // no declaró nada y deja de bloquear; una aceptada —o todavía en camino— sigue
      // bloqueando hasta darla de baja.
      await setProviderOffline(api, false);
      const resolved = await waitForStatus(api, note.id, ['ACCEPTED', 'REJECTED'], {
        attempts: 3,
        kick: () => sendPending(api),
      });
      if (resolved.status === 'REJECTED') {
        const now = await api.post(`/api/dispatches/${dispatch.id}/reverse`, {
          data: { reason: 'Reversa con la guía rechazada' },
        });
        expect(now.ok(), await now.text()).toBe(true);
        expect(await balanceOf(api, 'COIL', sc.coil.id)).toMatchObject({ qty: '100.000' });
      } else {
        const stillBlocked = await postExpectingError(
          api,
          `/api/dispatches/${dispatch.id}/reverse`,
          { reason: 'Intento con la guía aceptada' },
        );
        expect(stillBlocked.status).toBe(400);
        expect(stillBlocked.message).toContain(note.number!);
      }
    } finally {
      await setProviderOffline(api, false).catch(() => undefined);
      await purgeInvoicingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 5. RF-87 — la reversa de un cobro devuelve el saldo y no borra la fila
  // -------------------------------------------------------------------------

  /**
   * Corre **con el PSE en contingencia** y a propósito: un comprobante que tomó
   * correlativo ya es una deuda del cliente aunque el PSE todavía no lo haya visto
   * (D-073/D-075), así que la cobranza entera se puede probar sin depender de que un
   * tercero acepte. Que esto se pudiera hacer era la mitad de D-073 que faltaba.
   */
  test('un comprobante emitido en contingencia se cobra, y revertir el cobro devuelve el saldo', async () => {
    test.skip(!fiscalEmission, FISCAL_EMISSION_REASON);

    const customer = await createInvoiceableCustomer(api);
    const trail: InvoicingTrail = { documentIds: [] };

    try {
      await setProviderOffline(api, true);
      const invoice = await createAndSend(api, {
        docType: 'FACTURA',
        customerId: customer.id,
        items: [freeLine('10', '100.0000', 'servicio cobrado y revertido')],
      });
      trail.documentIds!.push(invoice.id);
      expect(invoice.number).toMatch(/^F001-\d{8}$/);
      expect(['ISSUED', 'SEND_ERROR']).toContain(invoice.status);
      expect(invoice.balancePen).toBe('1180.0000');

      const paid = await addPayment(api, invoice.id, {
        amountPen: '500.0000',
        method: 'TRANSFER',
        reference: 'E2E-OP-1234',
      });
      expect(paid.paidPen).toBe('500.0000');
      expect(paid.balancePen).toBe('680.0000');
      const payment = paid.payments[0]!;
      expect(payment.reversedAt).toBeNull();

      // RF-88: con saldo vivo, la deuda aparece en las cuentas por cobrar del cliente. Se
      // compara con `>=` porque el receptor de prueba es uno solo para toda la suite y su
      // total agregado puede incluir otros comprobantes.
      const receivables = await getItems<{ customerId: string; balancePen: string }>(
        api,
        '/api/invoicing/receivables',
      );
      const mine = receivables.find((r) => r.customerId === customer.id);
      expect(
        mine,
        'un comprobante emitido en contingencia ya es una cuenta por cobrar',
      ).toBeDefined();
      expect(Number(mine!.balancePen)).toBeGreaterThanOrEqual(680);

      const afterReverse = await reversePayment(api, invoice.id, payment.id);
      expect(afterReverse.paidPen).toBe('0.0000');
      expect(afterReverse.balancePen).toBe('1180.0000');
      // La fila sigue ahí, marcada y con quién la revirtió (patrón de M-2/D-061).
      expect(afterReverse.payments).toHaveLength(1);
      expect(afterReverse.payments[0]).toMatchObject({
        id: payment.id,
        amountPen: '500.0000',
        reference: 'E2E-OP-1234',
      });
      expect(afterReverse.payments[0]!.reversedAt).not.toBeNull();
      expect(afterReverse.payments[0]!.reversedByName).not.toBeNull();

      // Revertir dos veces el mismo cobro no devuelve el monto dos veces.
      const twice = await postExpectingError(
        api,
        `/api/invoicing/documents/${invoice.id}/payments/${payment.id}/reverse`,
        { reason: 'Segundo intento' },
      );
      expect(twice.status).toBe(409);

      // Y el saldo devuelto se puede volver a cobrar entero.
      const again = await addPayment(api, invoice.id, { amountPen: '1180.0000' });
      expect(again.balancePen).toBe('0.0000');
      expect(again.payments).toHaveLength(2);

      // La cobranza mira el saldo, no el estado del envío: cobrado del todo, el
      // comprobante sale de los pendientes aunque el PSE todavía no lo haya visto.
      const pending = await getItems<{ id: string }>(
        api,
        `/api/invoicing/documents?pendingOnly=true&customerId=${customer.id}`,
      );
      expect(pending.find((d) => d.id === invoice.id)).toBeUndefined();
    } finally {
      await setProviderOffline(api, false).catch(() => undefined);
      await purgeInvoicingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 6. D-066 — los guardrails de 5a siguen en pie después de despachar
  // -------------------------------------------------------------------------

  /**
   * **Una regla que D-134/D-116 dejó de existir, documentada en vez de sustituida.**
   *
   * La versión original probaba que dos pedidos podían sostener, a la vez, promesas
   * **parciales** sobre la misma bobina física (600 kg reservados de una de 1000, el resto
   * disponible para otro pedido) y que un tercero, al despachar de más, chocaba con una
   * invariante que nombraba a los dos pedidos dueños del material. Esa situación ya no se
   * puede construir: `reserveFromCoilId`/`reserveKg` desaparecieron (D-134) y el único
   * mecanismo que queda para reservar una bobina concreta es la venta de bobina entera
   * (RF-73, `saleCoilId`), que **siempre** toma el saldo vivo completo, nunca una fracción
   * (`resolveSaleCoils`, `apps/api/src/sales/sales-lines.ts`). Dos pedidos no pueden tener
   * cada uno una parte de la misma bobina: el primero se la lleva entera y al segundo ya no
   * le queda saldo que vender. La invariante de `dispatches` que nombraba "lo reservado por
   * otros pedidos sobre el mismo ítem" (RF-79/D-066) sigue en el código, pero con esta única
   * vía de reserva por bobina ya no hay forma de tener dos pedidos activos compitiendo por
   * kilos de una misma bobina: no se decidió que sobrara, es que el camino para llegar ahí
   * se cerró en otro punto (D-116). Toca al dueño decidir si ese tramo de `dispatches`
   * pasa a ser código muerto o si conviene dejarlo como defensa en profundidad.
   *
   * Lo que **sí** sigue siendo cierto y sigue mereciendo un test es la mitad que no dependía
   * de esa mecánica: una reserva de bobina entera, dispachada por partes, protege lo que
   * queda sin volverlo disponible; y una bobina con promesa viva no se puede volver a vender
   * mientras esa promesa exista — solo se libera y se le vende a otro cuando el primer
   * pedido la suelta.
   */
  test('la reserva de una bobina entera protege lo que falta despachar, y nadie más la puede comprar hasta que se libera', async () => {
    const sc = await setupOrderScenario(api, {
      coilKg: '1000',
      unitPricePen: '8.0000',
    });
    const trail: InvoicingTrail = {
      dispatchIds: [],
      orderIds: [sc.order.id],
      coilIds: [sc.coil.id],
      purchaseId: sc.purchaseId,
      supplierId: sc.supplier.id,
      finish: sc.finish,
      productIds: [sc.product.id],
    };

    try {
      // (1) Despacho parcial del pedido A: salen 300 de los 1000 prometidos (venta de
      // bobina entera, D-116). Lo que queda sin despachar sigue tan reservado como antes:
      // el disponible no sube porque bajaron a la vez el físico y lo prometido.
      const partial = await dispatchOrder(api, {
        salesOrderId: sc.order.id,
        items: [{ salesOrderItemId: sc.item.id, qty: '300' }],
      });
      trail.dispatchIds!.push(partial.id);
      expect(await availabilityOf(api, 'COIL', sc.coil.id)).toMatchObject({
        qty: '700.000',
        reservedQty: '700.000',
        availableQty: '0.000',
      });

      // (2) Con la promesa de A todavía viva, nadie más puede comprar esta bobina: el saldo
      // vendible es exactamente cero, y el mensaje lo dice por su código.
      const cannotResell = await postExpectingError(api, '/api/sales/orders', {
        customerId: sc.customer.id,
        businessLine: DISPATCH_LINE,
        issueDate: partial.dispatchDate,
        items: [{ saleCoilId: sc.coil.id, qty: '700', unitPricePen: '8.0000' }],
      });
      expect(cannotResell.status).toBe(400);
      expect(cannotResell.message).toContain(sc.coil.code);
      expect(cannotResell.message).toContain('saldo disponible');

      // (3) A libera lo que le queda (D-054) y recién ahí la bobina vuelve a ser vendible…
      const released = await api.post(
        `/api/sales/reservations/${sc.order.reservations[0]!.id}/release`,
        { data: { reason: 'El cliente pidió postergar el resto de la entrega' } },
      );
      expect(released.ok(), await released.text()).toBe(true);
      // Liberar una reserva no anula el pedido (D-054: es una liberación manual, no una
      // reversa de todo el pedido): sigue con el estado que ya tenía por el despacho
      // parcial, solo que ya sin nada que respalde lo que falta.
      const restored = await getJson<SalesOrderDto>(api, `/api/sales/orders/${sc.order.id}`);
      expect(restored.status).toBe('PARTIALLY_FULFILLED');
      expect(restored.reservations[0]!.status).toBe('RELEASED');

      const orderB = await createDirectOrder(api, {
        customerId: sc.customer.id,
        businessLine: DISPATCH_LINE,
        items: [{ saleCoilId: sc.coil.id, qty: '700', unitPricePen: '8.0000' }],
      });
      trail.orderIds!.push(orderB.id);
      expect(orderB.reservations[0]).toMatchObject({
        status: 'ACTIVE',
        itemType: 'COIL',
        itemId: sc.coil.id,
        qty: '700.000',
      });

      // …y A, que ya soltó su promesa, no puede volver a despachar lo que le quedaba.
      const cannotDispatch = await postExpectingError(api, '/api/dispatches', {
        salesOrderId: sc.order.id,
        dispatchDate: partial.dispatchDate,
        originAddress: 'Av. Almacén 100, Lima',
        destinationAddress: 'Av. Cliente 200, Lima',
        originUbigeo: '150101',
        destinationUbigeo: '150132',
        transferMode: 'PUBLIC',
        totalWeightKg: '700',
        carrierDocNumber: '20100000001',
        carrierName: 'E2E Transportes',
        items: [{ salesOrderItemId: sc.item.id, qty: '700' }],
      });
      // La reserva propia de A ya está RELEASED (consumirla es un no-op silencioso, D-054),
      // así que quien de verdad corta acá es la invariante por ítem del kardex
      // (`assertReservationInvariant`, D-066): sacar 700 kg físicos dejaría el saldo en 0
      // con 700 kg todavía prometidos a B, y el mensaje lo nombra.
      expect(cannotDispatch.status).toBe(400);
      expect(cannotDispatch.message).toContain('reservad');
      expect(cannotDispatch.message).toContain(orderB.code);

      // Y B sí puede despachar lo suyo: el material es entero suyo ahora.
      const dispatchB = await dispatchOrder(api, {
        salesOrderId: orderB.id,
        items: [{ salesOrderItemId: orderB.items[0]!.id, qty: '700' }],
      });
      trail.dispatchIds!.push(dispatchB.id);
      expect(await balanceOf(api, 'COIL', sc.coil.id)).toMatchObject({ qty: '0.000' });
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 7. Configuración del módulo (D-073)
  // -------------------------------------------------------------------------

  test('la configuración del PSE dice qué proveedor está atado y si está en contingencia', async () => {
    const settings = await invoicingSettings(api);
    expect(settings.alertAfterHours).toBeGreaterThan(0);
    expect(typeof settings.providerConfigured).toBe('boolean');
    expect(settings.providerName.length).toBeGreaterThan(0);
    // Va al final del archivo a propósito: el interruptor de contingencia es **global**, y
    // el test que lo levanta tiene que haberlo bajado. Si esto falla, el entorno quedó en
    // contingencia y todo lo que corra después se va a llenar de errores de envío.
    expect(settings.providerOffline, 'ningún test puede dejar el PSE en contingencia').toBe(false);
    // El barrido y la alerta existen y contestan aunque no haya nada pendiente.
    const alerts = await getJson<{ pending: number; stalled: number }>(
      api,
      '/api/invoicing/alerts',
    );
    expect(alerts.pending).toBeGreaterThanOrEqual(0);
    expect(alerts.stalled).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // 8. D-072 — las series del punto de emisión son administrables
  // -------------------------------------------------------------------------

  /**
   * Solo el **comportamiento del endpoint**: crear una serie desactiva la anterior de la
   * misma combinación, y volver a activar la anterior deshace el cambio.
   *
   * **No se emite nada contra la serie de prueba**: la autorización es del PSE por emisor,
   * y cada intento contra una serie que la cuenta no tiene registrada quema un correlativo
   * que no se recupera. Por eso el escenario usa la combinación `NOTA_CREDITO`/`BOLETA`,
   * que ningún otro test de la suite emite.
   *
   * Va detrás de la misma compuerta que las emisiones aunque no emita: toca el **maestro
   * fiscal**, y una corrida que se caiga entre el alta y la restauración deja la serie
   * activa de notas de crédito sobre boleta apuntando a una de prueba. En una base de
   * pruebas es un rato; en producción es la numeración de la empresa.
   */
  test('crear una serie desactiva la anterior del mismo tipo y volver a activarla lo deshace', async () => {
    test.skip(!fiscalEmission, FISCAL_EMISSION_REASON);

    const before = await listSeries(api);
    const previous = before.find(
      (s) => s.docType === 'NOTA_CREDITO' && s.affectedDocType === 'BOLETA' && s.isActive,
    );
    expect(previous, 'la migración siembra BC01 para notas de crédito sobre boleta').toBeDefined();

    let created: FiscalSeriesDto | null = null;
    try {
      created = await createSeries(api, {
        docType: 'NOTA_CREDITO',
        series: testSeriesCode(),
        affectedDocType: 'BOLETA',
        correlative: 0,
      });
      expect(created).toMatchObject({ isActive: true, correlative: 0 });

      const afterCreate = await listSeries(api);
      expect(
        afterCreate.find((s) => s.id === previous!.id)!.isActive,
        'una sola serie activa por tipo: la anterior queda inactiva',
      ).toBe(false);
      // Y el correlativo de la anterior no se toca: es historia fiscal.
      expect(afterCreate.find((s) => s.id === previous!.id)!.correlative).toBe(
        previous!.correlative,
      );

      // Una serie de nota de crédito sin decir a qué tipo afecta no se admite.
      const invalid = await postExpectingError(api, '/api/invoicing/series', {
        docType: 'NOTA_CREDITO',
        series: testSeriesCode(),
      });
      expect(invalid.status).toBe(400);
    } finally {
      // Dejar el maestro como estaba: reactivar la sembrada apaga la de prueba.
      if (created) await setSeriesActive(api, previous!.id, true).catch(() => undefined);
    }

    const restored = await listSeries(api);
    expect(restored.find((s) => s.id === previous!.id)!.isActive).toBe(true);
    expect(restored.find((s) => s.id === created!.id)!.isActive).toBe(false);
  });
});
