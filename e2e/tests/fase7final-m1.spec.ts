import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, postJson } from '../helpers/api';
import {
  balanceOf,
  createCuttingSupplier,
  postExpectingError,
  today,
  type ProductionOrderDto,
} from '../helpers/production';
import { createCustomer, stockPanel } from '../helpers/sales';
import {
  buyRoofingCoil,
  createColor,
  createRoofingFinish,
  createRoofingProduct,
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
 * Sesión 7-final, milestone M1 — la reserva genérica de materia prima (D-134).
 *
 * Lo que estos cinco casos protegen, en una línea: **una cobertura a medida promete kilos
 * del agregado compatible (línea + color + espesor ± tolerancia), nunca una bobina
 * concreta**; qué rollo cumple esa promesa lo decide planta al montar la OP, no el vendedor
 * al cotizar. Reusa el mismo escenario base que Fase 6 (`setupRoofingScenario`: color único
 * por corrida, densidad 8.0, 1 000 mm de ancho ⇒ 4 kg por metro lineal, comprobable a ojo).
 *
 * Todos los casos escriben (compras, cotizaciones, pedidos, producción): nunca contra
 * producción (regla dura 9, D-126). Corre contra la rama Neon `ci`, igual que `pnpm e2e`.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'M1 crea y anula compras, cotizaciones y producción: nunca contra producción (D-126, regla dura 9).',
);

/** El ciclo de los casos 2 y 5 son ~20 llamadas al API contra Neon. */
test.describe.configure({ timeout: 180_000 });

