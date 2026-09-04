import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getJson } from '../helpers/api';
import { balanceOf, live, movementsOf, postExpectingError } from '../helpers/production';
import { availabilityOf, type SalesOrderDto } from '../helpers/sales';
import {
  addPayment,
  fiscalEmissionAllowed,
  FISCAL_EMISSION_REASON,
  dispatchBody,
  createAndSend,
  createCreditNote,
  createInvoice,
  createInvoiceableCustomer,
  dispatchOrder,
  expectNotRejected,
  freeLine,
  genericCustomer,
  getDispatch,
  getDocument,
  invoiceBody,
  issueDispatchNote,
  orderProgress,
  probePse,
  purgeInvoicingTrail,
  reversePayment,
  sendDocument,
  settleWithPse,
  setupOrderScenario,
  voidDocument,
  type InvoicingTrail,
  type PseProbe,
} from '../helpers/invoicing';

/**
 * Fase 5b — el pedido de 5a sale del almacén, se factura y se cobra (D-070..D-078).
 *
 * En una línea: **despachar mueve kardex y cierra el pedido, facturar toma correlativo y
 * crea la deuda, cobrar la apaga**, y los tres relojes corren por separado (D-074).
 *
 * Todo por API, como el resto de la suite, y cada test deshace lo que crea en un `finally`
 * siguiendo el mismo orden que `pnpm prod:purge-e2e`: cobros → notas de crédito →
 * comprobantes → guías → despachos → pedido → bobina → compra.
 *
 * **Sobre los tests que dependen de una aceptación del PSE**: cobrar, acreditar y bloquear
 * la reversa de un despacho solo ocurren sobre un comprobante `ACCEPTED`, y eso lo decide
 * la cuenta del PSE del entorno. `probePse` lo pregunta una vez por archivo; si el
 * proveedor no acepta, esos tests se **saltan con el motivo real escrito**, en vez de
 * fallar por algo que no es un defecto o —peor— de pasar sin haber probado nada.
 */

const allowWrites = process.env.E2E_ALLOW_WRITES === '1' || !process.env.E2E_BASE_URL;
/** Emitir gasta numeración fiscal real: apagado contra una URL externa (D-072). */
const fiscalEmission = fiscalEmissionAllowed();

/** Cada test arma su escenario, corre el ciclo y lo deshace: ~40 llamadas contra Neon. */
test.describe.configure({ timeout: 240_000 });

