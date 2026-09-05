import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi } from '../helpers/api';
import { balanceOf } from '../helpers/production';
import {
  createInvoiceableCustomer,
  expectNotRejected,
  expectPendingWithNumber,
  fiscalEmissionAllowed,
  FISCAL_EMISSION_REASON,
  getDispatch,
  getDocument,
  probePse,
  setProviderOffline,
  settleWithPse,
  type PseProbe,
} from '../helpers/invoicing';
import {
  cashSession,
  cashSessionSales,
  closeSessionQuietly,
  openCashSession,
  posContext,
  posSell,
  posSellExpectingError,
  setupPosStock,
  voidPosSale,
  voidPosSaleExpectingError,
  type CashSessionDto,
} from '../helpers/pos';
import { availabilityOf, purgeSalesTrail } from '../helpers/sales';

/**
 * Fase 7b — punto de venta de mostrador (RF-60; D-098..D-104).
 *
 * Lo que estos tests protegen, en una línea: **el mostrador no es un camino paralelo**
 * (D-099). Cada aserción se hace sobre las tablas de siempre —pedido, despacho, kardex,
 * comprobante, cobro— y no sobre nada propio del POS: si el POS hubiera abierto su propio
 * camino de stock, ninguna de estas comprobaciones cerraría.
 *
 * **Todos emiten**, así que se saltan contra producción por D-081: cada venta de mostrador
 * gasta un correlativo de la serie real, y sin PSE no hay forma de darlo de baja. Los
 * escenarios que **no** emiten —los rechazos y la caja— viven en `fase7b-bordes.spec.ts` y
 * sí corren contra producción.
 */

const allowWrites = process.env.E2E_ALLOW_WRITES === '1' || !process.env.E2E_BASE_URL;
const fiscalEmission = fiscalEmissionAllowed();

test.describe.configure({ timeout: 240_000 });

