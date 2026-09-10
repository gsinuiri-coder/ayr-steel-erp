import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getJson } from '../helpers/api';
import { DISPATCH_LINE, dispatchOrder, purgeInvoicingTrail } from '../helpers/invoicing';
import { type CoilDto, type ProductDto } from '../helpers/production';
import { buyCoilForSale, createCustomer, createDirectOrder, sellableCoils } from '../helpers/sales';

/**
 * **D-168 — el guion del código de acabado es un separador, no un carácter a borrar.**
 *
 * El defecto, en una línea: había **dos** funciones que decían calcular el mismo SKU de venta
 * directa (D-037) y con un acabado con guiones adentro devolvían cosas distintas. `coilSku`
 * —la que da de alta el producto al recibir la bobina— conservaba los guiones del acabado
 * (`BOBALZ-ROJO-30020.45`); `coilSkuFromTypeKey` —la que la venta directa usa para
 * encontrarlo— los borraba todos (`BOBALZROJO30020.45`). El síntoma era «no existe el
 * producto de venta directa» sobre una bobina que sí tenía el suyo, y solo aparecía con los
 * acabados reales del dueño, que son los que llevan guiones.
 *
 * Por eso este caso usa un acabado con **dos** guiones y recorre el ciclo entero: alta por
 * compra, el SKU que el catálogo generó, el desplegable de bobinas vendibles, el pedido y el
 * despacho. Un test que solo comparara las dos funciones no habría notado nada —las dos
 * existen y las dos devuelven algo—; lo que hace falta es que el producto que **una** creó sea
 * el que la **otra** encuentra.
 *
 * Escribe compras, pedidos y despachos: nunca contra producción (regla dura 9, D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Compra bobinas, vende y despacha: nunca contra producción (D-126, regla dura 9).',
);

test.describe.configure({ timeout: 180_000 });

test.describe('D-168 — SKU de venta directa de una bobina con acabado con guiones', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('una bobina de acabado ALZ-ROJO-nnnn se vende entera de punta a punta', async () => {
    // El acabado del caso real: prefijo del material, color y código de color, separados por
    // guiones. El sufijo numérico solo lo hace único dentro de la corrida.
    const finishCode = `ALZ-ROJO-${String(Date.now()).slice(-6)}`;
    const stock = await buyCoilForSale(api, {
      lineCode: DISPATCH_LINE,
      weightKg: '400',
      coilStatus: 'OPEN',
      finishCode,
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
      expect(stock.finish.code).toBe(finishCode);

      // RF-14: el `typeKey` es `{acabado}-{espesor}`, así que con este acabado tiene **tres**
      // guiones y solo el último separa el espesor. Ahí está toda la ambigüedad que D-168
      // resolvió partiendo por el último y no por el primero.
      const coil = await getJson<CoilDto>(api, `/api/coils/${stock.coil.id}`);
      expect(coil.typeKey).toBe(`${finishCode}-0.50`);

      // D-037: el producto que el alta generó conserva los guiones del acabado.
      const expectedSku = `BOB${finishCode}0.50`;
      const offered = await sellableCoils(api, DISPATCH_LINE);
      const mine = offered.find((c) => c.coilId === stock.coil.id);
      expect(mine, 'la bobina con acabado con guiones no aparece como vendible').toBeDefined();
      expect(mine!.typeKey).toBe(`${finishCode}-0.50`);

      // **El corazón de D-168**: la venta directa busca ese mismo SKU y lo encuentra. Antes
      // esta llamada moría con 404 «no existe el producto de venta directa (BOBALZROJO0.50)».
      const order = await createDirectOrder(api, {
        customerId: customer.id,
        businessLine: DISPATCH_LINE,
        items: [{ saleCoilId: stock.coil.id, qty: '400.000', unitPricePen: '9.0000' }],
      });
      trail.orderIds = [order.id];

      const line = order.items[0]!;
      expect(line.productSku).toBe(expectedSku);
      // Y el producto existe de verdad en el catálogo con ese SKU: es el que creó `coilSku` al
      // recibir la compra, no uno que la venta haya inventado por el camino.
      const product = await getJson<ProductDto>(api, `/api/catalog/${line.productId}`);
      expect(product.sku).toBe(expectedSku);

      expect(order.reservations[0]).toMatchObject({
        status: 'ACTIVE',
        itemType: 'COIL',
        itemId: stock.coil.id,
      });

      // Punta a punta: el rollo sale del almacén y el pedido queda atendido.
      const dispatch = await dispatchOrder(api, {
        salesOrderId: order.id,
        items: [{ salesOrderItemId: line.id, qty: '400.000', weightKg: '400.000' }],
      });
      trail.dispatchIds = [dispatch.id];
      expect(dispatch.items[0]).toMatchObject({ itemType: 'COIL', itemId: stock.coil.id });

      const closed = await getJson<{ status: string }>(api, `/api/sales/orders/${order.id}`);
      expect(closed.status).toBe('FULFILLED');
      // D-170, de paso: vendida entera y sin saldo, la bobina se cierra sola.
      expect((await getJson<CoilDto>(api, `/api/coils/${stock.coil.id}`)).status).toBe('CLOSED');
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });
});
