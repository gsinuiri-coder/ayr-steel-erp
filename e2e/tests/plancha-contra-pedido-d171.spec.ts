import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getJson, postJson } from '../helpers/api';
import { dispatchOrder, purgeInvoicingTrail } from '../helpers/invoicing';
import {
  balanceOf,
  optionalBalanceOf,
  postExpectingError,
  today,
  type ProductionOrderDto,
} from '../helpers/production';
import {
  metersOf,
  mountCoil,
  pieces,
  purgeRoofingTrail,
  reportPieces,
  reservationsOf,
  roofingOrder,
  ROOFING_LINE,
  setupRoofingScenario,
} from '../helpers/roofing';
import {
  createCustomer,
  createQuotationWithLines,
  queueOf,
  type QuotationDto,
  type SalesOrderDto,
} from '../helpers/sales';

/**
 * **D-171 — la plancha de catálogo se produce contra el pedido (revierte D-140).**
 *
 * La premisa que el dueño corrigió: **una plancha no es stock terminado esperando en el
 * almacén**, es un largo fijo que la roladora corta cuando alguien la pide. Bajo D-140 la
 * plancha reservaba producto terminado y el pedido moría con «0.000 NIU disponibles» sobre un
 * SKU que nunca vive en el almacén; producirla era una corrida **a stock** que alguien tenía
 * que lanzar aparte y a ojo, sin pedido detrás.
 *
 * Desde D-171 nace `isMadeToOrder(product)` = *tener subtipo de cobertura*: `A_MEDIDA` y
 * `PLANCHA` se producen las dos. **Es una cuarta pregunta y no un cambio a las otras tres**
 * (regla dura 14): `isMadeToMeasure` y `sellsByLength` siguen respondiendo lo que respondían,
 * y el centinela de `sales-lines.spec.ts` cubre la tabla entera.
 *
 * Lo que este archivo protege, que es lo que un unitario no puede: **el camino completo**.
 * Cotizar diez planchas sin una sola en el almacén, confirmar, verlas aparecer en la cola de
 * planta, rolarlas contra la bobina y despacharlas. Cada eslabón tenía su propia razón para
 * rechazar una plancha bajo el modelo viejo, y solo recorriéndolos en fila se ve que ninguna
 * quedó.
 *
 * La aritmética es la de Fase 6, comprobable a ojo: bobina de 1 000 mm × 0.50 mm con densidad
 * 8.0 son 4 kg por metro de geometría, **4.04 con el 1 % de merma normal que D-165 metió
 * dentro de la densidad estándar** (y que por eso *no* se suma aparte). Una plancha de 3 m se
 * lleva 12.12 kg; diez, 121.20.
 *
 * Escribe compras, bobinas, pedidos, producción y despachos: nunca contra producción
 * (regla dura 9, D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea compras, bobinas, pedidos, OP y despachos: nunca contra producción (D-126, regla dura 9).',
);

/** El ciclo completo son ~30 llamadas al API; el timeout global no alcanza. */
test.describe.configure({ timeout: 240_000 });

/** Largo del SKU de plancha: 3 m, el del catálogo real del dueño. */
const SHEET_LENGTH_MM = '3000';
/** Diez planchas: 30 m lineales de bobina, 121.200 kg. */
const SHEETS = 10;
/**
 * Valor por metro con el que se cotiza (D-161, sin IGV).
 *
 * Cómodamente por encima del piso duro de D-163: el material de una plancha son 12.12 kg a
 * S/ 5 el kilo = S/ 60.60, o sea S/ 20.20 el metro. A S/ 60 el metro el margen es del 66 %,
 * así que ningún margen mínimo razonable puede rechazar esta línea — el piso ya tiene su
 * propio archivo (`precios-d161-d163.spec.ts`) y acá sería ruido.
 */
const VALUE_PER_METER = '60.0000';

