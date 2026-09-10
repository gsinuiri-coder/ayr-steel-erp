import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getJson } from '../helpers/api';
import {
  DISPATCH_LINE,
  dispatchOrder,
  getDispatch,
  purgeInvoicingTrail,
  type DispatchDto,
} from '../helpers/invoicing';
import { postExpectingError, type CoilDto } from '../helpers/production';
import {
  buyCoilForSale,
  createCustomer,
  createDirectOrder,
  sellableCoils,
  type SalesOrderDto,
} from '../helpers/sales';

/**
 * **D-170 — vender una bobina entera la cierra, y revertir el despacho la reabre.**
 *
 * Lo que estos casos protegen, en una línea: **el cierre es parte del hecho de venderla, no
 * una tarea que alguien tiene que acordarse de hacer después.** Hasta D-170 el rollo vendido
 * completo quedaba `OPEN` con saldo cero: seguía apareciendo en la lista de bobinas abiertas y
 * en los desplegables de producción para siempre, y planta podía intentar montar en la
 * roladora un rollo que ya se había ido en un camión.
 *
 * Las tres condiciones de la decisión, una por caso:
 *
 * 1. **saldo cero y sin reservas vivas ⇒ `CLOSED`**, con auditoría `coils.close`.
 * 2. **la reversa del despacho la reabre** (`coils.open`): el movimiento inverso le devuelve
 *    los kilos, y una bobina cerrada con saldo vivo es un estado que nadie sabría de dónde
 *    salió — y que además deja el material fuera del alcance de producción.
 * 3. **un despacho parcial no la cierra.** Ese remanente sigue siendo el cierre manual de
 *    D-164, el que pide `physicalKg` y motivo y liquida la diferencia como merma anormal.
 *    Cerrarlo acá se saltearía esa liquidación y dejaría el valor del remanente en el
 *    inventario valorizado de un rollo que ya no existe.
 *
 * Todos los casos compran, venden y despachan: nunca contra producción (regla dura 9, D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Compra bobinas, vende y despacha: nunca contra producción (D-126, regla dura 9).',
);

test.describe.configure({ timeout: 180_000 });

/** Estado y saldo de la bobina, que es lo único que estos casos miran de ella. */
async function coilNow(api: APIRequestContext, coilId: string): Promise<CoilDto> {
  return getJson<CoilDto>(api, `/api/coils/${coilId}`);
}

