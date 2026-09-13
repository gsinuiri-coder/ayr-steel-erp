import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getJson, postJson } from '../helpers/api';
import { today, type ProductionOrderDto } from '../helpers/production';
import { dispatchOrder } from '../helpers/invoicing';
import {
  createCustomer,
  isoDaysFromToday,
  purgeSalesTrail,
  queueOf,
  linesWithoutOrderOf,
  setOrderPriority,
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
 * verdad que ya existe**, así que entrar y salir de ella nunca puede quedar desincronizado del
 * pedido, la producción o la reserva que la sostiene.
 *
 * D-189 (F8-S3): la cola son las **órdenes no iniciadas** —confirmar las crea (D-186)— con la
 * prioridad manual por orden y un solo ranking (`compareQueueRank`) para la cola y `/planta`.
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
      const { quotation: quotation1, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows,
      });
      (trail.quotationIds ??= []).push(quotation1.id);
      trail.orderIds = [order.id];

      // D-189: confirmar abrió la OP en borrador, y esa orden no iniciada **es** la entrada
      // de la cola. El detalle del pedido coincide.
      const reservation = (await reservationsOf(api, order.id))[0]!;
      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];
      const queueBefore = await queueOf(api);
      const entry = queueBefore.find((q) => q.orderId === op.id);
      expect(entry).toMatchObject({
        code: op.code,
        salesOrderId: order.id,
        salesOrderCode: order.code,
        customerName: customer.name,
        productId: scenario.product.id,
        productSku: scenario.product.sku,
        planMeters: '8.000',
        theoreticalKg: '32.320',
        semaphore: 'SIN_FECHA',
        overdue: false,
        priority: false,
      });
      const detailQueued = await getOrder(api, order.id);
      expect(detailQueued.queueStatus).toBe('EN_COLA');

      // --- Montar la bobina inicia la orden: sale de la cola y el pedido pasa a EN_PRODUCCION ---
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/coils`, {
        coilId: scenario.coil.id,
      });
      const queueDuringOp = await queueOf(api);
      expect(queueDuringOp.some((q) => q.orderId === op.id)).toBe(false);
      const detailInProduction = await getOrder(api, order.id);
      expect(detailInProduction.queueStatus).toBe('EN_PRODUCCION');

      // --- Reportar los largos reales y cerrar declarando todo el consumo: el sobrante
      // (18 kg) queda declarado como merma y agota la reserva ---
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/report`, {
        pieces: rows,
      });
      const closed = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${op.id}/close`,
        // 17.68 kg de despunte sobre 50 consumidos son 35 %: por encima del 10 % que tolera un
        // cierre sin explicación (D-089), hace falta el motivo.
        { consumedKg: '50', reason: 'Despunte alto de prueba E2E: se declara todo lo reservado' },
      );
      expect(closed.status).toBe('CLOSED');
      expect(closed.scrapKg).toBe('17.680');

      // La reserva de bobina quedó CONSUMIDA entera: no vuelve a la cola ni a «sin orden».
      const queueAfterClose = await queueOf(api);
      expect(queueAfterClose.some((q) => q.salesOrderId === order.id)).toBe(false);
      expect((await linesWithoutOrderOf(api)).some((l) => l.salesOrderId === order.id)).toBe(false);
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
      // D-134: la reserva ya no la fija el vendedor a mano (antes podía pedir 50 kg "para no
      // quedarse corto" aunque el plan pidiera menos); ahora es siempre el kilo teórico del
      // plan. El sobrante que hay que liberar sale de la misma fuente real de siempre: planta
      // reporta **menos** de lo que el plan de corte preveía. El pedido promete 8 m (32 kg) y
      // la corrida real solo entrega 2 m (8 kg). Sin el arreglo de esta sesión
      // (`releaseRemainingReservation`), los 24 kg de sobra dejaban la reserva ACTIVA para
      // siempre y el pedido no salía de la cola ni despachado.
      const plannedRows = pieces([4, 2]); // 8 m ⇒ 32 kg reservados
      const { quotation: quotation2, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows: plannedRows,
      });
      (trail.quotationIds ??= []).push(quotation2.id);
      trail.orderIds = [order.id];

      const reservation = (await reservationsOf(api, order.id))[0]!;
      expect(reservation.qty).toBe('32.320');
      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];

      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/coils`, {
        coilId: scenario.coil.id,
      });
      const reportedRows = pieces([2, 1]); // 2 m ⇒ 8 kg: menos de lo que el plan preveía
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/report`, {
        pieces: reportedRows,
      });
      // Cierre por defecto: sin `consumedKg`, se declara exactamente lo reportado (merma cero).
      const closed = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${op.id}/close`,
        {},
      );
      expect(closed.status).toBe('CLOSED');
      expect(closed.scrapKg).toBe('0.000');

      // Los 24 kg que sobraron de la reserva quedan RELEASED, no ACTIVE para siempre.
      const reservationAfter = (await reservationsOf(api, order.id)).find(
        (r) => r.id === reservation.id,
      );
      expect(reservationAfter?.status).toBe('RELEASED');

      // Y aunque el pedido quede con menos de lo prometido despachado, ya no vuelve a
      // aparecer en la cola: no hay más material que rolar contra él.
      const dispatch = await dispatchOrder(api, {
        salesOrderId: order.id,
        items: [
          { salesOrderItemId: order.items[0]!.id, qty: metersOf(reportedRows), weightKg: '8' },
        ],
      });
      expect(dispatch.items[0]).toMatchObject({ itemType: 'PRODUCT', itemId: scenario.product.id });

      expect((await queueOf(api)).some((q) => q.salesOrderId === order.id)).toBe(false);
      const detail = await getOrder(api, order.id);
      expect(detail.queueStatus).toBeNull();
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('anular la OP sin reportes vigentes la saca de la cola y deja la línea sin orden', async () => {
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
      const { quotation: quotation3, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows,
      });
      (trail.quotationIds ??= []).push(quotation3.id);
      trail.orderIds = [order.id];
      const reservation = (await reservationsOf(api, order.id))[0]!;
      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];

      expect((await queueOf(api)).some((q) => q.orderId === op.id)).toBe(true);
      expect((await linesWithoutOrderOf(api)).some((l) => l.salesOrderId === order.id)).toBe(false);

      const cancelled = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${op.id}/cancel`,
        { reason: 'El cliente cambió la medida' },
      );
      expect(cancelled.status).toBe('CANCELLED');

      // D-189: una orden anulada no está esperando a nadie — sale de la cola. La reserva
      // vuelve a ACTIVA (D-066) y la línea aparece sola entre las que no tienen orden, que es
      // desde donde planta vuelve a abrir una.
      expect((await queueOf(api)).some((q) => q.orderId === op.id)).toBe(false);
      expect(
        (await linesWithoutOrderOf(api)).find((l) => l.salesOrderId === order.id),
      ).toMatchObject({ reservationId: reservation.id, theoreticalKg: '24.240' });
      const detail = await getOrder(api, order.id);
      expect(detail.queueStatus).toBeNull();

      // Y reabrir la orden desde esa línea la devuelve a la cola.
      const reopened = await postJson<ProductionOrderDto>(api, '/api/production/roofing', {
        reservationId: reservation.id,
      });
      trail.productionOrderIds = [op.id, reopened.id];
      expect((await queueOf(api)).some((q) => q.orderId === reopened.id)).toBe(true);
      expect((await getOrder(api, order.id)).queueStatus).toBe('EN_COLA');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('la prioridad manual de una orden la adelanta en la cola por delante del FIFO, y quitarla lo restaura (D-094, D-189)', async () => {
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
      const { quotation: quotation4, order: orderA } = await quoteAndOrder(api, {
        customerId: customerA.id,
        productId: scenario.product.id,
        rows: pieces([2, 1]),
      });
      (trail.quotationIds ??= []).push(quotation4.id);
      const { quotation: quotation5, order: orderB } = await quoteAndOrder(api, {
        customerId: customerB.id,
        productId: scenario.product.id,
        rows: pieces([2, 1]),
      });
      (trail.quotationIds ??= []).push(quotation5.id);
      trail.orderIds = [orderA.id, orderB.id];
      // D-189: confirmar dejó una OP no iniciada por pedido; esas son las entradas de la cola.
      const opA = orderA.reservations[0]!.productionOrderId!;
      const opB = orderB.reservations[0]!.productionOrderId!;

      const before = await queueOf(api);
      const idxABefore = before.findIndex((q) => q.orderId === opA);
      const idxBBefore = before.findIndex((q) => q.orderId === opB);
      expect(idxABefore).toBeGreaterThanOrEqual(0);
      expect(idxBBefore).toBeGreaterThanOrEqual(0);
      // A se creó primero: FIFO lo pone delante pese a tener la misma fecha (ninguna) que B.
      expect(idxABefore).toBeLessThan(idxBBefore);

      // Priorizar la orden de B (más nueva) la salta al frente pese al FIFO.
      const prioritized = await setOrderPriority(api, opB, {
        priority: true,
        reason: 'Cliente VIP pidió adelanto de entrega',
      });
      expect(prioritized.priority).toBe(true);
      expect(prioritized.priorityReason).toBe('Cliente VIP pidió adelanto de entrega');
      expect(prioritized.priorityByName).not.toBeNull();

      const during = await queueOf(api);
      const idxADuring = during.findIndex((q) => q.orderId === opA);
      const idxBDuring = during.findIndex((q) => q.orderId === opB);
      expect(during[idxBDuring]?.priority).toBe(true);
      expect(idxBDuring).toBeLessThan(idxADuring);

      // `/planta` presenta las no iniciadas en el mismo orden que la cola (un solo ranking).
      const batch = await getJson<{ orderId: string; status: string }[]>(
        api,
        '/api/production/roofing/batch',
      );
      // Se compara el orden relativo de las dos órdenes del test: otros specs pueden estar
      // abriendo órdenes en paralelo entre las dos lecturas.
      const mine = new Set([opA, opB]);
      const drafts = batch.filter((o) => mine.has(o.orderId)).map((o) => o.orderId);
      expect(drafts).toEqual([opB, opA]);

      // Quitar la prioridad (con motivo también) restaura el FIFO original.
      const cleared = await setOrderPriority(api, opB, {
        priority: false,
        reason: 'Se resolvió por la vía normal',
      });
      expect(cleared.priority).toBe(false);
      expect(cleared.priorityReason).toBeNull();

      const after = await queueOf(api);
      const idxAAfter = after.findIndex((q) => q.orderId === opA);
      const idxBAfter = after.findIndex((q) => q.orderId === opB);
      expect(idxAAfter).toBeLessThan(idxBAfter);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('una orden cuyo pedido tiene la fecha prometida vencida se marca vencida y sube dentro de su prioridad (D-096, D-189)', async () => {
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
      const rows = pieces([2, 1]); // 2 m ⇒ 8 kg por pedido
      // Se crean en el orden **inverso** al que la cola tiene que devolver, así que un FIFO
      // a secas daría exactamente el orden equivocado.
      const far = isoDaysFromToday(10);
      const near = isoDaysFromToday(2);
      const overdue = isoDaysFromToday(-3);
      const { quotation: quotation6, order: farOrder } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows,
        promisedDeliveryDate: far,
      });
      (trail.quotationIds ??= []).push(quotation6.id);
      trail.orderIds = [farOrder.id];
      const { quotation: quotation7, order: nearOrder } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows,
        promisedDeliveryDate: near,
      });
      (trail.quotationIds ??= []).push(quotation7.id);
      trail.orderIds.push(nearOrder.id);
      const { quotation: quotation8, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows,
        promisedDeliveryDate: overdue,
      });
      (trail.quotationIds ??= []).push(quotation8.id);
      trail.orderIds.push(order.id);
      expect(order.promisedDeliveryDate).toBe(overdue);
      const opFar = farOrder.reservations[0]!.productionOrderId!;
      const opNear = nearOrder.reservations[0]!.productionOrderId!;
      const opOverdue = order.reservations[0]!.productionOrderId!;
      const mine = [opFar, opNear, opOverdue];

      const queue = await queueOf(api);
      const entry = queue.find((q) => q.orderId === opOverdue);
      expect(entry).toMatchObject({
        promisedDeliveryDate: overdue,
        semaphore: 'VENCIDO',
        overdue: true,
      });
      expect(queue.find((q) => q.orderId === opNear)).toMatchObject({ overdue: false });
      // Vencida arriba, después la fecha más cercana.
      expect(queue.filter((q) => mine.includes(q.orderId)).map((q) => q.orderId)).toEqual([
        opOverdue,
        opNear,
        opFar,
      ]);

      // La prioridad manual va antes que el vencimiento: priorizar la de fecha lejana la sube
      // por encima de la vencida, y dentro de las no priorizadas la vencida sigue arriba.
      await setOrderPriority(api, opFar, { priority: true, reason: 'Obra del cliente adelantada' });
      const prioritized = await queueOf(api);
      expect(prioritized.filter((q) => mine.includes(q.orderId)).map((q) => q.orderId)).toEqual([
        opFar,
        opOverdue,
        opNear,
      ]);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('un pedido de venta de bobina entera nunca aparece en la cola, aunque reserve la bobina y esté confirmado (RF-73)', async () => {
    // D-134 retiró `reserveFromCoilId`: ya no hay forma de que una línea con un producto de
    // catálogo reserve una bobina concreta. El caso "hay reserva de bobina, pero no hay
    // receta detrás" sigue existiendo, y ahora solo se alcanza por la venta de la bobina
    // **entera** (RF-73, `saleCoilId`): esa reserva es de tipo `COIL`, tal cual antes, y por
    // definición no tiene ninguna receta que la produzca — el rollo se vende tal cual.
    const stock = await setupCoilStock(api, { lineCode: ROOFING_LINE, weightKg: '500' });
    const customer = await createCustomer(api);
    const trail: { orderIds: string[]; quotationIds: string[] } = {
      orderIds: [],
      quotationIds: [],
    };

    try {
      const quotation = await postJson<{ id: string }>(api, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: today(),
        items: [{ saleCoilId: stock.coil.id, qty: stock.coil.availableKg, unitPricePen: '9' }],
      });
      trail.quotationIds = [quotation.id];
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
      const { quotation: quotation9, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows,
      });
      (trail.quotationIds ??= []).push(quotation9.id);
      // No se agrega a `trail.orderIds`: el pedido se anula dentro del propio test y no hace
      // falta que la purga lo reintente.
      // D-189: la orden no iniciada que abrió confirmar es la entrada de la cola.
      const opId = order.reservations[0]!.productionOrderId!;
      expect((await queueOf(api)).some((q) => q.orderId === opId)).toBe(true);
      const reservationBefore = (await reservationsOf(api, order.id))[0]!;
      expect(reservationBefore.status).toBe('ACTIVE');

      const cancelled = await postJson<SalesOrderDto>(api, `/api/sales/orders/${order.id}/cancel`, {
        reason: 'El cliente desistió de la compra',
      });
      expect(cancelled.status).toBe('CANCELLED');

      // Anular el pedido anula su OP en borrador (D-186): sale de la cola y la línea tampoco
      // queda «sin orden», porque la reserva se liberó.
      expect((await queueOf(api)).some((q) => q.orderId === opId)).toBe(false);
      expect((await linesWithoutOrderOf(api)).some((l) => l.salesOrderId === order.id)).toBe(false);
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
