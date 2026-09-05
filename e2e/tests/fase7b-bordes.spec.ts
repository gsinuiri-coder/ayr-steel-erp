import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, postJson } from '../helpers/api';
import { balanceOf } from '../helpers/production';
import {
  cashSession,
  closeCashSession,
  closeSessionQuietly,
  openCashSession,
  posContext,
  posProducts,
  posSellExpectingError,
  setupMeasuredStock,
  setupPosStock,
  POS_LINE,
  type CashSessionDto,
} from '../helpers/pos';
import { reservationsOf } from '../helpers/roofing';
import {
  availabilityOf,
  createCustomer,
  createDirectOrder,
  purgeSalesTrail,
} from '../helpers/sales';

/**
 * Fase 7b — bordes del mostrador: lo que **no** se puede hacer, y la caja.
 *
 * Ninguno de estos escenarios emite un comprobante: los rechazos se cortan antes de tomar
 * correlativo (D-072) y la caja no toca el módulo fiscal en absoluto. Por eso esta suite
 * **sí corre contra producción** con D-081 activo, que es donde tiene más valor: prueba el
 * módulo nuevo sobre la base real sin gastar numeración fiscal ni dejar un documento que
 * después no habría cómo dar de baja.
 */

const allowWrites = process.env.E2E_ALLOW_WRITES === '1' || !process.env.E2E_BASE_URL;

test.describe.configure({ timeout: 240_000 });

