import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, postJson } from '../helpers/api';
import type { ProductionOrderDto } from '../helpers/production';
import { dispatchOrder } from '../helpers/invoicing';
import {
  createCustomer,
  createQuotation,
  createSellableProduct,
  isoDaysFromToday,
  purgeSalesTrail,
  queueOf,
  setPriority,
  setupCoilStock,
  type SalesOrderDto,
} from '../helpers/sales';
import {
  metersOf,
  pieces,
  purgeRoofingTrail,
  quoteAndOrder,
  reservationsOf,
  roofingOrder,
  setupRoofingScenario,
  ROOFING_LINE,
} from '../helpers/roofing';

/**
 * Fase 7 — cola de producción sobre coberturas contra pedido (RF-37, RF-38; D-092..D-096).
 *
 * Lo que estos tests protegen, en una línea: **la cola no es una tabla, es una lectura de la
 * verdad que ya existe** (reservas de bobina + OP viva), así que entrar y salir de ella nunca
 * puede quedar desincronizado del pedido, la producción o la reserva que la sostiene.
 */

const allowWrites = process.env.E2E_ALLOW_WRITES === '1' || !process.env.E2E_BASE_URL;

test.describe.configure({ timeout: 240_000 });

test.describe('Fase 7 — cola de producción de coberturas', () => {
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

  test('el ciclo completo: EN_COLA → EN_PRODUCCION → fuera de la cola al cerrar → despachar', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '500' });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      productionOrderIds: [],
      orderIds: [],
      quotationIds: [],
    };

    try {
      // 2 planchas de 4 m ⇒ 8 m ⇒ 32 kg teóricos. Se reservan 50 kg: queda margen de sobra
      // (18 kg) para que la reserva de bobina siga viva mientras la OP está en curso.
      const rows = pieces([4, 2]);
      const { order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        coilId: scenario.coil.id,
        reserveKg: '50',
        rows,
      });
      trail.orderIds = [order.id];

      // Confirmado y sin OP: aparece EN_COLA, y el detalle del pedido coincide.
      const queueBefore = await queueOf(api);
      const entry = queueBefore.find((q) => q.salesOrderId === order.id);
      expect(entry).toMatchObject({
        salesOrderCode: order.code,
        customerName: customer.name,
        productId: scenario.product.id,
        theoreticalKg: '32.000',
        semaphore: 'SIN_FECHA',
        priority: false,
      });
      const detailQueued = await getOrder(api, order.id);
      expect(detailQueued.queueStatus).toBe('EN_COLA');

      // --- Nace la OP: sale de la cola y pasa a EN_PRODUCCION ---
      const reservation = (await reservationsOf(api, order.id))[0]!;
      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];

      const queueDuringOp = await queueOf(api);
      expect(queueDuringOp.some((q) => q.salesOrderId === order.id)).toBe(false);
      const detailInProduction = await getOrder(api, order.id);
      expect(detailInProduction.queueStatus).toBe('EN_PRODUCCION');

      // --- Montar la bobina, reportar los largos reales y cerrar declarando todo el
      // consumo: el sobrante (18 kg) queda declarado como merma y agota la reserva ---
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/coils`, {
        coilId: scenario.coil.id,
      });
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/report`, {
        pieces: rows,
      });
      const closed = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${op.id}/close`,
        // 18 kg de despunte sobre 50 consumidos son 36 %: por encima del 10 % que tolera un
        // cierre sin explicación (D-089), hace falta el motivo.
        { consumedKg: '50', reason: 'Despunte alto de prueba E2E: se declara todo lo reservado' },
      );
      expect(closed.status).toBe('CLOSED');
      expect(closed.scrapKg).toBe('18.000');

      // La reserva de bobina quedó CONSUMIDA entera: sale de la cola para siempre, no solo
      // mientras la OP estuvo viva.
      const queueAfterClose = await queueOf(api);
      expect(queueAfterClose.some((q) => q.salesOrderId === order.id)).toBe(false);
      const detailClosed = await getOrder(api, order.id);
      expect(detailClosed.queueStatus).toBeNull();

      // Y lo que ya es producto terminado se puede despachar con normalidad.
      const dispatch = await dispatchOrder(api, {
        salesOrderId: order.id,
        items: [{ salesOrderItemId: order.items[0]!.id, qty: metersOf(rows), weightKg: '32' }],
      });
      expect(dispatch.items[0]).toMatchObject({ itemType: 'PRODUCT', itemId: scenario.product.id });
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('cerrar con menos consumo que lo reservado libera el sobrante: el pedido no se queda en la cola para siempre', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '500' });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      productionOrderIds: [],
      orderIds: [],
      quotationIds: [],
    };

    try {
      // El vendedor reservó 50 kg "para no quedarse corto"; la corrida real solo gasta 8. Sin
      // el arreglo de esta sesión (`releaseRemainingReservation`), esos 42 kg de sobra
      // dejaban la reserva ACTIVA para siempre y el pedido no salía de la cola ni despachado.
      const rows = pieces([2, 1]); // 2 m ⇒ 8 kg teóricos
      const { order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        coilId: scenario.coil.id,
        reserveKg: '50',
        rows,
      });
      trail.orderIds = [order.id];

      const reservation = (await reservationsOf(api, order.id))[0]!;
      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];

      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/coils`, {
        coilId: scenario.coil.id,
      });
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/report`, {
        pieces: rows,
      });
      // Cierre por defecto: sin `consumedKg`, se declara exactamente lo reportado (merma cero).
      const closed = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${op.id}/close`,
        {},
      );
      expect(closed.status).toBe('CLOSED');
      expect(closed.scrapKg).toBe('0.000');

      // Los 42 kg que sobraron de la reserva quedan RELEASED, no ACTIVE para siempre.
      const reservationAfter = (await reservationsOf(api, order.id)).find(
        (r) => r.id === reservation.id,
      );
      expect(reservationAfter?.status).toBe('RELEASED');

      // Y aunque el pedido termine despachado entero, ya no vuelve a aparecer en la cola.
      const dispatch = await dispatchOrder(api, {
        salesOrderId: order.id,
        items: [{ salesOrderItemId: order.items[0]!.id, qty: metersOf(rows), weightKg: '8' }],
      });
      expect(dispatch.items[0]).toMatchObject({ itemType: 'PRODUCT', itemId: scenario.product.id });

      expect((await queueOf(api)).some((q) => q.salesOrderId === order.id)).toBe(false);
      const detail = await getOrder(api, order.id);
      expect(detail.queueStatus).toBeNull();
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('anular la OP sin reportes vigentes devuelve el pedido a la cola', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '400' });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      productionOrderIds: [],
      orderIds: [],
      quotationIds: [],
    };

    try {
      const rows = pieces([3, 2]); // 6 m ⇒ 24 kg
      const { order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        coilId: scenario.coil.id,
        reserveKg: '30',
        rows,
      });
      trail.orderIds = [order.id];
      const reservation = (await reservationsOf(api, order.id))[0]!;
      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];

      expect((await queueOf(api)).some((q) => q.salesOrderId === order.id)).toBe(false);

      const cancelled = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${op.id}/cancel`,
        { reason: 'El cliente cambió la medida' },
      );
      expect(cancelled.status).toBe('CANCELLED');

      // Sin OP viva y la reserva otra vez ACTIVA: el pedido reaparece solo.
      const queueAfter = await queueOf(api);
      expect(queueAfter.find((q) => q.salesOrderId === order.id)).toMatchObject({
        theoreticalKg: '24.000',
      });
      const detail = await getOrder(api, order.id);
      expect(detail.queueStatus).toBe('EN_COLA');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('la prioridad manual reordena la cola por delante del FIFO, y quitarla lo restaura (D-094)', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '400' });
    const customerA = await createCustomer(api);
    const customerB = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      orderIds: [],
      quotationIds: [],
    };

    try {
      // Dos pedidos EN_COLA, sin fecha prometida (mismo semáforo): el orden inicial es FIFO.
      const { order: orderA } = await quoteAndOrder(api, {
        customerId: customerA.id,
        productId: scenario.product.id,
        coilId: scenario.coil.id,
        reserveKg: '20',
        rows: pieces([2, 1]),
      });
      const { order: orderB } = await quoteAndOrder(api, {
        customerId: customerB.id,
        productId: scenario.product.id,
        coilId: scenario.coil.id,
        reserveKg: '20',
        rows: pieces([2, 1]),
      });
      trail.orderIds = [orderA.id, orderB.id];

      const before = await queueOf(api);
      const idxABefore = before.findIndex((q) => q.salesOrderId === orderA.id);
      const idxBBefore = before.findIndex((q) => q.salesOrderId === orderB.id);
      expect(idxABefore).toBeGreaterThanOrEqual(0);
      expect(idxBBefore).toBeGreaterThanOrEqual(0);
      // A se creó primero: FIFO lo pone delante pese a tener el mismo semáforo que B.
      expect(idxABefore).toBeLessThan(idxBBefore);

      // Priorizar B (más nuevo) lo salta al frente pese al FIFO.
      const prioritized = await setPriority(api, orderB.id, {
        priority: true,
        reason: 'Cliente VIP pidió adelanto de entrega',
      });
      expect(prioritized.priority).toBe(true);
      expect(prioritized.priorityReason).toBe('Cliente VIP pidió adelanto de entrega');
      expect(prioritized.priorityByName).not.toBeNull();

      const during = await queueOf(api);
      const idxADuring = during.findIndex((q) => q.salesOrderId === orderA.id);
      const idxBDuring = during.findIndex((q) => q.salesOrderId === orderB.id);
      expect(during[idxBDuring]?.priority).toBe(true);
      expect(idxBDuring).toBeLessThan(idxADuring);

      // Quitar la prioridad (con motivo también) restaura el FIFO original.
      const cleared = await setPriority(api, orderB.id, {
        priority: false,
        reason: 'Se resolvió por la vía normal',
      });
      expect(cleared.priority).toBe(false);
      expect(cleared.priorityReason).toBeNull();

      const after = await queueOf(api);
      const idxAAfter = after.findIndex((q) => q.salesOrderId === orderA.id);
      const idxBAfter = after.findIndex((q) => q.salesOrderId === orderB.id);
      expect(idxAAfter).toBeLessThan(idxBAfter);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('un pedido con fecha prometida vencida se marca VENCIDO en la cola (D-096)', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '300' });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      orderIds: [],
      quotationIds: [],
    };

    try {
      const rows = pieces([2, 1]); // 2 m ⇒ 8 kg
      const overdue = isoDaysFromToday(-3);
      const { order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        coilId: scenario.coil.id,
        reserveKg: '20',
        rows,
        promisedDeliveryDate: overdue,
      });
      trail.orderIds = [order.id];
      expect(order.promisedDeliveryDate).toBe(overdue);

      const entry = (await queueOf(api)).find((q) => q.salesOrderId === order.id);
      expect(entry).toMatchObject({ promisedDeliveryDate: overdue, semaphore: 'VENCIDO' });
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('un pedido sin receta detrás nunca aparece en la cola, aunque reserve la bobina y esté confirmado (RF-73)', async () => {
    // Producto vendible sin `ProductBom` (D-093 exige receta activa: RF-73, la bobina se
    // vende tal cual, sin transformarla). La línea es la misma de coberturas para que la
    // única diferencia con el resto de la fase sea, precisamente, la receta.
    const stock = await setupCoilStock(api, { lineCode: ROOFING_LINE, weightKg: '500' });
    const customer = await createCustomer(api);
    const product = await createSellableProduct(api, {
      lineCode: ROOFING_LINE,
      listPricePen: '40',
    });
    const trail: { orderIds: string[]; quotationIds: string[] } = {
      orderIds: [],
      quotationIds: [],
    };

    try {
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: product.id,
        qty: '80',
        reserveFromCoilId: stock.coil.id,
        reserveKg: '80',
      });
      trail.quotationIds = [quotation.id];
      await postJson(api, `/api/sales/quotations/${quotation.id}/emit`);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds = [order.id];

      // Reserva de bobina, confirmado, y sin embargo nunca aparece: no hay receta detrás.
      expect(order.reservations[0]).toMatchObject({ itemType: 'COIL', status: 'ACTIVE' });
      expect(order.queueStatus).toBeNull();
      expect((await queueOf(api)).some((q) => q.salesOrderId === order.id)).toBe(false);
    } finally {
      await purgeSalesTrail(api, trail);
      await api
        .patch(`/api/catalog/${product.id}`, { data: { isActive: false } })
        .catch(() => undefined);
      await api
        .post(`/api/coils/${stock.coil.id}/cancel`, { data: { reason: 'Limpieza de prueba E2E' } })
        .catch(() => undefined);
      await api
        .post(`/api/purchases/${stock.purchaseId}/cancel`, {
          data: { reason: 'Limpieza de prueba E2E' },
        })
        .catch(() => undefined);
      await api
        .patch(`/api/suppliers/${stock.supplier.id}`, { data: { isActive: false } })
        .catch(() => undefined);
      await api
        .patch(`/api/finishes/${stock.finish.id}`, { data: { isActive: false } })
        .catch(() => undefined);
    }
  });

  test('anular un pedido EN_COLA lo saca de la cola y libera la reserva (RF-33/D-066 con la cola)', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '350' });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      orderIds: [],
      quotationIds: [],
    };

    try {
      const rows = pieces([3, 1]); // 3 m ⇒ 12 kg
      const { order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        coilId: scenario.coil.id,
        reserveKg: '20',
        rows,
      });
      // No se agrega a `trail.orderIds`: el pedido se anula dentro del propio test y no hace
      // falta que la purga lo reintente.

      expect((await queueOf(api)).some((q) => q.salesOrderId === order.id)).toBe(true);
      const reservationBefore = (await reservationsOf(api, order.id))[0]!;
      expect(reservationBefore.status).toBe('ACTIVE');

      const cancelled = await postJson<SalesOrderDto>(api, `/api/sales/orders/${order.id}/cancel`, {
        reason: 'El cliente desistió de la compra',
      });
      expect(cancelled.status).toBe('CANCELLED');

      expect((await queueOf(api)).some((q) => q.salesOrderId === order.id)).toBe(false);
      const reservationAfter = (await reservationsOf(api, order.id))[0]!;
      expect(reservationAfter.status).toBe('RELEASED');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});

/** Detalle de un pedido, con los campos de la Fase 7 tipados. */
async function getOrder(api: APIRequestContext, orderId: string): Promise<SalesOrderDto> {
  const res = await api.get(`/api/sales/orders/${orderId}`);
  if (!res.ok())
    throw new Error(`GET orders/${orderId} falló: ${res.status()} ${await res.text()}`);
  return (await res.json()) as SalesOrderDto;
}
