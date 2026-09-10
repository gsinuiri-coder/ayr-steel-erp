import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getJson, postJson } from '../helpers/api';
import { optionalBalanceOf, postExpectingError } from '../helpers/production';
import {
  purgeRoofingTrail,
  reservationsOf,
  roofingOrder,
  setupRoofingScenario,
} from '../helpers/roofing';
import { createCustomer, createQuotationWithLines, type QuotationDto } from '../helpers/sales';

/**
 * **La orden de coberturas a stock: el archivo que probaba D-140 y ahora prueba que no existe.**
 *
 * Historia en tres líneas, porque es lo que explica por qué este archivo dice lo contrario de
 * lo que decía:
 *
 * 1. **D-140** decidió que una plancha de catálogo se vendía del almacén y se reponía con una
 *    corrida **a stock** (`productId` + `targetPieces`, sin reserva). Este archivo nació para
 *    recorrer esa corrida, que no tenía ni un test.
 * 2. **D-171 revirtió D-140**: una plancha no es stock terminado esperando en el almacén, es un
 *    largo fijo que la roladora corta cuando alguien la pide. Toda línea de coberturas reserva
 *    materia prima y se produce contra el pedido.
 * 3. Y con eso, **producir a stock dejó de existir**: `create` sin `reservationId` responde 400.
 *
 * **Por qué la puerta se cierra en vez de dejarse entreabierta.** Si además se pudiera producir
 * a stock, quedaría un saldo de producto terminado que ningún pedido consume nunca —cada uno
 * reserva su materia prima y rola lo suyo— y ese saldo envejecería en el inventario valorizado
 * sin que nadie pudiera venderlo. Reabrirla exige decidir antes qué hace una línea de pedido
 * cuando ese saldo existe (¿lo toma?, ¿lo ignora?, ¿lo toma hasta donde alcanza y produce el
 * resto?), y esa pregunta hoy no tiene respuesta. `createToStock` sigue en el archivo del
 * servicio, sin llamadores, para que reabrirla sea volver a enchufarla y no volver a escribirla.
 *
 * Lo que estos casos protegen, entonces: **que la puerta esté cerrada por el camino y no por el
 * producto** —los dos subtipos rebotan igual, y ninguno deja rastro— y **que la ruta que la
 * reemplazó esté abierta**, porque cerrar una sin la otra dejaría a planta sin forma de fabricar
 * nada. El ciclo completo contra el pedido vive en `plancha-contra-pedido-d171.spec.ts`.
 *
 * Todos los casos escriben (compras, bobinas, pedidos): nunca contra producción
 * (regla dura 9, D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea compras, bobinas y pedidos: nunca contra producción (D-126, regla dura 9).',
);

test.describe.configure({ timeout: 180_000 });

/**
 * Órdenes de producción de un producto, para comprobar que un rechazo no dejó ninguna.
 * `GET /production` devuelve un array plano (no está paginado, D-113 no lo alcanzó).
 */
async function productionOrdersOf(
  api: APIRequestContext,
  productId: string,
): Promise<{ id: string; status: string }[]> {
  return getJson<{ id: string; status: string }[]>(api, `/api/production?productId=${productId}`);
}

test.describe('D-171 — producir coberturas a stock dejó de existir', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('una plancha de catálogo ya no se produce a stock: el rechazo nombra la decisión y la salida', async () => {
    /**
     * **Este caso recorría la corrida a stock completa hasta D-171** —crear sin reserva,
     * montar, rolar, cerrar, saldo libre— y todo eso desapareció con la ruta. Lo que queda es
     * la afirmación contraria, sobre exactamente el mismo escenario: la plancha de 4 m y la
     * bobina que la iba a dar.
     */
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
    };

    try {
      expect(scenario.product.unit).toBe('NIU');

      const rejected = await postExpectingError(api, '/api/production/roofing', {
        productId: scenario.product.id,
        targetPieces: 5,
      });
      expect(rejected.status).toBe(400);
      expect(rejected.message).toContain('Una cobertura no se produce a stock');
      // El mensaje tiene que nombrar **la salida**, no solo la prohibición: quien está en
      // planta necesita saber qué hacer, y lo que hay que hacer es confirmar el pedido.
      expect(rejected.message).toContain('se fabrica contra el pedido que reserva su material');
      expect(rejected.message).toContain('Confirmá el pedido y producí desde su reserva');

      // Y no dejó rastro: ni orden, ni saldo de producto inventado, ni movimiento en la bobina.
      expect(await productionOrdersOf(api, scenario.product.id)).toEqual([]);
      expect(await optionalBalanceOf(api, 'PRODUCT', scenario.product.id)).toBeNull();
      expect((await optionalBalanceOf(api, 'COIL', scenario.coil.id))?.qty).toBe('2000.000');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('una cobertura a medida rebota por el mismo motivo: la puerta se cierra por el camino, no por el producto', async () => {
    /**
     * **Este caso también cambió de motivo.** Bajo D-140 el a-medida se rechazaba *más
     * adentro*, con «es una cobertura a medida … no tiene largo fijo para producir a stock»:
     * la ruta existía y este producto no calificaba. Desde D-171 la ruta no existe para nadie,
     * así que el rechazo llega antes y es el mismo para los dos subtipos.
     *
     * La diferencia importa: un mensaje que hablara del largo fijo mandaría a alguien a
     * cargarle un largo al SKU a medida —que es justo lo que D-127 le prohíbe— para conseguir
     * una ruta que ya no está.
     */
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
      expect(rejected.message).toContain('Una cobertura no se produce a stock');
      // Y **no** el motivo viejo: nadie tiene que salir de acá pensando que le falta un largo.
      expect(rejected.message).not.toContain('largo fijo');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('la ruta que la reemplazó está abierta: la OP nace de la reserva del pedido', async () => {
    /**
     * El contrapeso de los dos casos de arriba. Cerrar la puerta vieja sin comprobar que la
     * nueva abre dejaría un sistema en el que planta no puede fabricar nada, y los dos rechazos
     * de arriba seguirían verdes igual.
     */
    const scenario = await setupRoofingScenario(api, {
      weightKg: '2000',
      pieceLengthMm: '4000',
    });
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
      const quotation = await createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: 'metallic-roofing',
        items: [{ productId: scenario.product.id, qty: '5', valuePerMeterPen: '60.0000' }],
      });
      trail.quotationIds = [quotation.id];
      await postJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}/emit`);
      const order = await postJson<{ id: string }>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
        {},
      );
      trail.orderIds = [order.id];

      const reservation = (await reservationsOf(api, order.id))[0]!;
      expect(reservation.itemType).toBe('RAW_MATERIAL');

      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];
      expect(op.status).toBe('DRAFT');
      // El plan de corte sale del largo del SKU repetido hasta la cantidad pedida: es la misma
      // derivación que hacía `createToStock`, ahora con el pedido detrás.
      expect(op.items).toEqual([expect.objectContaining({ lengthMm: '4000.00', qty: 5 })]);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});