test.describe('Fase 7b — venta de mostrador', () => {
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

  test('venta completa: público en general, efectivo, y los cuatro documentos nacen juntos', async () => {
    test.skip(!fiscalEmission, FISCAL_EMISSION_REASON);
    const stock = await setupPosStock(api, { qty: '40', listPricePen: '10.0000' });
    let session: CashSessionDto | undefined;
    const orderIds: string[] = [];

    try {
      const before = await balanceOf(api, 'PRODUCT', stock.product.id);
      expect(before.qty).toBe('40.000');

      session = await openCashSession(api, '100.00');
      expect(session.status).toBe('OPEN');
      expect(session.expectedCashPen).toBe('100.0000');

      // 3 unidades a S/ 10 = S/ 30 + IGV = S/ 35.40. Debajo del tope de la boleta genérica.
      const sale = await posSell(api, {
        items: [{ productId: stock.product.id, qty: '3.000', unitPricePen: '10.0000' }],
      });
      orderIds.push(sale.salesOrderId);

      expect(sale.status).toBe('ACTIVE');
      expect(sale.totalPen).toBe('35.4000');
      expect(sale.method).toBe('CASH');
      // Sin cliente identificado, boleta al sembrado de D-077.
      const context = await posContext(api);
      expect(sale.customerName).toBe(context.genericCustomerName);

      // 1. El comprobante existe, tomó número y es una **boleta** (D-077).
      const document = await getDocument(api, sale.fiscalDocumentId);
      expect(document.docType).toBe('BOLETA');
      expect(document.number).not.toBeNull();
      expect(document.salesOrderId).toBe(sale.salesOrderId);
      expect(document.totalPen).toBe('35.4000');
      expectNotRejected(await settleWithPse(api, document.id), 'la boleta del mostrador', pse);

      // 2. La cobranza: el comprobante nace saldado, porque el mostrador es contado.
      const settled = await getDocument(api, sale.fiscalDocumentId);
      expect(settled.payments).toHaveLength(1);
      expect(settled.payments[0]).toMatchObject({ method: 'CASH', amountPen: '35.4000' });
      expect(settled.balancePen).toBe('0.0000');

      // 3. El despacho: recojo en mostrador, sin transporte y sin guía (D-103).
      const dispatch = await getDispatch(api, sale.dispatchId);
      expect(dispatch.status).toBe('ISSUED');
      expect(dispatch.transferMode).toBe('PICKUP');
      expect(dispatch.salesOrderId).toBe(sale.salesOrderId);

      // 4. El kardex descontó, y la reserva quedó consumida y no colgando: el disponible
      //    vuelve a ser el saldo entero, que es la forma de decir "no quedó nada prometido".
      const after = await availabilityOf(api, 'PRODUCT', stock.product.id);
      expect(after).toMatchObject({
        qty: '37.000',
        reservedQty: '0.000',
        availableQty: '37.000',
      });

      // 5. La caja suma: el turno muestra la venta y el efectivo esperado sube.
      const live = await cashSession(api, session.id);
      expect(live.saleCount).toBe(1);
      expect(live.expectedCashPen).toBe('135.4000');
      const cashTotal = live.totals.find((t) => t.method === 'CASH');
      expect(cashTotal).toMatchObject({ saleCount: 1, totalPen: '35.4000' });

      const sales = await cashSessionSales(api, session.id);
      expect(sales.map((s) => s.id)).toContain(sale.id);
    } finally {
      await closeSessionQuietly(api, session?.id);
      await purgeSalesTrail(api, { orderIds });
    }
  });

  test('con RUC se emite factura, y el cliente identificado no tiene tope', async () => {
    test.skip(!fiscalEmission, FISCAL_EMISSION_REASON);
    const stock = await setupPosStock(api, { qty: '40', listPricePen: '100.0000' });
    const customer = await createInvoiceableCustomer(api);
    let session: CashSessionDto | undefined;
    const orderIds: string[] = [];

    try {
      session = await openCashSession(api, '0.00');

      // S/ 1 180 con IGV: muy por encima del tope de la boleta genérica (D-077), que no
      // aplica porque el cliente está identificado.
      const sale = await posSell(api, {
        customerId: customer.id,
        method: 'CARD',
        reference: 'VISA ****4242',
        items: [{ productId: stock.product.id, qty: '10.000', unitPricePen: '100.0000' }],
      });
      orderIds.push(sale.salesOrderId);

      expect(sale.totalPen).toBe('1180.0000');
      expect(sale.customerName).toBe(customer.name);

      const document = await getDocument(api, sale.fiscalDocumentId);
      expect(document.docType).toBe('FACTURA');
      expect(document.customerName).toBe(customer.name);
      expectNotRejected(await settleWithPse(api, document.id), 'la factura del mostrador', pse);

      // Tarjeta: se cobra igual pero **no entra al arqueo** (D-101).
      const live = await cashSession(api, session.id);
      expect(live.expectedCashPen).toBe('0.0000');
      expect(live.totals.find((t) => t.method === 'CARD')).toMatchObject({
        saleCount: 1,
        totalPen: '1180.0000',
      });
    } finally {
      await closeSessionQuietly(api, session?.id);
      await purgeSalesTrail(api, { orderIds });
    }
  });

  test('el tope de la boleta genérica se levanta identificando al cliente (D-077)', async () => {
    test.skip(!fiscalEmission, FISCAL_EMISSION_REASON);
    const stock = await setupPosStock(api, { qty: '40', listPricePen: '100.0000' });
    const customer = await createInvoiceableCustomer(api);
    let session: CashSessionDto | undefined;
    const orderIds: string[] = [];

    try {
      session = await openCashSession(api, '0.00');
      const cart = [{ productId: stock.product.id, qty: '8.000', unitPricePen: '100.0000' }];

      // S/ 944 sin identificar: bloqueo suave. **Y no gasta correlativo**: el tope se
      // comprueba al crear el borrador, antes de tomar número (D-072).
      const blocked = await posSellExpectingError(api, { items: cart });
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain('público en general');

      // El mismo carrito, con cliente: sale sin discutir.
      const sale = await posSell(api, { customerId: customer.id, items: cart });
      orderIds.push(sale.salesOrderId);
      expect(sale.totalPen).toBe('944.0000');

      const document = await getDocument(api, sale.fiscalDocumentId);
      expect(document.docType).toBe('FACTURA');
      expect(document.genericCustomerOverrideByName).toBeNull();
      expectNotRejected(await settleWithPse(api, document.id), 'la factura tras el tope', pse);
    } finally {
      await closeSessionQuietly(api, session?.id);
      await purgeSalesTrail(api, { orderIds });
    }
  });

  test('con el PSE caído la venta sale igual y el comprobante queda pendiente (D-073)', async () => {
    test.skip(!fiscalEmission, FISCAL_EMISSION_REASON);
    const stock = await setupPosStock(api, { qty: '40', listPricePen: '10.0000' });
    let session: CashSessionDto | undefined;
    let offline = false;
    const orderIds: string[] = [];

    try {
      session = await openCashSession(api, '0.00');
      await setProviderOffline(api, true);
      offline = true;

      const context = await posContext(api);
      // La pantalla lo sabe antes de cobrar (D-102): es el aviso que ve el vendedor.
      expect(context.providerOffline).toBe(true);

      const sale = await posSell(api, {
        items: [{ productId: stock.product.id, qty: '2.000', unitPricePen: '10.0000' }],
      });
      orderIds.push(sale.salesOrderId);

      // La venta está cerrada de punta a punta: la mercadería salió y el dinero entró.
      expect(sale.status).toBe('ACTIVE');
      expect(sale.fiscalPending).toBe(true);
      const after = await balanceOf(api, 'PRODUCT', stock.product.id);
      expect(after.qty).toBe('38.000');

      const document = await getDocument(api, sale.fiscalDocumentId);
      expectPendingWithNumber(document, 'la boleta del mostrador con el PSE caído');
      expect(document.balancePen).toBe('0.0000');

      const live = await cashSession(api, session.id);
      expect(live.saleCount).toBe(1);
    } finally {
      if (offline) await setProviderOffline(api, false).catch(() => undefined);
      await closeSessionQuietly(api, session?.id);
      await purgeSalesTrail(api, { orderIds });
    }
  });

  test('anular la venta del turno encadena las reversas y devuelve stock y caja (D-100)', async () => {
    test.skip(!fiscalEmission, FISCAL_EMISSION_REASON);
    const stock = await setupPosStock(api, { qty: '40', listPricePen: '10.0000' });
    let session: CashSessionDto | undefined;
    const orderIds: string[] = [];

    try {
      session = await openCashSession(api, '50.00');
      const sale = await posSell(api, {
        items: [{ productId: stock.product.id, qty: '5.000', unitPricePen: '10.0000' }],
      });
      orderIds.push(sale.salesOrderId);
      expect(sale.totalPen).toBe('59.0000');

      const afterSale = await cashSession(api, session.id);
      expect(afterSale.expectedCashPen).toBe('109.0000');
      expect((await balanceOf(api, 'PRODUCT', stock.product.id)).qty).toBe('35.000');

      // Anular exige un comprobante **aceptado**: ni la baja ni la nota de crédito existen
      // sobre uno que el PSE todavía no resolvió (D-100). Sin aceptación se comprueba que el
      // API lo dice con claridad, y el resto del escenario se salta con su motivo.
      const settledDoc = await waitForAcceptance(api, sale.fiscalDocumentId);
      if (settledDoc.status !== 'ACCEPTED') {
        const refused = await voidPosSaleExpectingError(api, sale.id);
        expect(refused.status).toBe(400);
        expect(refused.message).toContain('no fue aceptado');
        test.skip(
          true,
          `El comprobante quedó en ${settledDoc.status}: sin aceptación del PSE no hay baja ni ` +
            'nota de crédito que emitir, y la cadena de reversas no puede empezar (D-100). ' +
            'El rechazo con mensaje sí quedó comprobado.',
        );
        return;
      }

      const voided = await voidPosSale(api, sale.id);
      expect(voided.status).toBe('VOIDED');
      expect(voided.voidReason).not.toBeNull();

      // 1. El cobro revertido.
      const document = await getDocument(api, sale.fiscalDocumentId);
      expect(document.payments[0]?.reversedAt).not.toBeNull();

      // 2. El despacho revertido y el stock de vuelta.
      const dispatch = await getDispatch(api, sale.dispatchId);
      expect(dispatch.status).toBe('REVERSED');
      // Y sin reserva colgando: el pedido anulado libera lo que quedaba prometido.
      const restored = await availabilityOf(api, 'PRODUCT', stock.product.id);
      expect(restored).toMatchObject({
        qty: '40.000',
        reservedQty: '0.000',
        availableQty: '40.000',
      });

      // 3. La caja vuelve a su esperado de antes de la venta.
      const afterVoid = await cashSession(api, session.id);
      expect(afterVoid.expectedCashPen).toBe('50.0000');
      expect(afterVoid.saleCount).toBe(0);
      expect(afterVoid.voidedCount).toBe(1);
    } finally {
      await closeSessionQuietly(api, session?.id);
      await purgeSalesTrail(api, { orderIds });
    }
  });
});

/**
 * Espera a que el PSE acepte el comprobante, **con pausa entre consultas**.
 *
 * Una boleta va por el camino asíncrono de SUNAT (resumen diario): el PSE la recibe y
 * contesta sin veredicto, así que el documento se queda `ISSUED` y hay que volver a
 * preguntar. `settleWithPse` consulta tres veces seguidas sin esperar nada entre medias, que
 * contra un servicio real es preguntar tres veces lo mismo en el mismo segundo. Acá se le da
 * tiempo de verdad, porque de esta aceptación depende el único escenario que puede ejercitar
 * la cadena de reversas completa (D-100).
 */
async function waitForAcceptance(
  api: APIRequestContext,
  documentId: string,
): Promise<Awaited<ReturnType<typeof getDocument>>> {
  let document = await getDocument(api, documentId);
  for (let i = 0; i < 12 && document.status !== 'ACCEPTED'; i += 1) {
    if (document.status === 'REJECTED' || document.status === 'VOIDED') break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await api.post(`/api/invoicing/documents/${documentId}/refresh`).catch(() => undefined);
    document = await getDocument(api, documentId);
  }
  return document;
}