test.describe('Fase 5b — despacho, comprobante y cobranza', () => {
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
    await api.dispose();
  });

  // -------------------------------------------------------------------------
  // 1. El despacho: kardex, reserva y estado del pedido — **sin emitir nada**
  // -------------------------------------------------------------------------

  /**
   * Va separado del que emite a propósito. Sacar la mercadería no gasta numeración fiscal,
   * así que este test corre en **cualquier** entorno —incluida una producción sin PSE—, que
   * es justo donde más importa saber que el almacén funciona.
   */
  test('despachar el pedido mueve el kardex, consume la reserva y lo deja atendido', async () => {
    const sc = await setupOrderScenario(api, {
      coilKg: '1000',
      qty: '100',
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
      // Antes de despachar: todo pendiente, y el disponible ya descuenta la promesa (D-066).
      const before = await orderProgress(api, sc.order.id);
      expect(before.lines[0]).toMatchObject({
        qty: '100.000',
        dispatchedQty: '0.000',
        pendingDispatchQty: '100.000',
        invoicedQty: '0.000',
        pendingInvoiceQty: '100.000',
        itemType: 'COIL',
        itemId: sc.coil.id,
      });
      expect(await availabilityOf(api, 'COIL', sc.coil.id)).toMatchObject({
        qty: '1000.000',
        reservedQty: '100.000',
        availableQty: '900.000',
      });

      // RF-77: la mercadería sale. Una salida de kardex por línea, por el módulo
      // `inventory` (regla dura 2), y por los kilos que la reserva prometía.
      const dispatch = await dispatchOrder(api, {
        salesOrderId: sc.order.id,
        items: [{ salesOrderItemId: sc.item.id, qty: '100' }],
      });
      trail.dispatchIds!.push(dispatch.id);
      expect(dispatch.code).toMatch(/^DES-\d{6}$/);
      expect(dispatch.status).toBe('ISSUED');
      expect(dispatch.items).toHaveLength(1);
      expect(dispatch.items[0]).toMatchObject({
        salesOrderItemId: sc.item.id,
        qty: '100.000',
        unit: 'KGM',
        reserveQty: '100.000',
        weightKg: '100.000',
        itemType: 'COIL',
        itemId: sc.coil.id,
      });

      // El kardex bajó y la reserva se consumió: el material ya no está prometido porque
      // ya salió (D-074).
      expect(await balanceOf(api, 'COIL', sc.coil.id)).toMatchObject({ qty: '900.000' });
      expect(await availabilityOf(api, 'COIL', sc.coil.id)).toMatchObject({
        qty: '900.000',
        reservedQty: '0.000',
        availableQty: '900.000',
      });
      const movements = live(await movementsOf(api, 'COIL', sc.coil.id));
      expect(movements).toHaveLength(2);
      expect(movements[1]).toMatchObject({ type: 'OUT', qty: '100.000', refType: 'SALE' });

      // D-074: atender el pedido es un hecho del almacén. El despacho total lo cierra.
      const fulfilled = await getJson<SalesOrderDto>(api, `/api/sales/orders/${sc.order.id}`);
      expect(fulfilled.status).toBe('FULFILLED');
      expect(fulfilled.reservations[0]).toMatchObject({ status: 'CONSUMED', qty: '0.000' });

      // Y el progreso del pedido lo dice: nada pendiente de despachar, todo de facturar.
      const afterDispatch = await orderProgress(api, sc.order.id);
      expect(afterDispatch.lines[0]).toMatchObject({
        dispatchedQty: '100.000',
        pendingDispatchQty: '0.000',
        invoicedQty: '0.000',
        pendingInvoiceQty: '100.000',
      });
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 1.b El papel del despacho: guía y factura — **emite**
  // -------------------------------------------------------------------------

  test('el despacho habilita la guía y la factura del pedido, cada una con su correlativo', async () => {
    test.skip(!fiscalEmission, FISCAL_EMISSION_REASON);

    const sc = await setupOrderScenario(api, {
      coilKg: '1000',
      qty: '100',
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

      // RF-78: la guía del despacho. Toma correlativo de su propia serie (D-072) y queda
      // colgada del despacho, no del pedido.
      const note = await issueDispatchNote(api, dispatch.id);
      trail.documentIds!.push(note.id);
      expect(note.docType).toBe('GUIA_REMISION_REMITENTE');
      expect(note.number, 'la guía toma correlativo al emitirse (D-072)').toMatch(/^T001-\d{8}$/);
      expect(note.dispatchId).toBe(dispatch.id);
      expect(note.status).not.toBe('DRAFT');

      // El despacho muestra su guía **vigente**, y solo admite una a la vez (D-078). Una
      // rechazada conserva su correlativo pero no declaró nada, así que no es la vigente
      // ni bloquea emitir la siguiente.
      const withNote = await getDispatch(api, dispatch.id);
      if (note.status === 'REJECTED') {
        expect(withNote.dispatchNoteNumber).toBeNull();
      } else {
        expect(withNote.dispatchNoteNumber).toBe(note.number);
        const twice = await postExpectingError(api, `/api/dispatches/${dispatch.id}/dispatch-note`);
        expect(twice.status).toBe(409);
        expect(twice.message).toContain('ya tiene la guía');
      }

      // Consultar la guía al PSE no la rompe: una guía que espera a SUNAT sigue esperando,
      // y una aceptada sigue aceptada. Es la consulta propia de la guía, no la de un
      // comprobante de pago, que era lo que antes no devolvía su estado.
      //
      // La **reconciliación** de una guía dada de baja no se prueba acá y no se simula: una
      // GRE no se puede anular por API (el PSE responde que el documento no existe), así
      // que hace falta que alguien la dé de baja en el panel del proveedor. Mientras eso no
      // ocurra, el caso queda sin cubrir y así se informa.
      const refreshed = await settleWithPse(api, note.id, { attempts: 1 });
      expectNotRejected(refreshed, 'la guía tras consultarla al PSE', pse);

      // Y mientras la guía esté vigente, la reversa del despacho está bloqueada y el
      // mensaje dice qué hacer: darla de baja primero.
      const blocked = await postExpectingError(api, `/api/dispatches/${dispatch.id}/reverse`, {
        reason: 'Intento con la guía vigente',
      });
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain(refreshed.number!);
      expect(blocked.message).toContain('baja');

      // RF-70: la factura del pedido. El borrador no toma número; enviarlo sí (D-072).
      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: sc.customer.id,
        salesOrderId: sc.order.id,
        items: [{ salesOrderItemId: sc.item.id, qty: '100' }],
      });
      trail.documentIds!.push(draft.id);
      expect(draft).toMatchObject({
        status: 'DRAFT',
        number: null,
        salesOrderId: sc.order.id,
        // Precio y descripción salen de la línea del pedido; IGV 18 % discriminado.
        subtotalPen: '800.0000',
        igvPen: '144.0000',
        totalPen: '944.0000',
      });
      expect(draft.items[0]).toMatchObject({
        qty: '100.000',
        unit: 'KGM',
        unitPricePen: '8.0000',
        salesOrderItemId: sc.item.id,
      });

      const sent = await sendDocument(api, draft.id);
      expect(sent.number, 'emitir toma correlativo de la serie de factura').toMatch(/^F001-\d{8}$/);
      expect(sent.status).not.toBe('DRAFT');
      expect(sent.issuedAt).not.toBeNull();

      // El comprobante no toca el estado del pedido (D-074): sigue atendido por el despacho.
      const afterInvoice = await getJson<SalesOrderDto>(api, `/api/sales/orders/${sc.order.id}`);
      expect(afterInvoice.status).toBe('FULFILLED');
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 2. El ciclo entero, hasta el saldo en cero
  // -------------------------------------------------------------------------

  test('el ciclo completo termina con la factura aceptada cobrada y el saldo en cero', async () => {
    test.skip(!fiscalEmission, FISCAL_EMISSION_REASON);
    test.skip(!pse.accepts, pse.reason);

    const sc = await setupOrderScenario(api, {
      coilKg: '1000',
      qty: '100',
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
      // La guía va por el camino **asíncrono** de SUNAT: el PSE la recibe sin veredicto y
      // el documento queda emitido, esperando. Lo que no puede es volver rechazada sin
      // motivo, que era el defecto que quemaba un correlativo por guía.
      const issuedNote = await issueDispatchNote(api, dispatch.id);
      trail.documentIds!.push(issuedNote.id);
      expect(issuedNote.number).toMatch(/^T001-\d{8}$/);
      expectNotRejected(issuedNote, 'la guía recién emitida', pse);

      const note = await settleWithPse(api, issuedNote.id);
      expectNotRejected(note, 'la guía tras consultar al PSE', pse);
      const withNote = await getDispatch(api, dispatch.id);
      expect(withNote.dispatchNoteNumber).toBe(note.number);
      expect(withNote.dispatchNoteStatus).toBe(note.status);

      const invoice = await createAndSend(api, {
        docType: 'FACTURA',
        customerId: sc.customer.id,
        salesOrderId: sc.order.id,
        items: [{ salesOrderItemId: sc.item.id, qty: '100' }],
      });
      trail.documentIds!.push(invoice.id);
      expect(invoice.status).toBe('ACCEPTED');
      expect(invoice.acceptedAt).not.toBeNull();
      expect(invoice.balancePen).toBe('944.0000');
      // Una factura aceptada hoy se deshace por comunicación de baja (D-072).
      expect(invoice.voidPath).toBe('VOID');

      // Facturado consume pedido: la línea ya no tiene nada pendiente de facturar.
      const progress = await orderProgress(api, sc.order.id);
      expect(progress.lines[0]).toMatchObject({
        invoicedQty: '100.000',
        pendingInvoiceQty: '0.000',
      });
      // Y no se puede facturar dos veces la misma línea.
      const again = await postExpectingError(
        api,
        '/api/invoicing/documents',
        invoiceBody({
          docType: 'FACTURA',
          customerId: sc.customer.id,
          salesOrderId: sc.order.id,
          items: [{ salesOrderItemId: sc.item.id, qty: '100' }],
        }),
      );
      expect(again.status).toBe(400);
      expect(again.message).toContain('por facturar');

      // RF-86: el cobro apaga el saldo.
      const paid = await addPayment(api, invoice.id, { amountPen: '944.0000' });
      expect(paid.paidPen).toBe('944.0000');
      expect(paid.balancePen).toBe('0.0000');
      expect(paid.payments).toHaveLength(1);

      // Y no se cobra de más sobre un saldo ya en cero.
      const excess = await postExpectingError(
        api,
        `/api/invoicing/documents/${invoice.id}/payments`,
        { date: paid.payments[0]!.date, amountPen: '1.0000', method: 'CASH' },
      );
      expect(excess.status).toBe(400);
      expect(excess.message).toContain('saldo');

      // RF-88: con saldo cero, el comprobante sale de la lista de pendientes. Se pregunta
      // **por el documento** y no por el cliente: el receptor de prueba es uno solo para
      // toda la suite (`E2E_CUSTOMER_RUC`), así que su total agregado no es de este test.
      const pending = await getJson<{ id: string }[]>(
        api,
        `/api/invoicing/documents?pendingOnly=true&customerId=${sc.customer.id}`,
      );
      expect(pending.find((d) => d.id === invoice.id)).toBeUndefined();

      // Y lo último, porque es lo que menos depende del resto: los archivos firmados que
      // devolvió el PSE quedan guardados en R2 (D-007) y se pueden descargar. Sin esto,
      // "aceptada" es una palabra sin respaldo: no hay PDF que mandarle al cliente ni CDR
      // que mostrar ante un requerimiento.
      const stored = await getDocument(api, invoice.id);
      expect({ pdf: stored.hasPdf, xml: stored.hasXml, cdr: stored.hasCdr }).toEqual({
        pdf: true,
        xml: true,
        cdr: true,
      });
      const pdf = await api.get(`/api/invoicing/documents/${invoice.id}/pdf`);
      expect(pdf.status(), 'el PDF del comprobante se descarga').toBe(200);
      expect(pdf.headers()['content-type']).toContain('pdf');
      expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');
      expect((await api.get(`/api/invoicing/documents/${invoice.id}/xml`)).status()).toBe(200);
      expect((await api.get(`/api/invoicing/documents/${invoice.id}/cdr`)).status()).toBe(200);
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 3. Nota de crédito parcial (RF-76)
  // -------------------------------------------------------------------------

  test('una nota de crédito parcial baja el saldo del comprobante en lo acreditado', async () => {
    test.skip(!fiscalEmission, FISCAL_EMISSION_REASON);
    test.skip(!pse.accepts, pse.reason);

    const customer = await createInvoiceableCustomer(api);
    const trail: InvoicingTrail = { documentIds: [] };

    try {
      const invoice = await createAndSend(api, {
        docType: 'FACTURA',
        customerId: customer.id,
        items: [freeLine('10', '100.0000', 'servicio de habilitado')],
      });
      trail.documentIds!.push(invoice.id);
      expect(invoice.status).toBe('ACCEPTED');
      expect(invoice.totalPen).toBe('1180.0000');

      // Acredita 4 de las 10 unidades: 400 + 72 de IGV.
      const note = await createCreditNote(api, invoice.id, {
        reason: 'DEVOLUCION_ITEM',
        items: [{ affectedItemId: invoice.items[0]!.id, qty: '4' }],
      });
      trail.documentIds!.unshift(note.id);
      expect(note).toMatchObject({
        docType: 'NOTA_CREDITO',
        status: 'DRAFT',
        affectedDocumentId: invoice.id,
        subtotalPen: '400.0000',
        totalPen: '472.0000',
      });

      const sentNote = await sendDocument(api, note.id);
      // La serie de la nota sale del tipo del comprobante afectado (D-072).
      expect(sentNote.number).toMatch(/^FC01-\d{8}$/);
      expect(sentNote.status).toBe('ACCEPTED');

      const afterNote = await getDocument(api, invoice.id);
      expect(afterNote.creditedPen).toBe('472.0000');
      expect(afterNote.balancePen).toBe('708.0000');
      expect(afterNote.items[0]!.creditedQty).toBe('4.000');
      expect(afterNote.creditNotes.map((n) => n.number)).toContain(sentNote.number);

      // Lo que queda por acreditar son 6: pedir 7 se corta con lo que sí queda.
      const tooMuch = await postExpectingError(
        api,
        `/api/invoicing/documents/${invoice.id}/credit-note`,
        {
          reason: 'DEVOLUCION_ITEM',
          issueDate: invoice.issueDate,
          items: [{ affectedItemId: invoice.items[0]!.id, qty: '7' }],
        },
      );
      expect(tooMuch.status).toBe(400);
      expect(tooMuch.message).toContain('por acreditar');

      // Con el saldo ajustado, un cobro por el saldo restante lo deja en cero.
      const paid = await addPayment(api, invoice.id, { amountPen: '708.0000' });
      expect(paid.balancePen).toBe('0.0000');
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 3.b Comunicación de baja (RF-75, D-072)
  // -------------------------------------------------------------------------

  /**
   * La baja es el otro camino para deshacer un comprobante aceptado, y el que solo existe
   * dentro del plazo (D-072). Sus dos guardrails son los que evitan que el saldo del
   * cliente y el papel digan cosas distintas: no se da de baja algo que ya se cobró ni algo
   * que ya se acreditó.
   */
  test('una factura aceptada se da de baja, pero no con un cobro vigente ni con una nota de crédito viva', async () => {
    test.skip(!fiscalEmission, FISCAL_EMISSION_REASON);
    test.skip(!pse.accepts, pse.reason);

    const customer = await createInvoiceableCustomer(api);
    const trail: InvoicingTrail = { documentIds: [] };

    try {
      const invoice = await createAndSend(api, {
        docType: 'FACTURA',
        customerId: customer.id,
        items: [freeLine('2', '50.0000', 'servicio que se da de baja')],
      });
      trail.documentIds!.push(invoice.id);
      expect(invoice.status).toBe('ACCEPTED');
      expect(invoice.totalPen).toBe('118.0000');
      // Emitida hoy, el camino que corresponde es la baja y no la nota de crédito.
      expect(invoice.voidPath).toBe('VOID');

      // Guardrail 1: con un cobro vigente, la baja se detiene.
      const paid = await addPayment(api, invoice.id, { amountPen: '118.0000' });
      const blockedByPayment = await postExpectingError(
        api,
        `/api/invoicing/documents/${invoice.id}/void`,
        { reason: 'Intento con el cobro vigente' },
      );
      expect(blockedByPayment.status).toBe(400);
      expect(blockedByPayment.message).toContain('cobros vigentes');

      // Revertido el cobro, la baja entra. Con un reintento si hace falta: SUNAT presenta
      // las bajas en un archivo por día y el segundo intento del día choca contra el
      // primero. No es un fallo del sistema, es cómo funciona la comunicación de baja.
      await reversePayment(api, invoice.id, paid.payments[0]!.id, 'Para poder dar de baja');
      const voided = await voidDocument(api, invoice.id, 'Baja de prueba E2E dentro del plazo');
      expect(voided.ok, `la baja no entró: ${voided.lastError}`).toBe(true);

      // `VOID_PENDING` es una baja en trámite: SUNAT todavía no confirmó y una consulta la
      // resuelve. Marcarla anulada antes sería declarar por SUNAT algo que no dijo.
      if ((await getDocument(api, invoice.id)).status === 'VOID_PENDING') {
        const refreshed = await api.post(`/api/invoicing/documents/${invoice.id}/refresh`);
        expect(refreshed.ok(), await refreshed.text()).toBe(true);
      }
      const finalDocument = await getDocument(api, invoice.id);
      expect(['VOIDED', 'VOID_PENDING']).toContain(finalDocument.status);
      if (finalDocument.status === 'VOIDED') {
        expect(finalDocument.voidedAt).not.toBeNull();
        // Un comprobante dado por no emitido no debe nada.
        expect(finalDocument.balancePen).toBe('0.0000');
        // Y no se da de baja dos veces.
        const twice = await postExpectingError(api, `/api/invoicing/documents/${invoice.id}/void`, {
          reason: 'Segundo intento',
        });
        expect(twice.status).toBe(409);
      }

      // Guardrail 2: con una nota de crédito viva, el saldo ya está ajustado y la baja
      // sobra. Va sobre otro comprobante porque el primero ya no está vigente.
      const other = await createAndSend(api, {
        docType: 'FACTURA',
        customerId: customer.id,
        items: [freeLine('2', '50.0000', 'servicio acreditado y no dado de baja')],
      });
      trail.documentIds!.push(other.id);
      expect(other.status).toBe('ACCEPTED');
      const note = await createCreditNote(api, other.id, { reason: 'ANULACION_OPERACION' });
      trail.documentIds!.unshift(note.id);
      const sentNote = await sendDocument(api, note.id);
      expect(sentNote.status).toBe('ACCEPTED');

      const blockedByNote = await postExpectingError(
        api,
        `/api/invoicing/documents/${other.id}/void`,
        { reason: 'Intento con la nota de crédito viva' },
      );
      expect(blockedByNote.status).toBe(400);
      expect(blockedByNote.message).toContain('nota de crédito');
      // La nota total dejó el saldo en cero: no hay nada más que deshacer.
      expect((await getDocument(api, other.id)).balancePen).toBe('0.0000');

      // Y la propia nota de crédito **sí tiene salida dentro del plazo** (D-072): era el
      // caso sin camino, el que dejaba una nota viva para siempre.
      expect(sentNote.voidPath, 'una nota de crédito recién emitida se da de baja').toBe('VOID');
      const voidedNote = await voidDocument(api, sentNote.id, 'Baja de la nota de crédito');
      expect(voidedNote.ok, `la baja de la nota no entró: ${voidedNote.lastError}`).toBe(true);
      expect(['VOIDED', 'VOID_PENDING']).toContain((await getDocument(api, sentNote.id)).status);
      // Pasado el plazo el camino sería `NONE`, y **eso no se puede provocar desde el
      // API**: la fecha de emisión admite como mucho siete días de atraso
      // (`MAX_BACKDATED_ISSUE_DAYS`) y la ventana de baja es de siete días también, así que
      // ninguna emisión posible cae fuera. No se finge acá: lo cubre la prueba unitaria de
      // `voidPathFor`, que es donde se puede mover el calendario.
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 4. Despacho parcial (RF-77, D-074)
  // -------------------------------------------------------------------------

  test('despachar la mitad deja el pedido parcialmente atendido y el resto sigue reservado', async () => {
    const sc = await setupOrderScenario(api, {
      coilKg: '1000',
      qty: '100',
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
      const half = await dispatchOrder(api, {
        salesOrderId: sc.order.id,
        items: [{ salesOrderItemId: sc.item.id, qty: '50' }],
      });
      trail.dispatchIds!.push(half.id);

      const partial = await getJson<SalesOrderDto>(api, `/api/sales/orders/${sc.order.id}`);
      expect(partial.status).toBe('PARTIALLY_FULFILLED');

      // **Lo que más importa de un despacho parcial**: la reserva se consume solo por lo
      // que salió, y el resto sigue protegido. El disponible no se mueve —bajan a la vez
      // el físico y lo reservado—, que es exactamente lo que promete D-074.
      expect(partial.reservations[0]).toMatchObject({ status: 'ACTIVE', qty: '50.000' });
      expect(await availabilityOf(api, 'COIL', sc.coil.id)).toMatchObject({
        qty: '950.000',
        reservedQty: '50.000',
        availableQty: '900.000',
      });

      const progress = await orderProgress(api, sc.order.id);
      expect(progress.lines[0]).toMatchObject({
        dispatchedQty: '50.000',
        pendingDispatchQty: '50.000',
      });

      // Más de lo pendiente no sale.
      const tooMuch = await postExpectingError(
        api,
        '/api/dispatches',
        dispatchBody({
          salesOrderId: sc.order.id,
          items: [{ salesOrderItemId: sc.item.id, qty: '60' }],
          totalWeightKg: '60',
        }),
      );
      expect(tooMuch.status).toBe(400);
      expect(tooMuch.message).toContain('por despachar');

      // El resto cierra el pedido.
      const rest = await dispatchOrder(api, {
        salesOrderId: sc.order.id,
        items: [{ salesOrderItemId: sc.item.id, qty: '50' }],
      });
      trail.dispatchIds!.push(rest.id);

      const done = await getJson<SalesOrderDto>(api, `/api/sales/orders/${sc.order.id}`);
      expect(done.status).toBe('FULFILLED');
      expect(done.reservations[0]).toMatchObject({ status: 'CONSUMED', qty: '0.000' });
      expect(await availabilityOf(api, 'COIL', sc.coil.id)).toMatchObject({
        qty: '900.000',
        reservedQty: '0.000',
        availableQty: '900.000',
      });
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 5. Boleta a "público en general" (RF-89, D-077)
  // -------------------------------------------------------------------------

  /**
   * Los topes de D-077 se comprueban **sobre el borrador**, antes de gastar correlativo, así
   * que este test no emite y corre en cualquier entorno. La boleta que sí sale va aparte.
   */
  test('el tope de la boleta a público en general se aplica sobre el borrador', async () => {
    const generic = await genericCustomer(api);
    const trail: InvoicingTrail = { documentIds: [] };

    try {
      // Por encima del tope el bloqueo es **suave y en el borrador**: se detiene antes de
      // gastar un correlativo (D-072/D-077).
      const overCap = await postExpectingError(
        api,
        '/api/invoicing/documents',
        invoiceBody({
          docType: 'BOLETA',
          customerId: generic.id,
          items: [freeLine('10', '100.0000', 'venta de mostrador grande')],
        }),
      );
      expect(overCap.status).toBe(400);
      expect(overCap.message).toContain('700');
      expect(overCap.message).toContain('identifica al cliente');

      // Al cliente del sistema tampoco se le emite una factura: no tiene RUC.
      const asInvoice = await postExpectingError(
        api,
        '/api/invoicing/documents',
        invoiceBody({
          docType: 'FACTURA',
          customerId: generic.id,
          items: [freeLine('1', '10.0000', 'intento de factura')],
        }),
      );
      expect(asInvoice.status).toBe(400);
      expect(asInvoice.message).toContain('boletas');

      // La excepción existe, es de ADMINISTRADOR y **queda escrita en el comprobante**.
      const forced = await createInvoice(api, {
        docType: 'BOLETA',
        customerId: generic.id,
        items: [freeLine('10', '100.0000', 'venta de mostrador forzada')],
        notes: 'E2E boleta forzada por encima del tope',
        forceGenericCustomer: true,
      });
      trail.documentIds!.push(forced.id);
      expect(forced.totalPen).toBe('1180.0000');
      expect(
        forced.genericCustomerOverrideByName,
        'D-077: forzar el tope queda registrado en el propio comprobante',
      ).not.toBeNull();
      // Se queda en borrador: forzar el tope es la excepción, no el escenario de esta
      // prueba, y emitirla gastaría un correlativo sin comprobar nada nuevo.
      expect(forced.number).toBeNull();
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 5.b La boleta que sí sale — **emite**
  // -------------------------------------------------------------------------

  test('la boleta a público en general por debajo del tope sale con su correlativo', async () => {
    test.skip(!fiscalEmission, FISCAL_EMISSION_REASON);

    const generic = await genericCustomer(api);
    const trail: InvoicingTrail = { documentIds: [] };

    try {
      // Venta menor de mostrador: 590 soles, por debajo del tope de S/ 700 de SUNAT.
      const boleta = await createAndSend(api, {
        docType: 'BOLETA',
        customerId: generic.id,
        items: [freeLine('5', '100.0000', 'venta de mostrador')],
        // La boleta sale a nombre del cliente sembrado y no de un cliente de prueba: la
        // marca en observaciones es lo único por lo que la purga de producción la ve.
        notes: 'E2E boleta de venta menor de mostrador',
      });
      trail.documentIds!.push(boleta.id);
      expect(boleta.customerIsGeneric).toBe(true);
      expect(boleta.totalPen).toBe('590.0000');
      expect(boleta.number, 'la boleta toma correlativo de su serie').toMatch(/^B001-\d{8}$/);
      expect(boleta.genericCustomerOverrideByName).toBeNull();
      // La boleta se informa a SUNAT por resumen: sale emitida y esperando, no rechazada.
      expectNotRejected(boleta, 'la boleta al público en general', pse);
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });
});
