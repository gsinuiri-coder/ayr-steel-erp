import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, postJson } from '../helpers/api';
import { balanceOf, today, type ProductionOrderDto } from '../helpers/production';
import { createCustomer } from '../helpers/sales';
import {
  buyRoofingCoil,
  createRoofingProduct,
  lastActiveReport,
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
 * El agregado de materia prima en producción de coberturas: **avisa, no bloquea** (D-154).
 *
 * D-134 puso la promesa de una cobertura a medida contra el **agregado** (línea + color +
 * espesor) y colgó de él un guardrail que rechazaba cualquier operación que lo dejara por
 * debajo de lo prometido. En producción eso salió mal por dos motivos distintos, y cada test
 * de acá cubre uno:
 *
 * 1. **La promesa del propio pedido contaba en contra.** Un pedido de coberturas tiene una
 *    reserva por línea y una OP por reserva, así que montar la bobina de la línea 1 se
 *    comprobaba contra la promesa —viva y del mismo pedido— de la línea 2 y se rechazaba con
 *    "hay 120.000 kg prometidos a PED-0000NN": el pedido que planta estaba fabricando.
 * 2. **La custodia de una OP contra pedido se contaba dos veces.** El compromiso de esa orden
 *    ya está contado como reserva genérica sobre la spec; descontar además el rollo montado
 *    era restar el mismo kilo dos veces, y por eso montar los 2 000 kg de un rollo para rolar
 *    400 dejaba el pool en cero sobre un almacén intacto. Hoy `heldKg` es **0** cuando la
 *    orden tiene reserva, y sigue siendo `assignedKg − consumedKg` solo en una corrida **a
 *    stock** (D-140), que no tiene ninguna promesa que la represente.
 *
 * Y cuando el faltante es real —material que de verdad no alcanza para un pedido **ajeno**—
 * la operación entra igual y el aviso viaja en la respuesta (`rawMaterialWarnings`) y queda
 * anotado en el reporte (`rawMaterialWarning`). Cortarle la corrida al operario de la
 * roladora era pedirle que anulara el pedido de otro cliente o liberara su reserva: dos cosas
 * que no puede hacer, y el resultado medido fue material rolado que nunca se registró.
 *
 * Aritmética a ojo, la de Fase 6: 1 000 mm × 0.50 mm con densidad 8.0 ⇒ 4 kg por metro
 * lineal. 40 ML son 160 kg; 50 ML, 200 kg.
 *
 * Escribe (compras, bobinas, pedidos, producción): nunca contra producción (regla dura 9).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea compras, bobinas, pedidos y órdenes de producción: nunca contra producción (D-126, regla dura 9).',
);

test.describe.configure({ timeout: 240_000 });