test.describe('Fase 7b — bordes del mostrador y caja', () => {
  test.skip(
    !allowWrites,
    'Escrituras contra producción deshabilitadas: exporta E2E_ALLOW_WRITES=1',
  );

  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('sin caja abierta no se vende, y no se abren dos turnos a la vez (D-101)', async () => {
    const stock = await setupPosStock(api, { qty: '10' });
    let session: CashSessionDto | undefined;

    try {
      // Sin turno: el mostrador no cobra a ninguna caja.
      const before = await posContext(api);
      expect(before.session).toBeNull();
      const refused = await posSellExpectingError(api, {
        items: [{ productId: stock.product.id, qty: '1.000' }],
      });
      expect(refused.status).toBe(400);
      expect(refused.message).toContain('caja abierta');

      session = await openCashSession(api, '0.00');
      expect((await posContext(api)).session?.id).toBe(session.id);

      // Un turno abierto por usuario: la segunda apertura choca contra el índice único.
      const second = await api.post('/api/pos/cash-sessions', {
        data: { openingAmountPen: '0.00' },
      });
      expect(second.ok()).toBe(false);
      expect(second.status()).toBe(409);
    } finally {
      await closeSessionQuietly(api, session?.id);
    }
  });

  test('el disponible manda: la venta se bloquea y la reserva de otro pedido queda intacta (D-066, D-088)', async () => {
    const stock = await setupPosStock(api, { qty: '10', listPricePen: '10.0000' });
    const customer = await createCustomer(api);
    let session: CashSessionDto | undefined;
    const orderIds: string[] = [];

    try {
      // Otro pedido se lleva 8 de las 10 unidades. Quedan 2 disponibles.
      const order = await createDirectOrder(api, {
        customerId: customer.id,
        businessLine: POS_LINE,
        items: [{ productId: stock.product.id, qty: '8', unitPricePen: '10' }],
      });
      orderIds.push(order.id);
      const held = await reservationsOf(api, order.id);
      expect(held[0]).toMatchObject({ status: 'ACTIVE', qty: '8.000' });

      const availability = await availabilityOf(api, 'PRODUCT', stock.product.id);
      expect(availability).toMatchObject({
        qty: '10.000',
        reservedQty: '8.000',
        availableQty: '2.000',
      });

      // El buscador del mostrador muestra el disponible **real**, no el saldo físico.
      const listed = await posProducts(api, stock.product.sku);
      expect(listed.find((p) => p.productId === stock.product.id)?.availableQty).toBe('2.000');

      session = await openCashSession(api, '0.00');
      const refused = await posSellExpectingError(api, {
        items: [{ productId: stock.product.id, qty: '3.000', unitPricePen: '10.0000' }],
      });
      expect(refused.status).toBe(400);
      expect(refused.message).toContain('disponibles');

      // Lo que importa del rechazo: **nada se movió**. Ni el kardex, ni la reserva ajena.
      const after = await balanceOf(api, 'PRODUCT', stock.product.id);
      expect(after.qty).toBe('10.000');
      const stillHeld = await reservationsOf(api, order.id);
      expect(stillHeld[0]).toMatchObject({ status: 'ACTIVE', qty: '8.000' });
      const session2 = await cashSession(api, session.id);
      expect(session2.saleCount).toBe(0);
    } finally {
      await closeSessionQuietly(api, session?.id);
      await purgeSalesTrail(api, { orderIds });
    }
  });

  test('la boleta a público en general se corta en el tope y no gasta correlativo (D-077)', async () => {
    const stock = await setupPosStock(api, { qty: '40', listPricePen: '100.0000' });
    let session: CashSessionDto | undefined;

    try {
      session = await openCashSession(api, '0.00');
      const context = await posContext(api);
      expect(context.genericMaxTotalPen).toBe('700.0000');

      const refused = await posSellExpectingError(api, {
        items: [{ productId: stock.product.id, qty: '8.000', unitPricePen: '100.0000' }],
      });
      expect(refused.status).toBe(400);
      expect(refused.message).toContain('público en general');

      // El bloqueo es **antes** del kardex: el stock sigue entero.
      expect((await balanceOf(api, 'PRODUCT', stock.product.id)).qty).toBe('40.000');
      expect((await cashSession(api, session.id)).saleCount).toBe(0);
    } finally {
      await closeSessionQuietly(api, session?.id);
    }
  });

  test('el mostrador no vende material a medida ni mezcla líneas de negocio (D-098, D-104)', async () => {
    const stock = await setupPosStock(api, { qty: '10', listPricePen: '10.0000' });
    let session: CashSessionDto | undefined;

    try {
      session = await openCashSession(api, '0.00');

      // D-098: un producto que se mide en metros lineales es una cobertura a medida y no
      // aparece siquiera en el buscador del mostrador. Se **siembra uno con saldo** en vez de
      // comprobar que la lista no trae ninguno: sin un `MTR` vivo en la base, esa aserción
      // pasa por vacío y no prueba nada.
      const madeToMeasure = await setupMeasuredStock(api);
      const listed = await posProducts(api);
      expect(listed.some((p) => p.productId === madeToMeasure.product.id)).toBe(false);
      expect(listed.every((p) => p.unit !== 'MTR')).toBe(true);
      // Y si alguien lo pide por id, el API lo rechaza igual: el buscador es cortesía, no
      // el control.
      const refusedMeasured = await posSellExpectingError(api, {
        items: [{ productId: madeToMeasure.product.id, qty: '1.000', unitPricePen: '10.0000' }],
      });
      expect(refusedMeasured.status).toBe(400);
      expect(refusedMeasured.message).toContain('no se vende en mostrador');

      // D-104: un carrito de dos líneas de negocio no cabe en un pedido, que tiene una sola.
      const other = await postJson<{ id: string }>(api, '/api/catalog', {
        businessLineId: await drywallLineId(api),
        sku: `E2E-POS${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
        name: 'Producto E2E de otra línea',
        unit: 'NIU',
        source: 'PURCHASED',
        listPricePen: '10',
      });
      const refused = await posSellExpectingError(api, {
        items: [
          { productId: stock.product.id, qty: '1.000', unitPricePen: '10.0000' },
          { productId: other.id, qty: '1.000', unitPricePen: '10.0000' },
        ],
      });
      expect(refused.status).toBe(400);
      expect(refused.message).toContain('una sola línea de negocio');

      await api.patch(`/api/catalog/${other.id}`, { data: { isActive: false } });
    } finally {
      await closeSessionQuietly(api, session?.id);
    }
  });

  test('el arqueo con diferencia se registra con su motivo, y sin motivo no cierra (D-101)', async () => {
    let session: CashSessionDto | undefined;

    try {
      session = await openCashSession(api, '200.00');
      expect(session.expectedCashPen).toBe('200.0000');

      // Sin motivo, una diferencia no cierra: el arqueo existe para que quede escrita.
      const noReason = await api.post(`/api/pos/cash-sessions/${session.id}/close`, {
        data: { countedCashPen: '195.00' },
      });
      expect(noReason.ok()).toBe(false);
      expect(noReason.status()).toBe(400);

      // El turno sigue abierto: un cierre rechazado no deja la caja a medias.
      expect((await cashSession(api, session.id)).status).toBe('OPEN');

      const closed = await closeCashSession(
        api,
        session.id,
        '195.00',
        'Faltante E2E: vuelto entregado de más',
      );
      expect(closed.status).toBe('CLOSED');
      expect(closed.expectedCashPen).toBe('200.0000');
      expect(closed.countedCashPen).toBe('195.0000');
      expect(closed.differencePen).toBe('-5.0000');
      expect(closed.closingNotes).toContain('Faltante E2E');
      expect(closed.closedAt).not.toBeNull();

      // Cerrada dos veces, no: el arqueo es un hecho, no un estado que se reescriba.
      const again = await api.post(`/api/pos/cash-sessions/${session.id}/close`, {
        data: { countedCashPen: '200.00' },
      });
      expect(again.status()).toBe(409);

      // Y el turno cerrado libera el candado: se puede abrir el siguiente.
      const next = await openCashSession(api, '0.00');
      await closeSessionQuietly(api, next.id);
      session = undefined;
    } finally {
      await closeSessionQuietly(api, session?.id);
    }
  });

  test('una caja que cuadra cierra sin motivo y congela su esperado (D-101)', async () => {
    let session: CashSessionDto | undefined;
    try {
      session = await openCashSession(api, '80.00');
      const closed = await closeCashSession(api, session.id, '80.00');
      expect(closed.status).toBe('CLOSED');
      expect(closed.differencePen).toBe('0.0000');
      expect(closed.closingNotes).toBeNull();
      // El esperado guardado es el del cierre y no se recalcula al releerlo.
      expect((await cashSession(api, closed.id)).expectedCashPen).toBe('80.0000');
      session = undefined;
    } finally {
      await closeSessionQuietly(api, session?.id);
    }
  });
});

/** La línea drywall, para armar un carrito mezclado sin depender de un id fijo. */
async function drywallLineId(api: APIRequestContext): Promise<string> {
  const lines = await api
    .get('/api/business-lines')
    .then((r) => r.json() as Promise<{ id: string; code: string }[]>);
  const line = lines.find((l) => l.code === 'drywall');
  expect(line, 'no existe la línea drywall').toBeDefined();
  return line!.id;
}