test.describe('D-171 — la plancha de catálogo se fabrica contra el pedido', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('diez planchas sin una sola en el almacén: cotizar, confirmar, cola de planta, producir y despachar', async () => {
    const scenario = await setupRoofingScenario(api, {
      weightKg: '2000',
      pieceLengthMm: SHEET_LENGTH_MM,
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
    const dispatchIds: string[] = [];

    try {
      expect(scenario.product.unit).toBe('NIU');
      expect(scenario.product.lengthMm).toBe('3000.00');

      // **La premisa: no hay ni una plancha en el almacén.** Bajo D-140 esto bastaba para que
      // el pedido no se pudiera confirmar nunca.
      const before = await optionalBalanceOf(api, 'PRODUCT', scenario.product.id);
      expect(before?.qty ?? '0.000').toBe('0.000');

      // --- 1. La cotización ---
      const quotation = await createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        items: [
          {
            productId: scenario.product.id,
            qty: String(SHEETS),
            valuePerMeterPen: VALUE_PER_METER,
          },
        ],
      });
      trail.quotationIds = [quotation.id];

      const line = quotation.items[0]!;
      // D-161 **no cambió**: la cantidad son planchas, la unidad `NIU` y el unitario sale del
      // largo del SKU. Lo único que D-171 movió es de dónde sale el material.
      expect(line.qty).toBe('10.000');
      expect(line.unit).toBe('NIU');
      expect(line.valuePerMeterPen).toBe(VALUE_PER_METER);
      expect(line.unitPricePen).toBe('180.0000'); // 3 m × S/ 60
      expect(line.subtotalPen).toBe('1800.0000');
      // Y **esto** es D-171: la línea promete kilos del agregado de materia prima, no diez
      // planchas de un saldo que no existe. 10 × 3 m = 30 m × 4.04 kg/m = 121.200 kg.
      expect(line.reserveItemType).toBe('RAW_MATERIAL');
      expect(line.reserveQty).toBe('121.200');
      expect(line.reserveUnit).toBe('KGM');
      expect(line.reserveItemId).not.toBe(scenario.product.id);
      // La línea es **simple**: una plancha no lleva detalle de largos (`sellsByLength` es la
      // unidad, y esta es `NIU`). Es la pregunta que la regla dura 14 no deja confundir.
      expect(line.pieces ?? []).toEqual([]);

      // --- 2. La confirmación ---
      await postJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}/emit`);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
        {},
      );
      trail.orderIds = [order.id];
      expect(order.status).toBe('CONFIRMED');

      const reservation = (await reservationsOf(api, order.id))[0]!;
      expect(reservation).toMatchObject({
        itemType: 'RAW_MATERIAL',
        qty: '121.200',
        unit: 'KGM',
        status: 'ACTIVE',
      });
      // La bobina física no se tocó: lo prometido es el agregado, y qué rollo lo cumple lo
      // decide planta al montar (D-086/D-134).
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('2000.000');

      // --- 3. La cola de planta (RF-37) ---
      // Bajo D-140 la plancha **nunca** llegaba acá: la cola se arma con reservas de materia
      // prima, y la plancha no abría ninguna. Planta no tenía forma de enterarse del pedido.
      const queue = await queueOf(api);
      const mine = queue.find((e) => e.salesOrderId === order.id);
      expect(mine, 'el pedido de planchas no llegó a la cola de producción').toBeDefined();
      expect(mine!.productSku).toBe(scenario.product.sku);
      expect(mine!.theoreticalKg).toBe('121.200');
      // El plan que planta va a ver: el largo del SKU repetido hasta la cantidad pedida. Una
      // plancha no trae subítems, así que se derivan (`derivePiecesPlan`).
      expect(mine!.pieces).toEqual([{ lineNumber: 1, lengthMm: '3000.00', qty: SHEETS }]);

      // --- 4. La orden de producción ---
      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];
      expect(op.status).toBe('DRAFT');
      expect(op.salesOrderId).toBe(order.id);
      expect(op.items).toEqual([expect.objectContaining({ lengthMm: '3000.00', qty: SHEETS })]);
      // Creada la OP, la línea sale de la cola: ya no está esperando.
      expect((await queueOf(api)).find((e) => e.salesOrderId === order.id)).toBeUndefined();

      await mountCoil(api, op.id, { coilId: scenario.coil.id });
      // Montar es custodia, no consumo (D-060).
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('2000.000');

      const rows = pieces([3, SHEETS]);
      expect(metersOf(rows)).toBe('30.000');
      const reported = await reportPieces(api, op.id, { pieces: rows });
      expect(reported.status).toBe('IN_PROGRESS');
      expect(reported.piecesReported).toBe(SHEETS);

      // El kardex: 121.2 kg salen de la bobina y **10 planchas** entran al producto, en `NIU`.
      // Es lo que hace que la cantidad, la unidad y el despacho de D-161 no cambien.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1878.800');
      const produced = await balanceOf(api, 'PRODUCT', scenario.product.id);
      expect(produced.qty).toBe('10.000');
      expect(produced.unit).toBe('NIU');

      // D-088: las planchas **nacen reservadas** para el pedido que las encargó, y la reserva
      // de materia prima queda consumida por lo que se roló.
      const afterReport = await reservationsOf(api, order.id);
      expect(afterReport.find((r) => r.itemType === 'RAW_MATERIAL')).toMatchObject({
        qty: '0.000',
        status: 'CONSUMED',
      });
      expect(afterReport.find((r) => r.itemType === 'PRODUCT')).toMatchObject({
        qty: '10.000',
        unit: 'NIU',
        status: 'ACTIVE',
      });

      const closed = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${op.id}/close`,
        {},
      );
      expect(closed.status).toBe('CLOSED');

      // --- 5. El despacho ---
      // `resolveDispatchTarget` decide «se fabrica contra el pedido» por el **subtipo** y no
      // por la receta (D-171): una cobertura ya no tiene receta desde D-122, así que el
      // criterio viejo daba `false` justo para el caso central de esta rama.
      // La línea del **pedido**, no la de la cotización: el pedido copia las líneas con ids
      // propios, y el despacho solo conoce los suyos.
      const orderLine = order.items[0]!;
      const dispatch = await dispatchOrder(api, {
        salesOrderId: order.id,
        items: [{ salesOrderItemId: orderLine.id, qty: '10.000', weightKg: '121.200' }],
      });
      dispatchIds.push(dispatch.id);
      expect(dispatch.items).toHaveLength(1);
      // Sale en **planchas**, no en metros ni en kilos de bobina.
      expect(dispatch.items[0]).toMatchObject({
        qty: '10.000',
        unit: 'NIU',
        itemType: 'PRODUCT',
        itemId: scenario.product.id,
      });

      const fulfilled = await getJson<SalesOrderDto>(api, `/api/sales/orders/${order.id}`);
      expect(fulfilled.status).toBe('FULFILLED');
      // Y el almacén vuelve a quedar sin planchas: se rolaron para este pedido y se fueron
      // con él. Es la premisa entera de D-171 en un número.
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('0.000');
    } finally {
      await purgeInvoicingTrail(api, { dispatchIds });
      await purgeRoofingTrail(api, trail);
    }
  });

  test('despachar una plancha antes de rolarla se rechaza: no hay producto terminado que sacar', async () => {
    /**
     * El hueco que la auditoría encontró y que D-171 cerró del lado correcto: sin producto
     * terminado reservado, el despacho caía a las **coordenadas congeladas** de la línea y
     * emitía una salida de *kilos de bobina* por una venta de planchas — el mismo material
     * saliendo dos veces del kardex, que es exactamente lo que D-088 vino a cerrar.
     */
    const scenario = await setupRoofingScenario(api, {
      weightKg: '1000',
      pieceLengthMm: SHEET_LENGTH_MM,
    });
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
      const quotation = await createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        items: [{ productId: scenario.product.id, qty: '4', valuePerMeterPen: VALUE_PER_METER }],
      });
      trail.quotationIds = [quotation.id];
      await postJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}/emit`);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
        {},
      );
      trail.orderIds = [order.id];

      const rejected = await postExpectingError(api, '/api/dispatches', {
        salesOrderId: order.id,
        dispatchDate: today(),
        originAddress: 'Av. Almacén 100, Lima',
        destinationAddress: 'Av. Cliente 200, Lima',
        originUbigeo: '150101',
        destinationUbigeo: '150132',
        transferMode: 'PRIVATE',
        totalWeightKg: '48.480',
        packageCount: 1,
        vehiclePlate: 'AEE-123',
        driverGivenNames: 'Juan Carlos',
        driverFamilyNames: 'Pérez de Prueba',
        driverDocType: 'DNI',
        driverDocNumber: '44556677',
        driverLicense: 'Q44556677',
        notes: 'Intento de despachar planchas sin rolar (D-171)',
        items: [{ salesOrderItemId: order.items[0]!.id, qty: '4.000', weightKg: '48.480' }],
      });
      expect(rejected.status).toBe(400);
      expect(rejected.message).toContain('se fabrica contra el pedido');
      expect(rejected.message).toContain('produce lo que falta antes de despacharlo');

      // Nada se movió: la bobina sigue entera y la promesa sigue viva.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1000.000');
      expect((await reservationsOf(api, order.id))[0]!.status).toBe('ACTIVE');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});
