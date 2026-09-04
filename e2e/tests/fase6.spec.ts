import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, createSupplier, getJson, postJson } from '../helpers/api';
import {
  balanceOf,
  live,
  movementsOf,
  optionalBalanceOf,
  postExpectingError,
  today,
  uniqueDocumentNumber,
  type ProductionOrderDto,
  type PurchaseDto,
} from '../helpers/production';
import { availabilityOf, createCustomer, createSellableProduct } from '../helpers/sales';
import {
  UPVC_LINE,
  coilOptions,
  metersOf,
  pieces,
  purgeRoofingTrail,
  quoteAndOrder,
  reservationsOf,
  roofingOrder,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * Fase 6 — producción de coberturas metálicas contra pedido (RF-30..RF-33; D-082..D-091).
 *
 * Lo que estos tests protegen, en una línea: **el material que un pedido promete no deja de
 * estar protegido en ningún momento del camino**, ni cuando es bobina, ni mientras la
 * roladora lo convierte, ni cuando ya son metros en el almacén — y cada kilo sale del kardex
 * una sola vez.
 *
 * La aritmética está elegida para comprobarse a ojo: bobina de 1 000 mm × 0.50 mm con
 * densidad 8.0 ⇒ **4 kg por metro lineal**. Una plancha de 4 m son 16 kg; una de 6 m, 24 kg.
 */

const allowWrites = process.env.E2E_ALLOW_WRITES === '1' || !process.env.E2E_BASE_URL;

/** El ciclo completo son ~40 llamadas al API contra Neon; el timeout global no alcanza. */
test.describe.configure({ timeout: 240_000 });

test.describe('Fase 6 — producción de coberturas', () => {
  test.skip(
    !allowWrites,
    'Escrituras contra producción deshabilitadas: exporta E2E_ALLOW_WRITES=1',
  );

  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('ciclo completo: cotizar con subítems → OP → rolar → cerrar con despunte → kardex cuadra', async () => {
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
      // 3 planchas de 4.20 m + 2 de 6.00 m = 24.60 m. A 4 kg/m son 98.400 kg teóricos.
      const rows = pieces([4.2, 3], [6, 2]);
      expect(metersOf(rows)).toBe('24.600');

      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        coilId: scenario.coil.id,
        reserveKg: '100',
        rows,
        unitPricePen: '30',
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];

      // La línea del pedido guarda los largos y su cantidad **es** la suma en metros.
      const item = order.items[0]!;
      expect(item.qty).toBe('24.600');
      expect(item.unit).toBe('MTR');
      expect(item.pieces).toHaveLength(2);
      expect(item.pieces?.[0]).toMatchObject({ lengthMm: '4200.00', qty: 3 });
      // D-083: los largos viajan en la descripción, que es lo que el cliente lee.
      expect(item.description).toContain('3 × 4.20 m');
      expect(item.description).toContain('2 × 6.00 m');

      // Confirmar reservó **la bobina**: el producto terminado todavía no existe.
      const afterConfirm = await reservationsOf(api, order.id);
      expect(afterConfirm).toHaveLength(1);
      expect(afterConfirm[0]).toMatchObject({
        itemType: 'COIL',
        itemId: scenario.coil.id,
        qty: '100.000',
        status: 'ACTIVE',
      });
      const coilAfterConfirm = await availabilityOf(api, 'COIL', scenario.coil.id);
      expect(coilAfterConfirm.reservedQty).toBe('100.000');
      expect(coilAfterConfirm.availableQty).toBe('1900.000');

      // --- La OP nace del pedido y copia su plan de corte (D-084) ---
      const created = await roofingOrder(api, afterConfirm[0]!.id);
      trail.productionOrderIds = [created.id];
      expect(created.kind).toBe('ROOFING');
      expect(created.status).toBe('DRAFT');
      expect(created.salesOrderCode).toBe(order.code);
      expect(created.items).toHaveLength(2);
      expect(created.items?.[1]).toMatchObject({ lengthMm: '6000.00', qty: 2 });

      // El filtro ofrece la bobina del propio pedido: su reserva no se excluye a sí misma.
      const options = await coilOptions(api, scenario.product.id, afterConfirm[0]!.id);
      expect(options.map((o) => o.coilId)).toContain(scenario.coil.id);
      // 2 000 kg a 4 kg/m son 500 m.
      expect(options.find((o) => o.coilId === scenario.coil.id)?.estimatedMeters).toBe('500.000');

      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${created.id}/coils`, {
        coilId: scenario.coil.id,
      });

      // Montar es custodia: **no mueve kardex** (D-060).
      const coilAfterMount = await balanceOf(api, 'COIL', scenario.coil.id);
      expect(coilAfterMount.qty).toBe('2000.000');

      // --- Reportar los largos reales ---
      const reported = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${created.id}/report`,
        { pieces: rows },
      );
      expect(reported.status).toBe('IN_PROGRESS');
      expect(reported.piecesReported).toBe(5);
      expect(reported.metersReported).toBe('24.600');
      const report = reported.reports.find((r) => r.status === 'ACTIVE')!;
      expect(report.theoreticalKg).toBe('98.400');

      // El kardex: 98.400 kg salen de la bobina y 24.600 m entran al producto.
      const coilAfterReport = await balanceOf(api, 'COIL', scenario.coil.id);
      expect(coilAfterReport.qty).toBe('1901.600');
      const productAfterReport = await balanceOf(api, 'PRODUCT', scenario.product.id);
      expect(productAfterReport.qty).toBe('24.600');
      expect(productAfterReport.unit).toBe('MTR');
      // Valor conservado: la bobina entró a S/ 5/kg, así que 98.4 kg son S/ 492.
      expect(productAfterReport.avgCost).toBe('20.0000');

      // **D-088, el corazón de la fase**: la promesa se trasladó. La reserva de bobina bajó
      // por los kilos consumidos y nació una reserva sobre los metros fabricados.
      const afterReport = await reservationsOf(api, created.id ? order.id : order.id);
      const onCoil = afterReport.find((r) => r.itemType === 'COIL')!;
      const onProduct = afterReport.find((r) => r.itemType === 'PRODUCT')!;
      expect(onCoil.qty).toBe('1.600');
      expect(onProduct).toMatchObject({
        itemId: scenario.product.id,
        qty: '24.600',
        unit: 'MTR',
        status: 'ACTIVE',
      });
      // Y el disponible del producto es cero: los metros están todos prometidos.
      const productAvail = await availabilityOf(api, 'PRODUCT', scenario.product.id);
      expect(productAvail.reservedQty).toBe('24.600');
      expect(productAvail.availableQty).toBe('0.000');

      // --- Cerrar declarando el consumo real: la diferencia es despunte (D-089) ---
      const closed = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${created.id}/close`,
        { consumedKg: '102.000' },
      );
      expect(closed.status).toBe('CLOSED');
      expect(closed.scrapKg).toBe('3.600');
      expect(closed.consumedDeclaredKg).toBe('102.000');

      // El sobrante de la bobina **vuelve al almacén**, no sale como merma: eso es lo que
      // separa D-089 de D-057. Salieron 98.400 + 3.600 = 102 kg de 2 000.
      const coilAfterClose = await balanceOf(api, 'COIL', scenario.coil.id);
      expect(coilAfterClose.qty).toBe('1898.000');

      // Costeo: 102 kg a S/ 5 = S/ 510 sobre 24.6 m ⇒ S/ 20.7317/m.
      expect(closed.materialCostPen).toBe('510.0000');
      expect(closed.overheadCostPen).toBe('0.0000');
      expect(closed.unitCostPen).toBe('20.7317');
      const productAfterClose = await balanceOf(api, 'PRODUCT', scenario.product.id);
      expect(productAfterClose.avgCost).toBe('20.7317');

      // El kardex de la bobina: un IN de compra, un OUT de producción y un OUT de despunte.
      const coilMovements = live(await movementsOf(api, 'COIL', scenario.coil.id));
      expect(coilMovements.map((m) => `${m.type}:${m.refType}`)).toEqual([
        'IN:PURCHASE',
        'OUT:PRODUCTION',
        'OUT:SCRAP',
      ]);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('la pieza a medida no se la puede llevar otro pedido: la reserva la protege', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '1000' });
    const cliente = await createCustomer(api);
    const otro = await createCustomer(api);
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
      const rows = pieces([5, 2]); // 10 m ⇒ 40 kg
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: cliente.id,
        productId: scenario.product.id,
        coilId: scenario.coil.id,
        reserveKg: '50',
        rows,
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];

      const reservation = (await reservationsOf(api, order.id))[0]!;
      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/coils`, {
        coilId: scenario.coil.id,
      });
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/report`, {
        pieces: rows,
      });

      // Los 10 m existen en el almacén, pero están prometidos. Otro cliente que quiera
      // cotizarlos de stock se topa con la invariante `disponible ≥ reservado` (D-066).
      const avail = await availabilityOf(api, 'PRODUCT', scenario.product.id);
      expect(avail.qty).toBe('10.000');
      expect(avail.availableQty).toBe('0.000');

      const rival = await postJson<{ id: string }>(api, '/api/sales/quotations', {
        customerId: otro.id,
        businessLine: 'metallic-roofing',
        issueDate: today(),
        items: [
          {
            productId: scenario.product.id,
            qty: '10.000',
            unitPricePen: '35',
            pieces: pieces([5, 2]),
          },
        ],
      });
      trail.quotationIds = [quotation.id, rival.id];
      await postJson(api, `/api/sales/quotations/${rival.id}/emit`);
      const error = await postExpectingError(api, `/api/sales/quotations/${rival.id}/confirm`);
      expect(error.status).toBe(400);
      expect(error.message).toContain('disponibles');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('UPVC es compra-venta pura: se compra terminado, se vende y el kardex cuadra (D-091)', async () => {
    const supplier = await createSupplier(api, { name: 'E2E Proveedor UPVC' });
    const customer = await createCustomer(api);
    const product = await createSellableProduct(api, {
      lineCode: UPVC_LINE,
      listPricePen: '85',
      unit: 'NIU',
    });
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: supplier.id,
      productIds: [product.id],
      purchaseIds: [],
      orderIds: [],
    };

    try {
      // Compra de producto terminado (D-030): no hay bobina ni nada que transformar.
      const purchase = await postJson<PurchaseDto>(api, '/api/purchases', {
        supplierId: supplier.id,
        businessLine: UPVC_LINE,
        type: 'FINISHED_GOOD',
        docType: 'FACTURA',
        series: 'F001',
        number: uniqueDocumentNumber(),
        issueDate: today(),
        currency: 'PEN',
        igvRate: '18',
        paymentTerms: 'CONTADO',
        items: [
          {
            productId: product.id,
            description: 'Plancha UPVC E2E',
            qty: '40',
            unit: 'NIU',
            unitPrice: '50',
          },
        ],
      });
      trail.purchaseIds = [purchase.id];
      await postJson<PurchaseDto>(api, `/api/purchases/${purchase.id}/receive`);

      const afterPurchase = await balanceOf(api, 'PRODUCT', product.id);
      expect(afterPurchase.qty).toBe('40.000');
      expect(afterPurchase.avgCost).toBe('50.0000');

      // La línea `roofing` no exige cotización: admite pedido directo (D-065).
      const order = await postJson<{ id: string; code: string; items: { id: string }[] }>(
        api,
        '/api/sales/orders',
        {
          customerId: customer.id,
          businessLine: UPVC_LINE,
          issueDate: today(),
          items: [{ productId: product.id, qty: '10', unitPricePen: '85' }],
        },
      );
      trail.orderIds = [order.id];

      // Reserva sobre el propio producto: no hay materia prima que proteger.
      const reservations = await reservationsOf(api, order.id);
      expect(reservations).toHaveLength(1);
      expect(reservations[0]).toMatchObject({
        itemType: 'PRODUCT',
        itemId: product.id,
        qty: '10.000',
        status: 'ACTIVE',
      });
      const avail = await availabilityOf(api, 'PRODUCT', product.id);
      expect(avail.availableQty).toBe('30.000');

      // Y no se puede producir: no hay receta ni bobina detrás.
      const error = await postExpectingError(api, '/api/production/roofing', {
        reservationId: reservations[0]!.id,
      });
      expect(error.status).toBe(400);
      expect(error.message).toContain('stock');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('el maestro de colores es CRUD con baja lógica y no se desactiva mientras se use', async () => {
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
      const colors = await getJson<{ id: string; isActive: boolean }[]>(api, '/api/colors');
      expect(colors.some((c) => c.id === scenario.color.id)).toBe(true);

      // El color lo usan el producto y la bobina: desactivarlo dejaría el filtro de la OP
      // emparejando contra un maestro que la UI ya no ofrece.
      const error = await postExpectingError(api, '/api/colors', {
        code: scenario.color.code,
        name: 'Duplicado',
        hexColor: '#000000',
      });
      expect(error.status).toBe(409);

      const res = await api.patch(`/api/colors/${scenario.color.id}`, {
        data: { isActive: false },
      });
      expect(res.status()).toBe(400);
      expect(await res.text()).toContain('producto');

      // La bobina lo lleva y el producto también: es lo que hace que se puedan emparejar.
      const coil = await getJson<{ colorId: string | null }>(api, `/api/coils/${scenario.coil.id}`);
      expect(coil.colorId).toBe(scenario.color.id);
      const product = await getJson<{ colorId: string | null; colorHex: string | null }>(
        api,
        `/api/catalog/${scenario.product.id}`,
      );
      expect(product.colorId).toBe(scenario.color.id);
      expect(product.colorHex).toBe(scenario.color.hexColor);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('plancha de catálogo: largo fijo, se cuenta en piezas y rechaza otro largo (D-083)', async () => {
    const scenario = await setupRoofingScenario(api, {
      weightKg: '1000',
      pieceLengthMm: '3000',
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
      // Línea **simple**: se cotizan 4 planchas, sin detalle de largos.
      const quotation = await postJson<{ id: string }>(api, '/api/sales/quotations', {
        customerId: customer.id,
        businessLine: 'metallic-roofing',
        issueDate: today(),
        items: [
          {
            productId: scenario.product.id,
            qty: '4',
            unitPricePen: '90',
            reserveFromCoilId: scenario.coil.id,
            reserveKg: '60',
          },
        ],
      });
      trail.quotationIds = [quotation.id];
      await postJson(api, `/api/sales/quotations/${quotation.id}/emit`);
      const order = await postJson<{ id: string }>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds = [order.id];

      const reservation = (await reservationsOf(api, order.id))[0]!;
      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];
      // El plan se deriva del largo de la receta y de la cantidad pedida.
      expect(op.items).toHaveLength(1);
      expect(op.items?.[0]).toMatchObject({ lengthMm: '3000.00', qty: 4 });

      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/coils`, {
        coilId: scenario.coil.id,
      });

      // Un largo distinto del de la receta la convertiría en otro producto dentro del
      // mismo saldo: el API lo rechaza.
      const error = await postExpectingError(api, `/api/production/roofing/${op.id}/report`, {
        pieces: pieces([4, 1]),
      });
      expect(error.status).toBe(400);
      expect(error.message).toContain('catálogo');

      const reported = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${op.id}/report`,
        { pieces: pieces([3, 4]) },
      );
      // Se cuenta en **piezas**, no en metros: la unidad del producto es NIU.
      expect(reported.piecesReported).toBe(4);
      expect(reported.metersReported).toBeNull();
      const balance = await balanceOf(api, 'PRODUCT', scenario.product.id);
      expect(balance.qty).toBe('4.000');
      expect(balance.unit).toBe('NIU');
      // 4 planchas de 3 m a 4 kg/m son 48 kg.
      expect(reported.reports.find((r) => r.status === 'ACTIVE')?.theoreticalKg).toBe('48.000');
    } finally {
      await purgeRoofingTrail(api, trail);
      const leftover = await optionalBalanceOf(api, 'PRODUCT', scenario.product.id);
      expect(leftover?.qty ?? '0.000').toBe('0.000');
    }
  });
});