test.describe('D-154 — el faltante del agregado avisa y no bloquea', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('la promesa de la línea hermana del mismo pedido no bloquea ni avisa', async () => {
    // Bobina de 300 kg para un pedido que promete 280: alcanza justo, que es el escenario en
    // el que la promesa propia contando en contra se vuelve un rechazo seguro.
    const scenario = await setupRoofingScenario(api, { weightKg: '300' });
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
      // Un pedido, dos líneas a medida del mismo color y espesor: 40 ML (160 kg) y 30 ML
      // (120 kg). Las dos prometen contra el **mismo** agregado.
      const { quotation, order } = await quoteAndOrderLines(api, {
        customerId: customer.id,
        lines: [
          { productId: scenario.product.id, rows: pieces([4, 10]) },
          { productId: other.id, rows: pieces([6, 5]) },
        ],
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];

      const reservations = (await reservationsOf(api, order.id)).filter(
        (r) => r.status === 'ACTIVE',
      );
      expect(reservations, 'El pedido debía dejar una reserva por línea').toHaveLength(2);

      const created = await roofingOrdersFromSalesOrder(api, order.id);
      expect(created.created).toHaveLength(2);
      trail.productionOrderIds = created.created.map((c) => c.orderId);
      const opA = created.created[0]!.orderId;

      // **El defecto que esta sesión vino a arreglar.** Antes de D-154 esto devolvía 400
      // ("hay 120.000 kg prometidos a PED-0000NN") citando el propio pedido del que la orden
      // nació: la promesa de la línea hermana bloqueaba a su gemela.
      const mounted = await mountCoil(api, opA, { coilId: scenario.coil.id });
      expect(mounted.rawMaterialWarnings ?? []).toEqual([]);
      expect(mounted.consumptions.filter((c) => c.releasedAt === null)).toHaveLength(1);

      // Y reportar el plan entero de esa línea tampoco avisa: los 120 kg que la hermana sigue
      // prometiendo son del mismo pedido y no cuentan en contra en ningún punto del camino.
      const reported = await reportPieces(api, opA, { pieces: pieces([4, 10]) });
      expect(reported.rawMaterialWarnings ?? []).toEqual([]);
      expect(reported.metersReported).toBe('40.000');
      expect((await lastActiveReport(api, opA)).rawMaterialWarning).toBeNull();

      // El kardex salió por los 160 kg teóricos: 300 − 160.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('138.400');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('montar el rollo entero en una orden con reserva no saca nada del pool: sigue sano y no avisa', async () => {
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
      // Un pedido **ajeno** con promesa viva de 200 kg (50 ML) contra el mismo agregado.
      const foreign = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows: pieces([5, 10]),
      });
      // Y el nuestro, chico: 10 ML = 40 kg.
      const mine = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows: pieces([5, 2]),
      });
      trail.orderIds = [foreign.order.id, mine.order.id];
      trail.quotationIds = [foreign.quotation.id, mine.quotation.id];

      const op = await roofingOrder(
        api,
        (await reservationsOf(api, mine.order.id)).find((r) => r.status === 'ACTIVE')!.id,
      );
      trail.productionOrderIds = [op.id];

      // Se monta el rollo **entero** de 2 000 kg para rolar 40, que es exactamente lo que la
      // pantalla hace: `/planta` manda solo el `coilId` y el API asigna todo el
      // saldo. **D-154:** el compromiso de esta orden ya está contado como la reserva
      // genérica de su pedido, así que su custodia no descuenta nada y quedan 2 000 kg libres
      // contra los 200 prometidos al pedido ajeno. Antes, el rollo salía entero del agregado
      // —el mismo kilo restado dos veces— y esto era un 400 sobre un almacén lleno.
      const mounted = await mountCoil(api, op.id, { coilId: scenario.coil.id });
      expect(mounted.rawMaterialWarnings ?? []).toEqual([]);
      expect(mounted.assignedKg).toBe('2000.000');

      // Reportar los 10 ML tampoco avisa, y el kardex sale por los 40.4 kg teóricos (D-165).
      const reported = await reportPieces(api, op.id, { pieces: pieces([5, 2]) });
      expect(reported.rawMaterialWarnings ?? []).toEqual([]);
      expect((await lastActiveReport(api, op.id)).rawMaterialWarning).toBeNull();
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1959.600');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('cc38: rolar de más ya no se puede (ampliar el plan de la plancha y reportar de más se rechazan) y el pool sigue sano', async () => {
    /**
     * Un faltante **real** exige que lo prometido a otros pedidos supere el físico libre, y
     * eso no se consigue montando: desde D-154 la custodia de una OP contra pedido no
     * descuenta nada, y confirmar un pedido ya se rechaza cuando el agregado no le alcanza.
     * Hace falta algo que **saque kilos del pool sin una promesa de materia prima detrás**.
     *
     * **Ese algo cambió con D-171 y hubo que buscarlo de nuevo.** Hasta acá era una corrida
     * **a stock** de planchas de catálogo (D-140): nadie la encargaba, así que su custodia era
     * lo único que la representaba. D-171 cerró esa puerta —toda cobertura se rola contra el
     * pedido que reserva su material—. Vender la bobina entera (RF-73) tampoco sirve, y eso se
     * comprobó: `createReservations` corre la invariante y **rechaza** la venta que dejaría el
     * agregado por debajo de lo prometido, que es exactamente lo que debe hacer.
     *
     * Lo que queda, y es lo más realista de los tres, es **rolar de más**: el techo se mide en
     * obra, planta amplía el plan de corte (D-084) y la corrida se lleva más material del que
     * su pedido había prometido. Los kilos que exceden la reserva salen del pool sin nada que
     * los respalde, y ahí es donde D-154 tiene que avisar en vez de bloquear — porque el rollo
     * ya se cortó y el hecho hay que poder anotarlo.
     *
     *   pool = bobina A 300 kg + bobina B 500 kg  =  800 kg
     *   prometido = pedido ajeno 505 kg + el nuestro 2 × 40.4 kg  → los dos confirman
     *   la orden de la línea 1 amplía su plan a 100 ML y rola 404 kg de la bobina B
     *     → físico 396, prometido a terceros 505, faltan 109
     */
    // cc35 (D-545): a medida el plan ya no crece (mismos metros); rolar de más solo se puede en una
    // plancha de catálogo, que ajusta su cantidad. Planchas de 5 m: las mismas cuentas en kg.
    const scenario = await setupRoofingScenario(api, { weightKg: '300', pieceLengthMm: '5000' });
    const big = await buyRoofingCoil(api, {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      weightKg: '500',
    });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id, big.coil.id],
      purchaseIds: [scenario.purchaseId, big.purchaseId],
      productionOrderIds: [],
      orderIds: [],
      quotationIds: [],
    };

    try {
      const foreign = await quoteCatalog(api, customer.id, [
        { productId: scenario.product.id, qty: '25' }, // 25 × 5 m = 125 ML = 505 kg, de otro pedido
      ]);
      // El nuestro, con **dos líneas** de 10 ML: la primera es la que se pasa de rosca y la
      // segunda es la que después monta con el pool ya corto.
      const mine = await quoteCatalog(api, customer.id, [
        { productId: scenario.product.id, qty: '2' },
        { productId: scenario.product.id, qty: '2' },
      ]);
      trail.orderIds = [foreign.order.id, mine.order.id];
      trail.quotationIds = [foreign.quotation.id, mine.quotation.id];

      const mineReservations = (await reservationsOf(api, mine.order.id)).filter(
        (r) => r.status === 'ACTIVE',
      );
      expect(mineReservations).toHaveLength(2);
      const first = await roofingOrder(api, mineReservations[0]!.id);
      trail.productionOrderIds = [first.id];

      // Montar la bobina de 500 kg **no** avisa: el pool sigue sano (800 libres contra 505
      // prometidos a terceros) y la custodia de una orden con pedido detrás no descuenta nada.
      const mountedFirst = await mountCoil(api, first.id, { coilId: big.coil.id });
      expect(mountedFirst.rawMaterialWarnings ?? []).toEqual([]);

      // cc38 (D-574): rolar de más ya no se puede. Ampliar el plan de la plancha de 2 a 20
      // planchas se rechaza (el ajuste exige los mismos metros, también en catálogo), y un
      // reporte que pase el plan también: el pool no queda corto por esta vía. El aviso de D-154
      // al reportar sigue cubierto por `raw-material.spec.ts`.
      const widened = await api.put(`/api/production/roofing/${first.id}/plan`, {
        data: { items: pieces([5, 20]) },
      });
      expect(widened.status()).toBe(400);
      expect(((await widened.json()) as { message: string }).message).toContain('sobran 90.000 m');
      const over = await api.post(`/api/production/roofing/${first.id}/report`, {
        data: { pieces: pieces([5, 20]) },
      });
      expect(over.status()).toBe(400);
      expect(((await over.json()) as { message: string }).message).toBe(
        'Excede el plan en 90.000 m · ajusta el plan',
      );
      // Nada se roló: la bobina B sigue entera.
      expect((await balanceOf(api, 'COIL', big.coil.id)).qty).toBe('500.000');

      // Montar la orden de la línea 2 entra sin aviso: el pool sigue sano.
      const second = await roofingOrder(api, mineReservations[1]!.id);
      trail.productionOrderIds = [first.id, second.id];
      const mountedSecond = await mountCoil(api, second.id, { coilId: scenario.coil.id });
      expect(mountedSecond.rawMaterialWarnings ?? []).toEqual([]);
      expect(mountedSecond.status).toBe('IN_PROGRESS');
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('300.000');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});

/** cc35: un pedido de planchas de catálogo (cantidad en unidades, sin desglose de largos). */
async function quoteCatalog(
  api: APIRequestContext,
  customerId: string,
  lines: { productId: string; qty: string }[],
) {
  const quotation = await postJson<{ id: string }>(api, '/api/sales/quotations', {
    customerId,
    issueDate: today(),
    items: lines.map((l) => ({ productId: l.productId, qty: l.qty, unitPricePen: '200' })),
  });
  const order = await postJson<{ id: string; code: string }>(
    api,
    `/api/sales/quotations/${quotation.id}/confirm`,
    {},
  );
  return { quotation, order };
}
