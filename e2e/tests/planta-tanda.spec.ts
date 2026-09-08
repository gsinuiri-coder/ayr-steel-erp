import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getJson, postJson } from '../helpers/api';
import {
  balanceOf,
  optionalBalanceOf,
  postExpectingError,
  today,
  type ProductionOrderDto,
} from '../helpers/production';
import { createCustomer } from '../helpers/sales';
import {
  buyRoofingCoil,
  createRoofingProduct,
  metersOf,
  pieces,
  purgeRoofingTrail,
  quoteAndOrder,
  reservationsOf,
  roofingOrder,
  ROOFING_LINE,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * Integridad de producción y captura en tanda: D-146, D-147 y D-148.
 *
 * Las tres decisiones nacen del mismo hueco. El plan de corte era una **intención** y la
 * única cota de un reporte era el material montado, así que una orden de 100 ML con un rollo
 * entero encima podía reportar 300 ML — y esos metros de más nacían reservados a nombre del
 * pedido (D-088) o entraban al almacén como stock que nadie encargó. Reportar orden por
 * orden, además, obligaba a buscar y abrir cada una cuando lo que hay en la mano es una hoja
 * con el turno entero.
 *
 * Lo que estos casos protegen:
 *
 * - **D-146**: el acumulado reportado de una orden nunca pasa el ML de su plan, sin
 *   tolerancia; y el kg que planta declara por reporte se guarda pero **no** toca el kardex,
 *   que sigue saliendo por el kilo teórico (D-047).
 * - **D-147**: la tanda es todo o nada. Una fila mala deja las buenas sin escribir, y eso se
 *   comprueba **en el kardex**, no en el mensaje.
 * - **D-148**: generar las órdenes de un pedido de una vez no crea órdenes distintas de las
 *   que crea el botón de a una.
 *
 * Aritmética a ojo, la misma de Fase 6: bobina de 1 000 mm × 0.50 mm con densidad 8.0 ⇒
 * **4 kg por metro lineal**. Una plancha de 4 m son 16 kg; una de 6 m, 24 kg.
 *
 * Todos los casos escriben (compras, bobinas, pedidos, producción): nunca contra producción
 * (regla dura 9, D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea compras, bobinas, pedidos y órdenes de producción: nunca contra producción (D-126, regla dura 9).',
);

test.describe.configure({ timeout: 240_000 });

/** Fila de `GET /production/roofing/batch`, lo que la pantalla de tanda pinta. */
interface BatchRow {
  orderId: string;
  code: string;
  planMeters: string;
  reportedMeters: string;
  remainingMeters: string;
  declaredKg: string;
  reportedKg: string;
  remainingPieces: { lengthMm: string; qty: number }[];
  coils: { coilId: string; coilCode: string }[];
}

async function batchRows(api: APIRequestContext, salesOrderId?: string): Promise<BatchRow[]> {
  return getJson<BatchRow[]>(
    api,
    `/api/production/roofing/batch${salesOrderId ? `?salesOrderId=${salesOrderId}` : ''}`,
  );
}

/** El error de la tanda con el detalle por fila, que `postExpectingError` no conserva. */
async function batchExpectingError(
  api: APIRequestContext,
  data: unknown,
): Promise<{ status: number; message: string; errors: Record<string, string[]> }> {
  const res = await api.post('/api/production/roofing/batch', { data });
  expect(res.ok(), 'La tanda debía fallar').toBe(false);
  const body = (await res.json()) as {
    message?: string | string[];
    errors?: Record<string, string[]>;
  };
  return {
    status: res.status(),
    message: Array.isArray(body.message) ? body.message.join(', ') : (body.message ?? ''),
    errors: body.errors ?? {},
  };
}

test.describe('D-146/D-147 — tope del plan y captura en tanda', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('D-146: el acumulado reportado nunca pasa el ML del plan, y el borde exacto sí entra', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
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
      // Plan de 10 planchas de 4 m = 40 ML. Es el ejemplo del pedido a otra escala.
      const plan = pieces([4, 10]);
      expect(metersOf(plan)).toBe('40.000');
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows: plan,
      });
      trail.orderIds = [order.id];
      trail.quotationIds = [quotation.id];

      const reservation = (await reservationsOf(api, order.id)).find((r) => r.status === 'ACTIVE');
      const op = await roofingOrder(api, reservation!.id);
      trail.productionOrderIds = [op.id];
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/coils`, {
        coilId: scenario.coil.id,
      });

      // 8 planchas de 4 m = 32 ML: entra, quedan 8.
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/report`, {
        pieces: pieces([4, 8]),
      });

      // 3 más serían 44 ML sobre un plan de 40: el tope corta antes de tocar el kardex.
      const rejected = await postExpectingError(api, `/api/production/roofing/${op.id}/report`, {
        pieces: pieces([4, 3]),
      });
      expect(rejected.status).toBe(400);
      expect(rejected.message).toContain('40.000');
      expect(rejected.message).toContain('quedan 8.000 m');

      // El rechazo no dejó rastro: la bobina sigue con los 32 × 4 kg del primer reporte.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1872.000');

      // El borde exacto sí entra: 2 planchas de 4 m completan los 40 ML clavados.
      const complete = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${op.id}/report`,
        { pieces: pieces([4, 2]) },
      );
      expect(complete.metersReported).toBe('40.000');
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1840.000');

      // Con el plan cubierto, cualquier reporte siguiente se rechaza diciendo justamente eso.
      const covered = await postExpectingError(api, `/api/production/roofing/${op.id}/report`, {
        pieces: pieces([4, 1]),
      });
      expect(covered.message).toContain('el plan ya está cubierto');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-146: el kg declarado se guarda pero el kardex sigue saliendo por el teórico', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
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
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows: pieces([4, 10]),
      });
      trail.orderIds = [order.id];
      trail.quotationIds = [quotation.id];
      const reservation = (await reservationsOf(api, order.id)).find((r) => r.status === 'ACTIVE');
      const op = await roofingOrder(api, reservation!.id);
      trail.productionOrderIds = [op.id];
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/coils`, {
        coilId: scenario.coil.id,
      });

      // 4 planchas de 4 m: 16 ML, 64 kg teóricos. Planta declara 70 —el despunte real— y el
      // tope es el kilo teórico del **plan completo**: 40 ML × 4 kg/m = 160 kg.
      const reported = await postJson<
        ProductionOrderDto & {
          reports: { consumedKg: string | null; theoreticalKg: string; status: string }[];
        }
      >(api, `/api/production/roofing/${op.id}/report`, {
        pieces: pieces([4, 4]),
        consumedKg: '70.000',
      });
      const report = reported.reports.find((r) => r.status === 'ACTIVE')!;
      expect(report.theoreticalKg).toBe('64.000');
      expect(report.consumedKg).toBe('70.000');
      // **Lo que decide la decisión:** salieron 64 kg, no 70. El consumo real se reconcilia
      // al cerrar (D-089); el kg declarado es dato de planta, no un movimiento.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1936.000');

      // Por encima del kilo teórico del plan, no entra.
      const rejected = await postExpectingError(api, `/api/production/roofing/${op.id}/report`, {
        pieces: pieces([4, 2]),
        consumedKg: '120.000',
      });
      expect(rejected.status).toBe(400);
      expect(rejected.message).toContain('160.000 kg');
      expect(rejected.message).toContain('70.000 kg declarados');

      // Y ese rechazo tampoco movió nada.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1936.000');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-147: tanda feliz — dos órdenes en un solo envío', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
    const second = await buyRoofingCoil(api, {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      weightKg: '2000',
    });
    // Una tercera bobina que nadie monta. D-134: un rollo montado sale **entero** del
    // disponible del agregado —no por los kilos asignados, sino el rollo completo—, así que
    // con solo dos bobinas el segundo montaje dejaría la promesa del otro pedido sin
    // material y el guardrail lo cortaría, que es lo correcto. Esta es exactamente la "otra
    // bobina de ese color y espesor" que pide el propio mensaje del guardrail.
    const spare = await buyRoofingCoil(api, {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      weightKg: '2000',
    });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id, second.coil.id, spare.coil.id],
      purchaseIds: [scenario.purchaseId, second.purchaseId, spare.purchaseId],
      productionOrderIds: [],
      orderIds: [],
      quotationIds: [],
    };

    try {
      // Dos pedidos del mismo producto: 40 ML de planchas de 4 m y 30 ML de planchas de 6 m.
      const first = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows: pieces([4, 10]),
      });
      const other = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows: pieces([6, 5]),
      });
      trail.orderIds = [first.order.id, other.order.id];
      trail.quotationIds = [first.quotation.id, other.quotation.id];

      const opA = await roofingOrder(
        api,
        (await reservationsOf(api, first.order.id)).find((r) => r.status === 'ACTIVE')!.id,
      );
      const opB = await roofingOrder(
        api,
        (await reservationsOf(api, other.order.id)).find((r) => r.status === 'ACTIVE')!.id,
      );
      trail.productionOrderIds = [opA.id, opB.id];
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${opA.id}/coils`, {
        coilId: scenario.coil.id,
      });
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${opB.id}/coils`, {
        coilId: second.coil.id,
      });

      // La pantalla lee las dos filas de una sola consulta, con el plan ya resuelto.
      const rows = await batchRows(api);
      const rowA = rows.find((r) => r.orderId === opA.id)!;
      const rowB = rows.find((r) => r.orderId === opB.id)!;
      expect(rowA.planMeters).toBe('40.000');
      expect(rowA.reportedMeters).toBe('0.000');
      expect(rowA.remainingMeters).toBe('40.000');
      expect(rowA.remainingPieces).toEqual([{ lineNumber: 1, lengthMm: '4000.00', qty: 10 }]);
      expect(rowB.planMeters).toBe('30.000');

      // La hoja de planta: 16 m de la primera y 12 m de la segunda. Los largos no se
      // tipean — salen del plan de cada orden.
      const result = await postJson<{ orders: number; pieces: number; meters: string }>(
        api,
        '/api/production/roofing/batch',
        {
          rows: [
            { orderId: opA.id, meters: '16.000', consumedKg: '70.000' },
            { orderId: opB.id, meters: '12.000' },
          ],
        },
      );
      expect(result).toEqual({ orders: 2, pieces: 6, meters: '28.000' });

      // Kardex: 4 planchas de 4 m (64 kg) de la primera bobina y 2 de 6 m (48 kg) de la
      // segunda; el producto entra por los 28 m que salieron de las dos.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1936.000');
      expect((await balanceOf(api, 'COIL', second.coil.id)).qty).toBe('1952.000');
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('28.000');

      const after = await batchRows(api);
      expect(after.find((r) => r.orderId === opA.id)!.remainingMeters).toBe('24.000');
      expect(after.find((r) => r.orderId === opA.id)!.declaredKg).toBe('70.000');
      expect(after.find((r) => r.orderId === opB.id)!.remainingMeters).toBe('18.000');

      // El filtro por pedido acota a las órdenes de ese pedido y a ninguna más.
      const filtered = await batchRows(api, first.order.id);
      expect(filtered.map((r) => r.orderId)).toEqual([opA.id]);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-147: una fila que se pasa del tope deja la tanda entera sin escribir', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
    const second = await buyRoofingCoil(api, {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      weightKg: '2000',
    });
    // Una tercera bobina que nadie monta. D-134: un rollo montado sale **entero** del
    // disponible del agregado —no por los kilos asignados, sino el rollo completo—, así que
    // con solo dos bobinas el segundo montaje dejaría la promesa del otro pedido sin
    // material y el guardrail lo cortaría, que es lo correcto. Esta es exactamente la "otra
    // bobina de ese color y espesor" que pide el propio mensaje del guardrail.
    const spare = await buyRoofingCoil(api, {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      weightKg: '2000',
    });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id, second.coil.id, spare.coil.id],
      purchaseIds: [scenario.purchaseId, second.purchaseId, spare.purchaseId],
      productionOrderIds: [],
      orderIds: [],
      quotationIds: [],
    };

    try {
      const first = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows: pieces([4, 10]),
      });
      const other = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows: pieces([6, 5]),
      });
      trail.orderIds = [first.order.id, other.order.id];
      trail.quotationIds = [first.quotation.id, other.quotation.id];

      const opA = await roofingOrder(
        api,
        (await reservationsOf(api, first.order.id)).find((r) => r.status === 'ACTIVE')!.id,
      );
      const opB = await roofingOrder(
        api,
        (await reservationsOf(api, other.order.id)).find((r) => r.status === 'ACTIVE')!.id,
      );
      trail.productionOrderIds = [opA.id, opB.id];
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${opA.id}/coils`, {
        coilId: scenario.coil.id,
      });
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${opB.id}/coils`, {
        coilId: second.coil.id,
      });

      // Primera fila válida (16 de 40 ML); la segunda pide 36 sobre un plan de 30.
      const failed = await batchExpectingError(api, {
        rows: [
          { orderId: opA.id, meters: '16.000' },
          { orderId: opB.id, meters: '36.000' },
        ],
      });
      expect(failed.status).toBe(400);
      expect(failed.message).toContain('1 de 2 filas no entraron');
      // El error llega **por fila**, que es lo que la pantalla necesita para marcarla.
      expect(Object.keys(failed.errors)).toEqual([opB.id]);
      expect(failed.errors[opB.id]?.join(' ')).toContain('30.000 m pendientes');

      // **Lo que de verdad prueba el todo o nada:** la fila buena tampoco se escribió.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('2000.000');
      expect((await balanceOf(api, 'COIL', second.coil.id)).qty).toBe('2000.000');
      expect(await optionalBalanceOf(api, 'PRODUCT', scenario.product.id)).toBeNull();
      const rows = await batchRows(api);
      expect(rows.find((r) => r.orderId === opA.id)!.reportedMeters).toBe('0.000');

      // Corregida la fila mala, la misma tanda entra entera.
      const ok = await postJson<{ orders: number; meters: string }>(
        api,
        '/api/production/roofing/batch',
        {
          rows: [
            { orderId: opA.id, meters: '16.000' },
            { orderId: opB.id, meters: '30.000' },
          ],
        },
      );
      expect(ok).toMatchObject({ orders: 2, meters: '46.000' });
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('46.000');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-147: unos metros que no salen de un número entero de planchas se rechazan sin redondear', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
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
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows: pieces([4, 10]),
      });
      trail.orderIds = [order.id];
      trail.quotationIds = [quotation.id];
      const op = await roofingOrder(
        api,
        (await reservationsOf(api, order.id)).find((r) => r.status === 'ACTIVE')!.id,
      );
      trail.productionOrderIds = [op.id];
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/coils`, {
        coilId: scenario.coil.id,
      });

      // 10 m no salen de ninguna cantidad entera de planchas de 4 m. Media plancha no
      // existe, así que la fila se rechaza en vez de inventar un largo.
      const failed = await batchExpectingError(api, {
        rows: [{ orderId: op.id, meters: '10.000' }],
      });
      expect(failed.errors[op.id]?.join(' ')).toContain('no salen de un número entero de planchas');
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('2000.000');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-148: generar todas las órdenes de un pedido crea una por línea, y solo una vez', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '3000' });
    // Segunda cobertura a medida del mismo acabado y color: la segunda línea del pedido.
    const { product: other } = await createRoofingProduct(api, {
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
    });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id, other.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      productionOrderIds: [],
      orderIds: [],
      quotationIds: [],
    };

    try {
      const rowsA = pieces([4, 10]);
      const rowsB = pieces([6, 5]);
      const quotation = await postJson<{ id: string }>(api, '/api/sales/quotations', {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        issueDate: today(),
        items: [
          {
            productId: scenario.product.id,
            qty: metersOf(rowsA),
            unitPricePen: '30',
            pieces: rowsA,
          },
          { productId: other.id, qty: metersOf(rowsB), unitPricePen: '30', pieces: rowsB },
        ],
      });
      trail.quotationIds = [quotation.id];
      await postJson(api, `/api/sales/quotations/${quotation.id}/emit`);
      const order = await postJson<{ id: string }>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
        {},
      );
      trail.orderIds = [order.id];

      // Sin el botón, planta tiene que acordarse de crear una orden por línea. Con él, o
      // están las dos o no está ninguna: es una sola transacción.
      const created = await postJson<{
        created: { orderId: string; code: string }[];
        alreadyQueued: number;
      }>(api, `/api/production/roofing/from-sales-order/${order.id}`, {});
      expect(created.created).toHaveLength(2);
      expect(created.alreadyQueued).toBe(0);
      trail.productionOrderIds = created.created.map((c) => c.orderId);

      // Las órdenes son exactamente las que crea el botón de a una: nacen de su reserva,
      // `DRAFT` y sin bobina montada (montar es de planta, D-086), con el plan copiado.
      const first = await getJson<ProductionOrderDto>(
        api,
        `/api/production/${created.created[0]!.orderId}`,
      );
      expect(first.kind).toBe('ROOFING');
      expect(first.status).toBe('DRAFT');
      expect(first.reservationId).not.toBeNull();
      expect(first.consumptions).toHaveLength(0);
      expect(first.salesOrderId).toBe(order.id);

      // El ML a producir viaja en el DTO, que es lo que la tarjeta de planta muestra.
      const planned = created.created.map((c) => c.orderId);
      const listed = await getJson<{ id: string; planMeters: string | null }[]>(
        api,
        '/api/production?kind=ROOFING',
      );
      const mine = listed.filter((o) => planned.includes(o.id)).map((o) => o.planMeters);
      expect(mine.sort()).toEqual(['30.000', '40.000']);

      // Segunda vez: no duplica nada y lo dice.
      const again = await postExpectingError(
        api,
        `/api/production/roofing/from-sales-order/${order.id}`,
        {},
      );
      expect(again.status).toBe(400);
      expect(again.message).toContain('ya tienen su orden en cola');

      // D-149: la hoja que baja al taller. Se comprueba que el API devuelve un PDF real con
      // el nombre del pedido; el contenido lo dibuja `plant-order-pdf.ts`, que no calcula
      // nada y por eso no tiene un test aparte.
      const sheet = await api.get(`/api/sales/orders/${order.id}/pdf-planta`);
      expect(sheet.ok(), 'La hoja de planta debía descargarse').toBe(true);
      expect(sheet.headers()['content-type']).toContain('application/pdf');
      expect(sheet.headers()['content-disposition']).toContain('-planta.pdf');
      // `%PDF` es la firma del formato: sin esto, un cuerpo vacío pasaría el chequeo.
      expect((await sheet.body()).subarray(0, 4).toString()).toBe('%PDF');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});