test.describe('M1 — reserva genérica de materia prima (D-134)', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('caso 1: cotizar una cobertura a medida sin elegir bobina deja una reserva RAW_MATERIAL por los kilos teóricos', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '500' });
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
      // 3 planchas de 5 m = 15 m. A 4 kg/m son 60.000 kg teóricos.
      const rows = pieces([5, 3]);
      expect(metersOf(rows)).toBe('15.000');

      // Ningún campo de la línea nombra una bobina: `quoteAndOrder` solo manda
      // `productId`, `qty` y `pieces` (D-134: `reserveFromCoilId`/`reserveKg` no existen).
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows,
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];

      const reservations = await reservationsOf(api, order.id);
      expect(reservations).toHaveLength(1);
      expect(reservations[0]).toMatchObject({
        itemType: 'RAW_MATERIAL',
        qty: '60.000',
        unit: 'KGM',
        status: 'ACTIVE',
      });
      // La reserva nombra el agregado (una fila de `raw_material_specs`), no la bobina.
      expect(reservations[0]!.itemId).not.toBe(scenario.coil.id);

      // Y la bobina física sigue intacta: nada se comprometió por ítem sobre ella.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('500.000');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('caso 2: la OP nacida de la reserva monta cualquier bobina del agregado, no una elegida de antemano, y la reserva genérica se drena al reportar', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '300' });
    // Segunda bobina del **mismo agregado** (mismo color y espesor): nadie la nombró al
    // cotizar ni la reservó — es justo la que este caso monta, para probar que "cualquiera
    // que cumpla" reemplazó a "la que el vendedor eligió" (D-134).
    const second = await buyRoofingCoil(api, {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      weightKg: '300',
    });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id, second.coil.id],
      purchaseIds: [scenario.purchaseId, second.purchaseId],
      productionOrderIds: [],
      orderIds: [],
      quotationIds: [],
    };

    try {
      const rows = pieces([5, 2]); // 10 m ⇒ 40 kg
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows,
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];

      const reservation = (await reservationsOf(api, order.id))[0]!;
      expect(reservation.itemType).toBe('RAW_MATERIAL');

      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];

      // Monta la SEGUNDA bobina — no la que compró primero el escenario, ni ninguna que la
      // cotización haya nombrado (no nombró ninguna). Cumple color y espesor, que es lo
      // único que el filtro exige.
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/coils`, {
        coilId: second.coil.id,
      });
      // La primera bobina del agregado no hizo falta tocarla: sigue con su saldo completo.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('300.000');

      const reported = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${op.id}/report`,
        { pieces: rows },
      );
      expect(reported.status).toBe('IN_PROGRESS');
      expect(reported.piecesReported).toBe(2);
      expect(reported.metersReported).toBe('10.000');

      // La reserva genérica se consumió exactamente por lo reportado (D-088/D-134).
      const afterReport = await reservationsOf(api, order.id);
      const onRawMaterial = afterReport.find((r) => r.itemType === 'RAW_MATERIAL')!;
      expect(onRawMaterial).toMatchObject({ qty: '0.000', status: 'CONSUMED' });
      const onProduct = afterReport.find((r) => r.itemType === 'PRODUCT')!;
      expect(onProduct).toMatchObject({ qty: '10.000', unit: 'MTR', status: 'ACTIVE' });

      // Y en el kardex, la que de verdad roló bajó sus kilos; la otra, ninguno.
      expect((await balanceOf(api, 'COIL', second.coil.id)).qty).toBe('260.000');
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('300.000');

      const closed = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${op.id}/close`,
        {},
      );
      expect(closed.status).toBe('CLOSED');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('caso 3: una merma que dejaría el agregado por debajo de lo reservado se bloquea (D-134)', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '100' });
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
      const rows = pieces([5, 2]); // 10 m ⇒ 40 kg prometidos
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows,
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];

      // Mermar 70 de 100 kg dejaría 30 kg físicos: menos que los 40 prometidos al pedido.
      const blocked = await postExpectingError(api, `/api/coils/${scenario.coil.id}/scrap`, {
        qtyKg: '70',
        reason: 'Merma que rompería la promesa genérica',
      });
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain(order.code);
      expect(blocked.message).toMatch(/kg prometidos a/);

      // El rechazo es antes de tocar el kardex: el saldo sigue completo.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('100.000');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('caso 4: una bobina de otro color no cuenta para el agregado: confirmar sin material del color correcto falla', async () => {
    const supplier = await createCuttingSupplier(api);
    const finish = await createRoofingFinish(api);
    const wantedColor = await createColor(api, '#c8102e');
    const otherColor = await createColor(api, '#0033a0');
    const { product } = await createRoofingProduct(api, {
      finishId: finish.id,
      colorId: wantedColor.id,
    });
    // La única bobina en stock es de OTRO color: el agregado del color pedido está en cero.
    const stray = await buyRoofingCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: otherColor.id,
      weightKg: '500',
    });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: wantedColor.id,
      productIds: [product.id],
      coilIds: [stray.coil.id],
      purchaseIds: [stray.purchaseId],
      quotationIds: [],
    };

    try {
      const rows = pieces([5, 2]); // 10 m ⇒ 40 kg que nadie tiene del color pedido
      const quotation = await postJson<{ id: string }>(api, '/api/sales/quotations', {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        issueDate: today(),
        items: [
          {
            productId: product.id,
            qty: metersOf(rows),
            unitPricePen: '30',
            pieces: rows,
          },
        ],
      });
      trail.quotationIds = [quotation.id];
      await postJson(api, `/api/sales/quotations/${quotation.id}/emit`);

      const error = await postExpectingError(api, `/api/sales/quotations/${quotation.id}/confirm`);
      expect(error.status).toBe(400);
      expect(error.message.toLowerCase()).toContain('color y espesor');
      expect(error.message).toContain('0.000');
    } finally {
      await purgeRoofingTrail(api, trail);
      await api
        .patch(`/api/colors/${otherColor.id}`, { data: { isActive: false } })
        .catch(() => undefined);
    }
  });

  test('caso 5: el panel de stock agrupa el agregado por espesor y color, y expone el disponible y el kg/m de un SKU a medida', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '500' });
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
    };

    try {
      const panel = await stockPanel(api, {
        businessLine: ROOFING_LINE,
        productIds: [scenario.product.id],
      });

      const group = panel.rawMaterial.find((g) => g.colorId === scenario.color.id);
      expect(group, 'el agregado del color de prueba tiene que aparecer en el panel').toBeDefined();
      // 500 kg físicos, nada reservado, y 500 / 4 kg-por-metro = 125 m teóricos.
      expect(group).toMatchObject({
        colorName: scenario.color.name,
        thicknessMm: '0.50',
        coils: 1,
        physicalKg: '500.000',
        reservedKg: '0.000',
        availableKg: '500.000',
        theoreticalMeters: '125.000',
      });

      const productRow = panel.products.find((p) => p.productId === scenario.product.id);
      expect(productRow, 'el SKU pedido por productIds tiene que venir en el panel').toBeDefined();
      expect(productRow).toMatchObject({
        rawMaterialAvailableKg: '500.000',
        kgPerMeter: '4.000',
      });
      expect(productRow?.rawMaterialLabel).toContain(scenario.color.name);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});
