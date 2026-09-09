import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getJson } from '../helpers/api';
import { balanceOf, postExpectingError, type ProductionOrderDto } from '../helpers/production';
import { createCustomer } from '../helpers/sales';
import {
  batchOrders,
  buyRoofingCoil,
  createRoofingProduct,
  lastActiveReport,
  metersOf,
  mountCoil,
  pieces,
  purgeRoofingTrail,
  quoteAndOrder,
  quoteAndOrderLines,
  reportPieces,
  reservationsOf,
  roofingOrder,
  roofingOrdersFromSalesOrder,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * Integridad de producción de coberturas y guardado **por orden**: D-146, D-148 y D-155.
 *
 * Reemplaza a `planta-tanda.spec.ts`. La tanda de D-147 —`POST /production/roofing/batch`,
 * N órdenes en un envío todo-o-nada— dejó de existir con D-155: el espacio de producción del
 * pedido guarda **orden por orden** con los endpoints de siempre (`:id/coils`,
 * `:id/coils/:consumptionId/release`, `:id/report`), y lo único que sobrevive de aquella
 * pantalla es la **lectura** `GET /production/roofing/batch`, que ahora trae por orden su
 * `reservationId` y, por bobina montada, `consumptionId` y `consumedKg`.
 *
 * Lo que estos casos protegen:
 *
 * - **D-146**: el acumulado reportado de una orden nunca pasa el ML de su plan, sin
 *   tolerancia. Ese tope sigue siendo **duro** y sigue devolviendo 400.
 * - **D-146 corregido por D-154**: el kg que planta declara se guarda pero no toca el kardex
 *   (que sale por el teórico, D-047), y pasarse del kilo teórico del plan **ya no se
 *   rechaza**: entra y queda anotado como aviso en el reporte.
 * - **D-155**: dos órdenes se guardan una por una, cada una atómica por su cuenta, y la
 *   lectura de la pantalla las describe sin pedir el detalle de cada orden.
 * - **D-148**: generar las órdenes de un pedido de una vez no crea órdenes distintas de las
 *   que crea el botón de a una.
 *
 * El reparto ML→largos (`piecesFromPlanMeters`) ya no lo hace el API: desde D-155 lo resuelve
 * la pantalla y manda los largos. Su cobertura vive en `planta-producir-ui.spec.ts`.
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

test.describe('D-146/D-155 — tope del plan y guardado por orden', () => {
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
      await mountCoil(api, op.id, { coilId: scenario.coil.id });

      // 8 planchas de 4 m = 32 ML: entra, quedan 8.
      await reportPieces(api, op.id, { pieces: pieces([4, 8]) });

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
      const complete = await reportPieces(api, op.id, { pieces: pieces([4, 2]) });
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

  test('D-146/D-154: el kg declarado se guarda, el kardex sale por el teórico y pasarse del plan avisa en vez de rechazar', async () => {
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
      await mountCoil(api, op.id, { coilId: scenario.coil.id });

      // 4 planchas de 4 m: 16 ML, 64 kg teóricos. Planta declara 70 —el despunte real—, que
      // está dentro de la banda de ±10 % y por eso no deja aviso de desviación.
      const reported = await reportPieces(api, op.id, {
        pieces: pieces([4, 4]),
        consumedKg: '70.000',
      });
      const first = reported.reports.find((r) => r.status === 'ACTIVE')!;
      expect(first.theoreticalKg).toBe('64.000');
      expect(first.consumedKg).toBe('70.000');
      expect(first.rawMaterialWarning).toBeNull();
      // **Lo que decide la decisión:** salieron 64 kg, no 70. El consumo real se reconcilia
      // al cerrar (D-089); el kg declarado es dato de planta, no un movimiento.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1936.000');

      // D-154: por encima del kilo teórico del plan (40 ML × 4 kg/m = 160 kg) **entra igual**.
      // Como tope duro, D-146 convertía el dato observado en un dato que había que falsear
      // para poder guardarlo: una corrida que de verdad gastó de más no se podía anotar.
      const over = await reportPieces(api, op.id, {
        pieces: pieces([4, 2]),
        consumedKg: '120.000',
      });
      const second = await lastActiveReport(api, op.id);
      expect(second.consumedKg).toBe('120.000');
      expect(second.theoreticalKg).toBe('32.000');
      // Y queda anotado: 120 kg declarados contra 32 teóricos, y 190 acumulados sobre 160.
      expect(second.rawMaterialWarning).not.toBeNull();
      expect(second.rawMaterialWarning).toContain('Consumo declarado 120.000 kg');
      expect(second.rawMaterialWarning).toContain('160.000 kg');

      // El aviso es del kilo declarado, no del agregado: no hay ningún pedido en riesgo.
      expect(over.rawMaterialWarnings ?? []).toEqual([]);
      // Y el kardex siguió saliendo por el teórico de los largos: 1936 − 32.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1904.000');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-155: dos órdenes se montan y se guardan una por una, y la lectura del espacio de producción las describe', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
    const second = await buyRoofingCoil(api, {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      weightKg: '2000',
    });
    // Una tercera bobina que nadie monta: deja el agregado holgado para las promesas de los
    // **otros** pedidos, así el camino feliz queda sin avisos de D-154 (que no bloquean, pero
    // ensuciarían la lectura de lo que este caso vino a probar).
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

      // Montar es de planta y ahora se hace desde la propia pestaña (D-155), una orden a la vez.
      const mountedA = await mountCoil(api, opA.id, { coilId: scenario.coil.id });
      const mountedB = await mountCoil(api, opB.id, { coilId: second.coil.id });
      expect(mountedA.rawMaterialWarnings ?? []).toEqual([]);
      expect(mountedB.rawMaterialWarnings ?? []).toEqual([]);

      // La pantalla lee las dos pestañas de una sola consulta, con el plan ya resuelto y —lo
      // que D-155 agregó— la reserva de la orden y la asignación de cada bobina montada.
      const rows = await batchOrders(api);
      const rowA = rows.find((r) => r.orderId === opA.id)!;
      const rowB = rows.find((r) => r.orderId === opB.id)!;
      expect(rowA.planMeters).toBe('40.000');
      expect(rowA.reportedMeters).toBe('0.000');
      expect(rowA.remainingMeters).toBe('40.000');
      expect(rowA.remainingPieces).toEqual([{ lineNumber: 1, lengthMm: '4000.00', qty: 10 }]);
      expect(rowA.reservationId).not.toBeNull();
      expect(rowA.salesOrderId).toBe(first.order.id);
      expect(rowA.coils).toHaveLength(1);
      expect(rowA.coils[0]!.coilCode).toBe(scenario.coil.code);
      expect(rowA.coils[0]!.consumptionId).toEqual(expect.any(String));
      expect(rowA.coils[0]!.consumedKg).toBe('0.000');
      expect(rowB.planMeters).toBe('30.000');

      // El guardado es **por orden**: 16 m de la primera y 12 m de la segunda, cada uno con su
      // propia transacción. Los largos salen del plan; la pantalla los reparte antes de mandar.
      await reportPieces(api, opA.id, { pieces: pieces([4, 4]), consumedKg: '70.000' });
      await reportPieces(api, opB.id, { pieces: pieces([6, 2]) });

      // Kardex: 4 planchas de 4 m (64 kg) de la primera bobina y 2 de 6 m (48 kg) de la
      // segunda; el producto entra por los 28 m que salieron de las dos.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1936.000');
      expect((await balanceOf(api, 'COIL', second.coil.id)).qty).toBe('1952.000');
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('28.000');

      const after = await batchOrders(api);
      const afterA = after.find((r) => r.orderId === opA.id)!;
      expect(afterA.remainingMeters).toBe('24.000');
      expect(afterA.declaredKg).toBe('70.000');
      expect(afterA.reportedKg).toBe('64.000');
      // La bobina que ya roló no se puede bajar, y la pestaña lo sabe por este número.
      expect(afterA.coils[0]!.consumedKg).toBe('64.000');
      expect(afterA.coils[0]!.remainingKg).toBe('1936.000');
      expect(after.find((r) => r.orderId === opB.id)!.remainingMeters).toBe('18.000');

      // El filtro por pedido acota a las órdenes de ese pedido y a ninguna más: es lo que
      // `/planta/producir?pedido=…` abre.
      const filtered = await batchOrders(api, first.order.id);
      expect(filtered.map((r) => r.orderId)).toEqual([opA.id]);

      // D-155: la tanda ya no existe como escritura. El endpoint se retiró entero, no quedó
      // como alias — si volviera, volvería con él el guardado todo-o-nada que obligaba a
      // rehacer las ocho filas cuando la séptima tenía un número mal tipeado.
      const gone = await api.post('/api/production/roofing/batch', {
        data: { rows: [{ orderId: opA.id, meters: '4.000' }] },
      });
      expect(gone.status(), 'POST /production/roofing/batch debía haber desaparecido').toBe(404);
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
      const { quotation, order } = await quoteAndOrderLines(api, {
        customerId: customer.id,
        lines: [
          { productId: scenario.product.id, rows: pieces([4, 10]) },
          { productId: other.id, rows: pieces([6, 5]) },
        ],
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];

      // Sin el botón, planta tiene que acordarse de crear una orden por línea. Con él, o
      // están las dos o no está ninguna: es una sola transacción.
      const created = await roofingOrdersFromSalesOrder(api, order.id);
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
