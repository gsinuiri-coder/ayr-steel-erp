import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, postJson } from '../helpers/api';
import {
  balanceOf,
  live,
  movementsOf,
  postExpectingError,
  type ProductionOrderDto,
} from '../helpers/production';
import { availabilityOf } from '../helpers/sales';
import {
  metersOf,
  pieces,
  purgeRoofingOrder,
  purgeRoofingTrail,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * D-140, la mitad que nunca se probó: **producir una plancha de catálogo a stock**.
 *
 * `fase6.spec.ts` cubre el rechazo ("una plancha de catálogo nunca se fabrica contra el
 * pedido; producí una orden a stock desde planta") y se detiene justo ahí, en la frase que
 * nombra la salida. La salida en sí —`POST /production/roofing` con `productId` +
 * `targetPieces`, sin reserva— no tenía ni un test que la recorriera, ni unitario (los de
 * `production` son de aritmética, con Prisma mockeado) ni E2E, así que el `CHECK` de la base
 * que la bloquea entera viajó desplegado sin que nadie lo notara.
 *
 * Lo que estos casos protegen, en una línea: **una corrida a stock nace sin pedido detrás,
 * rola contra la misma bobina que una corrida contra pedido, y lo que fabrica entra al
 * almacén como saldo libre** — sin reserva que lo ate a nadie, que es exactamente lo que
 * D-140 decidió (el pedido de catálogo espera ese saldo, no lo encarga).
 *
 * Misma aritmética a ojo que Fase 6: bobina de 1 000 mm × 0.50 mm con densidad 8.0 ⇒ 4 kg
 * por metro lineal, así que una plancha de 4 m son 16 kg.
 *
 * Todos los casos escriben (compras, bobinas, producción): nunca contra producción
 * (regla dura 9, D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea compras, bobinas y órdenes de producción: nunca contra producción (D-126, regla dura 9).',
);

/** El ciclo completo son ~30 llamadas al API; el timeout global no alcanza. */
test.describe.configure({ timeout: 240_000 });

test.describe('D-140 — orden de coberturas a stock, sin pedido detrás', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('ciclo completo a stock: crear sin reserva → montar → rolar → cerrar → saldo libre', async () => {
    // Plancha de catálogo de 4 m (`NIU`, largo fijo en el SKU desde D-122) y una bobina de
    // 2 000 kg del mismo color y espesor.
    const scenario = await setupRoofingScenario(api, {
      weightKg: '2000',
      pieceLengthMm: '4000',
    });
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      productionOrderIds: [],
    };

    try {
      expect(scenario.product.unit).toBe('NIU');

      // --- La orden nace del producto y de una meta, no de una reserva (D-140) ---
      const created = await postJson<ProductionOrderDto>(api, '/api/production/roofing', {
        productId: scenario.product.id,
        targetPieces: 5,
      });
      trail.productionOrderIds = [created.id];

      expect(created.kind).toBe('ROOFING');
      expect(created.status).toBe('DRAFT');
      expect(created.targetPieces).toBe(5);
      // Lo que la separa de una OP contra pedido: no cuelga de ningún pedido.
      expect(created.salesOrderId).toBeNull();
      expect(created.salesOrderCode).toBeNull();
      // El plan de corte sale del largo del SKU repetido hasta la meta, no de subítems.
      expect(created.items).toHaveLength(1);
      expect(created.items[0]).toMatchObject({ lengthMm: '4000.00', qty: 5 });

      // --- Montar la bobina: mismo camino que una corrida contra pedido ---
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${created.id}/coils`, {
        coilId: scenario.coil.id,
      });
      // Montar es custodia, no consumo (D-060).
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('2000.000');

      // --- Rolar: 5 planchas de 4 m = 20 m ⇒ 80 kg teóricos ---
      const rows = pieces([4, 5]);
      expect(metersOf(rows)).toBe('20.000');
      const reported = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${created.id}/report`,
        { pieces: rows },
      );
      expect(reported.status).toBe('IN_PROGRESS');
      expect(reported.piecesReported).toBe(5);
      const report = reported.reports.find((r) => r.status === 'ACTIVE')!;
      expect(report.theoreticalKg).toBe('80.800');

      // El kardex: 80 kg salen de la bobina y 5 planchas entran al producto.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1919.200');
      const productAfterReport = await balanceOf(api, 'PRODUCT', scenario.product.id);
      expect(productAfterReport.qty).toBe('5.000');
      expect(productAfterReport.unit).toBe('NIU');
      // 80 kg a S/ 5 = S/ 400 sobre 5 planchas ⇒ S/ 80 cada una.
      expect(productAfterReport.avgCost).toBe('80.8000');

      // **El corazón de D-140**: sin pedido detrás no hay promesa que trasladar (D-088), así
      // que las planchas entran como **saldo libre**. Es lo que hace que el pedido de
      // catálogo que estaba esperando pueda reservarlas después.
      const availability = await availabilityOf(api, 'PRODUCT', scenario.product.id);
      expect(availability.reservedQty).toBe('0.000');
      expect(availability.availableQty).toBe('5.000');

      // --- Cerrar declarando el consumo real: la diferencia es despunte (D-089) ---
      const closed = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${created.id}/close`,
        { consumedKg: '83.000' },
      );
      expect(closed.status).toBe('CLOSED');
      expect(closed.scrapKg).toBe('2.200');
      // 83 kg a S/ 5 = S/ 415 sobre 5 planchas ⇒ S/ 83 cada una.
      expect(closed.materialCostPen).toBe('415.0000');
      expect(closed.unitCostPen).toBe('83.0000');
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1917.000');

      // El kardex de la bobina, de punta a punta: compra, rolado y despunte.
      const coilMovements = live(await movementsOf(api, 'COIL', scenario.coil.id));
      expect(coilMovements.map((m) => `${m.type}:${m.refType}`)).toEqual([
        'IN:PURCHASE',
        'OUT:PRODUCTION',
        'OUT:SCRAP',
      ]);

      // Y el saldo sigue libre después del cierre: nada lo reservó por el camino.
      const afterClose = await availabilityOf(api, 'PRODUCT', scenario.product.id);
      expect(afterClose.reservedQty).toBe('0.000');
      expect(afterClose.availableQty).toBe('5.000');
      // El cierre también ajusta el costo del producto: los 3 kg de despunte (S/ 15) se
      // reparten sobre las 5 planchas, así que el promedio pasa de 80 a 83.
      const productAfterClose = await balanceOf(api, 'PRODUCT', scenario.product.id);
      expect(productAfterClose.avgCost).toBe('83.0000');
      const productMovements = live(await movementsOf(api, 'PRODUCT', scenario.product.id));
      expect(productMovements.map((m) => `${m.type}:${m.refType}`)).toEqual([
        'IN:PRODUCTION',
        'ADJUST:PRODUCTION',
      ]);

      // --- La reversa completa, comprobada y no tragada ---
      //
      // `purgeRoofingTrail` envuelve cada paso en un `catch` silencioso porque es limpieza de
      // `finally`. Pero reopen → reverseReport → cancel sobre una OP **sin reserva** son
      // justo las rutas que este flujo estrena, y son las que más fácil asumirían una reserva
      // que acá no existe: dejarlas correr sin mirar el resultado las daría por buenas aunque
      // se rompieran. Así que acá se corren **dentro del `try`, sin `catch`**, y se comprueba
      // que devolvieron todo a cero.
      await purgeRoofingOrder(api, created.id);
      trail.productionOrderIds = [];
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('2000.000');
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('0.000');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('una cobertura a medida no tiene camino a stock: sin pedido no hay largo que fabricar', async () => {
    // Sin `pieceLengthMm` el producto es a medida (`MTR`, sin largo fijo).
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
      expect(scenario.product.unit).toBe('MTR');

      const rejected = await postExpectingError(api, '/api/production/roofing', {
        productId: scenario.product.id,
        targetPieces: 3,
      });
      expect(rejected.status).toBe(400);
      expect(rejected.message).toContain('es una cobertura a medida');
      expect(rejected.message).toContain('no tiene largo fijo para producir a stock');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});