test.describe('D-170 — la venta de la bobina entera la cierra', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('despachar la bobina entera la deja CLOSED, y revertir el despacho la devuelve a OPEN', async () => {
    // La bobina nace `OPEN` a propósito: es el estado que el cierre automático tiene que
    // cambiar. Una que ya estaba `CLOSED` antes del despacho no la cerró este despacho, y por
    // eso la reversa tampoco tiene que reabrirla (lo dice el filtro de `reopenRevertedCoils`).
    const stock = await buyCoilForSale(api, {
      lineCode: DISPATCH_LINE,
      weightKg: '600',
      coilStatus: 'OPEN',
    });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeInvoicingTrail>[1] = {
      dispatchIds: [],
      orderIds: [],
      coilIds: [stock.coil.id],
      purchaseId: stock.purchaseId,
      supplierId: stock.supplier.id,
      finish: stock.finish,
    };

    try {
      // El SKU de venta directa (D-037) lo resuelve el API desde el `typeKey` de la bobina.
      const offered = await sellableCoils(api, DISPATCH_LINE);
      const mine = offered.find((c) => c.coilId === stock.coil.id);
      expect(mine, 'la bobina recién comprada no aparece como vendible').toBeDefined();
      expect(mine!.availableQty).toBe('600.000');
      // D-170 también sumó el costo promedio al desplegable: el vendedor negocia el precio de
      // un rollo entero mirando lo que costó, y hasta acá tenía que salir de la pantalla.
      expect(mine!.avgCostPen).not.toBeNull();
      expect(Number(mine!.avgCostPen)).toBeGreaterThan(0);

      const order = await createDirectOrder(api, {
        customerId: customer.id,
        businessLine: DISPATCH_LINE,
        items: [{ saleCoilId: stock.coil.id, qty: '600.000', unitPricePen: '8.0000' }],
      });
      trail.orderIds = [order.id];
      expect(order.reservations[0]).toMatchObject({
        status: 'ACTIVE',
        itemType: 'COIL',
        itemId: stock.coil.id,
      });
      // Mientras la reserva vive, la bobina sigue abierta: lo que la cierra es el despacho.
      expect((await coilNow(api, stock.coil.id)).status).toBe('OPEN');

      const dispatch = await dispatchOrder(api, {
        salesOrderId: order.id,
        items: [{ salesOrderItemId: order.items[0]!.id, qty: '600.000', weightKg: '600.000' }],
      });
      trail.dispatchIds = [dispatch.id];
      expect(dispatch.items[0]).toMatchObject({ itemType: 'COIL', itemId: stock.coil.id });

      // **El corazón de D-170.** Saldo en cero, sin reservas vivas (el despacho consumió la
      // suya) ⇒ la bobina se cierra sola.
      const afterDispatch = await coilNow(api, stock.coil.id);
      expect(afterDispatch.status).toBe('CLOSED');
      expect(afterDispatch.availableKg).toBe('0.000');

      // El cierre queda auditado con la misma acción que el cierre manual (`coils.close`),
      // pero `audit_log` no tiene endpoint de lectura, así que lo que se comprueba acá es la
      // consecuencia observable: ya no se ofrece para vender ni entra a producción.
      const afterOffer = await sellableCoils(api, DISPATCH_LINE);
      expect(afterOffer.find((c) => c.coilId === stock.coil.id)).toBeUndefined();

      // --- La reversa la reabre ---
      const reversed = await getJson<DispatchDto>(api, `/api/dispatches/${dispatch.id}`);
      expect(reversed.status).toBe('ISSUED');
      const res = await api.post(`/api/dispatches/${dispatch.id}/reverse`, {
        data: { reason: 'Reversa de prueba E2E D-170' },
      });
      expect(res.ok(), `la reversa del despacho falló: ${await res.text()}`).toBe(true);
      trail.dispatchIds = [];

      expect((await getDispatch(api, dispatch.id)).status).toBe('REVERSED');
      const afterReverse = await coilNow(api, stock.coil.id);
      // Los kilos volvieron, así que dejarla `CLOSED` la dejaría con saldo vivo y fuera de
      // producción a la vez: el estado que la invariante de materia prima no puede describir.
      expect(afterReverse.status).toBe('OPEN');
      expect(afterReverse.availableKg).toBe('600.000');

      // Reabrirla no es cosmético: `OPEN` es lo que la devuelve al alcance de producción.
      // Como vendible **no** vuelve a aparecer, y está bien: la reversa también restauró la
      // reserva del pedido, que sigue vivo y sigue prometiendo el rollo entero. Lo que la
      // saca de la vitrina es la promesa, no el estado.
      const back = await getJson<SalesOrderDto>(api, `/api/sales/orders/${order.id}`);
      expect(back.status).not.toBe('FULFILLED');
      expect(back.reservations[0]).toMatchObject({
        status: 'ACTIVE',
        itemType: 'COIL',
        itemId: stock.coil.id,
      });
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });

  test('un despacho parcial deja remanente y no cierra la bobina: eso sigue siendo el cierre manual de D-164', async () => {
    const stock = await buyCoilForSale(api, {
      lineCode: DISPATCH_LINE,
      weightKg: '500',
      coilStatus: 'OPEN',
    });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeInvoicingTrail>[1] = {
      dispatchIds: [],
      orderIds: [],
      coilIds: [stock.coil.id],
      purchaseId: stock.purchaseId,
      supplierId: stock.supplier.id,
      finish: stock.finish,
    };

    try {
      const order: SalesOrderDto = await createDirectOrder(api, {
        customerId: customer.id,
        businessLine: DISPATCH_LINE,
        items: [{ saleCoilId: stock.coil.id, qty: '500.000', unitPricePen: '8.0000' }],
      });
      trail.orderIds = [order.id];

      // 200 de 500: el camión se lleva parte del rollo y el resto sigue en el almacén.
      const dispatch = await dispatchOrder(api, {
        salesOrderId: order.id,
        items: [{ salesOrderItemId: order.items[0]!.id, qty: '200.000', weightKg: '200.000' }],
      });
      trail.dispatchIds = [dispatch.id];

      const afterPartial = await coilNow(api, stock.coil.id);
      expect(afterPartial.availableKg).toBe('300.000');
      // **No la cierra**: cerrarla acá se saltearía la liquidación de D-164 y el valor de los
      // 300 kg restantes quedaría vivo en el valorizado de un rollo que ya no está entero.
      expect(afterPartial.status).toBe('OPEN');

      // Y el camino que sí corresponde sigue siendo el manual, que exige declarar los kilos
      // que de verdad quedan: sin ellos, rebota.
      const sinFisico = await postExpectingError(api, `/api/coils/${stock.coil.id}/status`, {
        status: 'CLOSED',
        reason: 'Cierre sin declarar el remanente',
      });
      expect(sinFisico.status).toBe(400);
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });
});
