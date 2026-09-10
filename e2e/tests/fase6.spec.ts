import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, createSupplier, getJson, postJson } from '../helpers/api';
import {
  balanceOf,
  live,
  movementsOf,
  postExpectingError,
  today,
  uniqueDocumentNumber,
  type ProductionOrderDto,
  type PurchaseDto,
} from '../helpers/production';
import {
  availabilityOf,
  createCustomer,
  createSellableProduct,
  stockPanel,
} from '../helpers/sales';
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
 * densidad 8.0 ⇒ 4 kg por metro de geometría y **4.04 consumidos** con el 1 % de merma
 * normal que D-165 absorbe en la densidad estándar. Una plancha de 4 m se lleva 16.16 kg.
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
      // 3 planchas de 4.20 m + 2 de 6.00 m = 24.60 m. A 4.04 kg/m (D-165) son 99.384 kg.
      const rows = pieces([4.2, 3], [6, 2]);
      expect(metersOf(rows)).toBe('24.600');

      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
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

      // D-134: confirmar reservó kilos del **agregado de materia prima** (línea + color +
      // espesor), no una bobina concreta — la línea ya no elige el rollo, así que el
      // producto terminado sigue sin existir hasta que planta rola. Los kilos son los
      // teóricos del estándar: 24.6 m × 4.04 kg/m = 99.384 kg (D-165).
      const afterConfirm = await reservationsOf(api, order.id);
      expect(afterConfirm).toHaveLength(1);
      expect(afterConfirm[0]).toMatchObject({
        itemType: 'RAW_MATERIAL',
        qty: '99.384',
        status: 'ACTIVE',
      });
      // El disponible del agregado ya descuenta lo prometido, aunque el físico de la bobina
      // no se haya movido: 2 000 físicos − 98.400 prometidos = 1 901.600.
      const panelAfterConfirm = await stockPanel(api, {
        businessLine: 'metallic-roofing',
        productIds: [scenario.product.id],
      });
      expect(panelAfterConfirm.products[0]).toMatchObject({
        productId: scenario.product.id,
        rawMaterialAvailableKg: '1900.616',
      });
      const coilAfterConfirm = await balanceOf(api, 'COIL', scenario.coil.id);
      expect(coilAfterConfirm.qty).toBe('2000.000');

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
      // 2 000 kg a 4.04 kg/m (D-165) rinden 495.050 m: el mismo rollo promete ~1 % menos
      // metros, que es exactamente el efecto buscado de absorber la merma normal en el estándar.
      expect(options.find((o) => o.coilId === scenario.coil.id)?.estimatedMeters).toBe('495.050');

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
      expect(report.theoreticalKg).toBe('99.384');

      // El kardex: 99.384 kg salen de la bobina (D-165) y 24.600 m entran al producto.
      const coilAfterReport = await balanceOf(api, 'COIL', scenario.coil.id);
      expect(coilAfterReport.qty).toBe('1900.616');
      const productAfterReport = await balanceOf(api, 'PRODUCT', scenario.product.id);
      expect(productAfterReport.qty).toBe('24.600');
      expect(productAfterReport.unit).toBe('MTR');
      // Valor conservado: la bobina entró a S/ 5/kg, así que los 99.384 kg del estándar
      // (D-165) son S/ 496.92, repartidos en 24.6 m ⇒ S/ 20.20 por metro.
      expect(productAfterReport.avgCost).toBe('20.2000');

      // **D-088, el corazón de la fase**: la promesa se trasladó. La reserva de materia
      // prima se consumió por completo (reservó y gastó exactamente 99.384 kg con el 1 % de
      // D-165, D-134) y nació una reserva sobre los **metros** fabricados — que son 24.600 y no
      // llevan el factor: la merma vive en el kilo de bobina, no en el metro de producto.
      const afterReport = await reservationsOf(api, order.id);
      const onRawMaterial = afterReport.find((r) => r.itemType === 'RAW_MATERIAL')!;
      const onProduct = afterReport.find((r) => r.itemType === 'PRODUCT')!;
      expect(onRawMaterial).toMatchObject({ qty: '0.000', status: 'CONSUMED' });
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
      expect(closed.scrapKg).toBe('2.616');
      expect(closed.consumedDeclaredKg).toBe('102.000');

      // El sobrante de la bobina **vuelve al almacén**, no sale como merma: eso es lo que
      // separa D-089 de D-057. Salieron 99.384 + 2.616 = 102 kg de 2 000: con el 1 % de
      // D-165 adentro del estándar, el despunte que queda por explicar es más chico.
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
    // Una bobina **chica** (50 kg) y a propósito: el pedido se lleva 40 rolando, y los 10 que
    // sobran no alcanzan para el rival. Hasta D-154 el rollo podía ser de 1 000 kg y el rival
    // se cortaba igual, porque una bobina montada salía entera del agregado; eso era el doble
    // descuento (custodia + promesa del mismo pedido) y ya no pasa. La escasez de este caso
    // ahora tiene que ser **real**, que es lo que el guardrail de verdad protege.
    const scenario = await setupRoofingScenario(api, { weightKg: '50' });
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

      // Los 10 m existen en el almacén, pero están prometidos: la reserva del primer pedido
      // los protege y el disponible es cero (invariante `disponible ≥ reservado`, D-066).
      // **Esta es la mitad del test que no cambió con D-127** y la que de verdad dice que la
      // pieza a medida no se la lleva otro.
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
      // D-127 cambió **por qué** se corta, no **si** se corta. Una línea a medida ya no se
      // atiende con stock de producto terminado (ese SKU vive en cero hasta que planta lo
      // rola), así que el rival ya no choca contra el disponible del producto sino contra la
      // materia prima: del único rollo del color quedan 10 kg —los otros 40 ya se rolaron para
      // el primer pedido— y el rival necesita 40. El pedido rival sigue sin poder nacer, que
      // es lo que este test protege; lo que se movió es el guardrail que lo frena.
      expect(error.message.toLowerCase()).toMatch(/disponible|bobina/);
      // D-134: el mensaje ya no nombra el SKU del producto (la línea a medida ya no reserva
      // el producto, reserva el agregado): nombra el color y el espesor del agregado corto.
      expect(error.message).toContain(scenario.color.name);
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
      //
      // **D-171 reescribió el mensaje, no la regla.** Lo que corta es que la reserva sea de
      // producto terminado y no de materia prima, y eso sigue siendo verdad para UPVC —que es
      // compra-venta pura—. La palabra "stock" desapareció del texto porque desde D-171 la
      // salida que el mensaje nombraba (producir a stock) dejó de existir: lo que ahora dice
      // es que esa línea se atiende con el saldo del almacén.
      const error = await postExpectingError(api, '/api/production/roofing', {
        reservationId: reservations[0]!.id,
      });
      expect(error.status).toBe(400);
      expect(error.message).toContain('reserva producto terminado, no materia prima');
      expect(error.message).toContain('el saldo que ya hay en el almacén');
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

  test('plancha de catálogo: se fabrica contra el pedido aunque haya saldo en el almacén (D-171 revierte D-140)', async () => {
    const scenario = await setupRoofingScenario(api, {
      weightKg: '1000',
      pieceLengthMm: '3000',
    });
    const supplier = await createSupplier(api, { name: 'E2E Proveedor plancha de catálogo' });
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
      // **Diez planchas compradas y en el almacén, a propósito.**
      //
      // Bajo D-140 este saldo era la premisa del caso: la plancha reservaba producto terminado
      // y sin stock no se podía confirmar. D-171 invirtió la premisa —una plancha se rola
      // contra el pedido, como cualquier otra cobertura— y por eso el saldo pasó de ser lo que
      // el caso necesitaba a ser lo que el caso **descarta**: sigue acá para comprobar que la
      // línea reserva materia prima **igual**, sin mirarlo y sin tocarlo.
      //
      // Que ese saldo quede intacto no es un detalle: es la pregunta abierta que D-171 dejó
      // escrita (¿una línea de pedido lo toma?, ¿lo ignora?, ¿lo toma hasta donde alcanza?) y
      // la razón por la que producir a stock se cerró en vez de dejarse entreabierto. Hoy la
      // respuesta es «lo ignora», y este caso la fija para que cambiarla sea una decisión y no
      // un efecto lateral.
      const purchase = await postJson<PurchaseDto>(api, '/api/purchases', {
        supplierId: supplier.id,
        businessLine: 'metallic-roofing',
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
            productId: scenario.product.id,
            description: 'Plancha de catálogo E2E',
            qty: '10',
            unit: 'NIU',
            unitPrice: '50',
          },
        ],
      });
      trail.purchaseIds = [...(trail.purchaseIds ?? []), purchase.id];
      await postJson<PurchaseDto>(api, `/api/purchases/${purchase.id}/receive`);
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('10.000');

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

      // **D-171**: la reserva es sobre el **agregado de materia prima**, no sobre las diez
      // planchas que hay en el almacén. 4 planchas × 3 m = 12 m × 4.04 kg/m = 48.480 kg.
      const reservation = (await reservationsOf(api, order.id))[0]!;
      expect(reservation).toMatchObject({
        itemType: 'RAW_MATERIAL',
        qty: '48.480',
        unit: 'KGM',
        status: 'ACTIVE',
      });
      expect(reservation.itemId).not.toBe(scenario.product.id);
      // El saldo de producto terminado sigue ahí y **sin reservar**: nadie lo tocó.
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('10.000');
      expect((await availabilityOf(api, 'PRODUCT', scenario.product.id)).reservedQty).toBe('0.000');

      // Y la orden de producción **sí** nace de esa reserva: es la ruta que D-140 negaba
      // («producí una orden a stock desde planta») y que D-171 abrió. El ciclo completo
      // —montar, rolar, despachar— vive en `plancha-contra-pedido-d171.spec.ts`; acá alcanza
      // con que la puerta esté abierta y la OP cuelgue del pedido.
      const op = await postJson<{ id: string; status: string; salesOrderId: string | null }>(
        api,
        '/api/production/roofing',
        { reservationId: reservation.id },
      );
      trail.productionOrderIds = [op.id];
      expect(op.status).toBe('DRAFT');
      expect(op.salesOrderId).toBe(order.id);
    } finally {
      await purgeRoofingTrail(api, trail);
      await api
        .patch(`/api/suppliers/${supplier.id}`, { data: { isActive: false } })
        .catch(() => undefined);
    }
  });
});
