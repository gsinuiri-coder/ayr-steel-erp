import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, postJson } from '../helpers/api';
import { balanceOf, type ProductionOrderDto } from '../helpers/production';
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
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('140.000');
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

      // Reportar los 10 ML tampoco avisa, y el kardex sale por los 40 kg teóricos.
      const reported = await reportPieces(api, op.id, { pieces: pieces([5, 2]) });
      expect(reported.rawMaterialWarnings ?? []).toEqual([]);
      expect((await lastActiveReport(api, op.id)).rawMaterialWarning).toBeNull();
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1960.000');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('con el pool de verdad corto, montar y reportar entran igual y avisan del pedido en riesgo', async () => {
    /**
     * Un faltante **real** exige que lo prometido a otros pedidos supere el físico libre, y
     * eso no se consigue montando: desde D-154 la custodia de una OP contra pedido no
     * descuenta nada, y confirmar un pedido ya se rechaza cuando el agregado no le alcanza.
     * Lo que sí saca kilos del pool sin ninguna promesa detrás es una corrida **a stock**
     * (D-140): nadie la encargó, así que su custodia es lo único que la representa.
     *
     * El escenario es entonces el que la decisión describe: planta pone a producir planchas
     * de catálogo con material que un pedido tenía prometido.
     *
     *   pool = bobina A 300 kg + bobina B 500 kg  =  800 kg
     *   prometido = pedido ajeno 500 kg + el nuestro 40 kg = 540  → los dos confirman
     *   la OP a stock monta la bobina B  → físico libre 300, prometido a terceros 500
     */
    const scenario = await setupRoofingScenario(api, { weightKg: '300' });
    const big = await buyRoofingCoil(api, {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      weightKg: '500',
    });
    // Plancha de catálogo del mismo color y espesor: es lo único que puede producirse a
    // stock (D-140), y por eso lo único que puede retener material sin haberlo prometido.
    const { product: sheet } = await createRoofingProduct(api, {
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      pieceLengthMm: '3000',
    });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id, sheet.id],
      coilIds: [scenario.coil.id, big.coil.id],
      purchaseIds: [scenario.purchaseId, big.purchaseId],
      productionOrderIds: [],
      orderIds: [],
      quotationIds: [],
    };

    try {
      const foreign = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows: pieces([5, 25]), // 125 ML = 500 kg, de otro pedido
      });
      const mine = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows: pieces([5, 2]), // 10 ML = 40 kg, el nuestro
      });
      trail.orderIds = [foreign.order.id, mine.order.id];
      trail.quotationIds = [foreign.quotation.id, mine.quotation.id];

      const op = await roofingOrder(
        api,
        (await reservationsOf(api, mine.order.id)).find((r) => r.status === 'ACTIVE')!.id,
      );
      trail.productionOrderIds = [op.id];

      // La corrida a stock se lleva la bobina de 500 kg. **Su custodia sí pesa** —no hay
      // pedido que la represente— así que el pool queda en los 300 kg de la otra bobina, y
      // este montaje ya avisa: entre los dos pedidos hay 540 kg prometidos.
      const stockOrder = await postJson<ProductionOrderDto>(api, '/api/production/roofing', {
        productId: sheet.id,
        targetPieces: 10,
      });
      trail.productionOrderIds = [op.id, stockOrder.id];
      const stockMounted = await mountCoil(api, stockOrder.id, { coilId: big.coil.id });
      expect(
        (stockMounted.rawMaterialWarnings ?? []).map((w) => w.orders.map((o) => o.code)).flat(),
      ).toContain(foreign.order.code);

      // Y ahora sí, montar en **nuestra** orden: entra (D-154) y avisa con la cuenta exacta.
      // Los 40 kg de nuestro propio pedido no aparecen en lo prometido: la promesa propia
      // nunca cuenta en contra de quien la viene a cumplir.
      const mounted = await mountCoil(api, op.id, { coilId: scenario.coil.id });
      const warning = (mounted.rawMaterialWarnings ?? [])[0];
      expect(warning, 'Montar debía avisar del pedido ajeno que queda sin material').toBeDefined();
      expect(warning!.freeKg).toBe('300.000');
      expect(warning!.promisedKg).toBe('500.000');
      expect(warning!.shortfallKg).toBe('200.000');
      expect(warning!.orders).toEqual([{ code: foreign.order.code, qtyKg: '500.000' }]);
      expect(warning!.label).toContain(scenario.color.name);
      expect(warning!.message).toContain('La operación se registró igual');
      // Y montó de verdad: el aviso no es un rechazo con otro nombre.
      expect(mounted.status).toBe('IN_PROGRESS');
      expect(mounted.assignedKg).toBe('300.000');
      // Un aviso por agregado, no uno por bobina.
      expect(mounted.rawMaterialWarnings).toHaveLength(1);

      // Reportar los 10 ML: mismo pedido en riesgo, y **el material se roló** — los 40 kg que
      // salen del pool lo dejan 40 más corto todavía.
      const reported = await reportPieces(api, op.id, {
        pieces: pieces([5, 2]),
        consumedKg: '42.000',
      });
      const reportWarning = (reported.rawMaterialWarnings ?? [])[0];
      expect(reportWarning, 'Reportar debía avisar del mismo pedido en riesgo').toBeDefined();
      expect(reportWarning!.orders.map((o) => o.code)).toContain(foreign.order.code);
      expect(reportWarning!.freeKg).toBe('260.000');
      expect(reportWarning!.shortfallKg).toBe('240.000');

      // El aviso queda **en la fila del reporte**: quien audita la corrida mira sus reportes,
      // no el `audit_log`.
      const report = await lastActiveReport(api, op.id);
      expect(report.rawMaterialWarning).not.toBeNull();
      expect(report.rawMaterialWarning).toContain(foreign.order.code);
      expect(report.rawMaterialWarning).toContain('faltan 240.000 kg');

      // Y el kardex se escribió: la bobina bajó por los 40 kg teóricos (10 ML × 4 kg/m), no
      // por los 42 declarados, y el producto entró por sus 10 m.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('260.000');
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('10.000');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});
