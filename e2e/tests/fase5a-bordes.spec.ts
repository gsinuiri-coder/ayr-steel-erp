import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, createUser, getItems, getJson, postJson } from '../helpers/api';
import {
  apiAs,
  createCuttingSupplier,
  deactivateTrail,
  getExpectingError,
  postExpectingError,
  putExpectingError,
  putJson,
  setupScenario,
  today,
  type ProductionOrderDto,
} from '../helpers/production';
import {
  availabilityOf,
  createCustomer,
  createDirectOrder,
  createQuotation,
  ordersOfCustomer,
  pdfText,
  purgeSalesTrail,
  setupCoilStock,
  stockPanel,
  updateQuotationBody,
  type QuotationDto,
  type SalesOrderDto,
} from '../helpers/sales';
import {
  buyRoofingCoil,
  createColor,
  createRoofingFinish,
  createRoofingProduct,
  metersOf,
  pieces,
  purgeRoofingOrder,
  purgeRoofingTrail,
  quoteAndOrder,
  reservationsOf,
  roofingOrder,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * Fase 5a — bordes del ciclo comercial (D-054, D-064..D-069).
 *
 * `fase5a.spec.ts` cubre el camino feliz y las reversas con **una sola línea**. Acá van los
 * huecos que quedaron.
 *
 * **D-134 cambió el objeto de la promesa de una cobertura**: una línea a medida ya no
 * reserva una bobina elegida a mano (`reserveFromCoilId`/`reserveKg` desaparecieron) sino
 * kilos del agregado de materia prima compatible (línea + color + espesor). Por eso los
 * escenarios de este archivo arman coberturas **a medida** de verdad (`setupRoofingScenario`,
 * el mismo fixture de Fase 6) y las aserciones de disponible pasan por
 * `GET /sales/stock-panel`, nunca por el saldo propio de una bobina puntual.
 *
 * - la cotización de varias líneas que **suman contra el mismo agregado** (dos productos
 *   distintos, mismo color y espesor) y fallan enteras si lo exceden — más fuerte que la
 *   original, que probaba dos líneas del mismo SKU y por eso no distinguía "por producto"
 *   de "por agregado" (D-134);
 * - la cotización de dos líneas que reservan de **dos agregados distintos** (dos colores);
 * - la reserva sobre el propio producto (`itemType=PRODUCT`), sin cambios: nunca dependió
 *   de `reserveFromCoilId`;
 * - la reserva sobre material cuya **custodia** ya está comprometida: la bobina se fue a
 *   corte (venta de bobina entera, RF-73) o la única bobina del agregado quedó montada en
 *   una OP ajena (coberturas, D-134);
 * - editar/reemitir/anular una cotización y el rótulo de su PDF;
 * - RF-66: la cotización de otro vendedor se lee pero no se opera;
 * - dos confirmaciones simultáneas sobre el mismo agregado — la auditoría de esta sesión
 *   encontró y arregló una carrera real en ese camino.
 *
 * Cada test arma su escenario contra Neon y lo deshace entero en un `finally`.
 */

/** Coberturas metálicas: la línea que exige cotización confirmada (RF-31, D-065). */
const COVER_LINE = 'metallic-roofing';
/** Drywall: cotización opcional, admite pedido directo, y es la única que se sabe producir. */
const PROFILE_LINE = 'drywall';

const allowWrites = process.env.E2E_ALLOW_WRITES === '1' || !process.env.E2E_BASE_URL;

/**
 * Igual que `fase5a.spec.ts`: cada test arma compra + recepción (y algunos, corte y
 * producción). Contra Neon cada llamada cuesta más de un segundo y con el timeout global de
 * 45 s la suite fallaría por reloj, no por defectos.
 */
test.describe.configure({ timeout: 240_000 });

interface SalesTrail {
  orderIds: string[];
  quotationIds: string[];
}

function newTrail(): SalesTrail {
  return { orderIds: [], quotationIds: [] };
}

test.describe('Fase 5a — bordes de cotización, pedido y reserva', () => {
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

  // -------------------------------------------------------------------------
  // 1. Dos productos que caen en el mismo agregado: la suma es lo que cuenta
  // -------------------------------------------------------------------------

  /**
   * El agujero que abre la segunda línea: si cada una se comprobara contra el disponible
   * **inicial**, dos líneas de 600 kg pasarían sobre un agregado de 1 000 y el pedido
   * saldría prometiendo 1 200 kg que no existen. La comprobación tiene que ver las reservas
   * que la propia transacción acaba de crear.
   *
   * D-134: se prueba con **dos productos distintos** que comparten color y espesor (la
   * cobertura y el caballete del mismo techo), no dos líneas del mismo SKU. Dos líneas del
   * mismo producto es el caso trivial y pasaría igual si la acumulación fuera por producto
   * en vez de por agregado; dos SKU que caen en el mismo agregado es lo único que prueba de
   * verdad que la promesa se lleva contra el agregado (D-134), y es además el caso real del
   * rubro.
   */
  test('dos productos que comparten el mismo agregado suman contra su disponible y fallan enteros si lo exceden', async () => {
    const supplier = await createCuttingSupplier(api);
    const finish = await createRoofingFinish(api);
    const color = await createColor(api);
    const cover = await createRoofingProduct(api, { finishId: finish.id, colorId: color.id });
    const ridge = await createRoofingProduct(api, { finishId: finish.id, colorId: color.id });
    const { coil, purchaseId } = await buyRoofingCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: color.id,
      weightKg: '1000',
    });
    const customer = await createCustomer(api);
    const trail = newTrail();

    try {
      // 150 m de cada uno son 606 kg (4.04 kg/m con el 1 % de D-165): 606 + 606 = 1 212 sobre
      // los 1 000 kg del agregado.
      const rowsBig = pieces([10, 15]); // 15 × 10 m = 150 m (el máximo de una plancha es 20 m)
      const tooMuch = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        businessLine: COVER_LINE,
        issueDate: today(),
        items: [
          {
            productId: cover.product.id,
            qty: metersOf(rowsBig),
            unitPricePen: '30',
            pieces: rowsBig,
          },
          {
            productId: ridge.product.id,
            qty: metersOf(rowsBig),
            unitPricePen: '25',
            pieces: rowsBig,
          },
        ],
      });
      trail.quotationIds.push(tooMuch.id);

      expect(tooMuch.items).toHaveLength(2);
      expect(tooMuch.items[0]).toMatchObject({
        reserveItemType: 'RAW_MATERIAL',
        reserveQty: '606.000',
      });
      expect(tooMuch.items[1]).toMatchObject({
        reserveItemType: 'RAW_MATERIAL',
        reserveQty: '606.000',
      });
      // Las dos líneas caen en el **mismo** agregado: mismo id de reserva prometido.
      expect(tooMuch.items[0]!.reserveItemId).toBe(tooMuch.items[1]!.reserveItemId);
      // 150×30=4500 y 150×25=3750 → 8250 subtotal, 1485 igv, 9735 total.
      expect(tooMuch).toMatchObject({
        subtotalPen: '8250.0000',
        igvPen: '1485.0000',
        totalPen: '9735.0000',
      });

      await postJson<QuotationDto>(api, `/api/sales/quotations/${tooMuch.id}/emit`);
      const failed = await postExpectingError(api, `/api/sales/quotations/${tooMuch.id}/confirm`);
      expect(failed.status).toBe(400);
      // La línea 1 ya reservó 606 dentro de la misma transacción: la 2 tiene que verlo.
      expect(failed.message).toContain('Línea 2');
      expect(failed.message).toContain('394.000');
      expect(failed.message).toContain('606.000');

      // Falla completa: ni pedido, ni una reserva de la línea 1 colgando.
      expect(await ordersOfCustomer(api, customer.id)).toHaveLength(0);
      const untouched = await getJson<QuotationDto>(api, `/api/sales/quotations/${tooMuch.id}`);
      expect(untouched).toMatchObject({ status: 'EMITTED', salesOrderId: null });
      const panelUntouched = await stockPanel(api, {
        businessLine: COVER_LINE,
        productIds: [cover.product.id],
      });
      expect(panelUntouched.products.find((p) => p.productId === cover.product.id)).toMatchObject({
        rawMaterialAvailableKg: '1000.000',
      });

      // La misma combinación, 404 + 505, sí entra: dos reservas contra el mismo agregado.
      const rowsA = pieces([10, 10]); // 10 × 10 m = 100 m ⇒ 404 kg (4.04 kg/m, D-165)
      const rowsB = pieces([12.5, 10]); // 10 × 12.5 m = 125 m ⇒ 505 kg (4.04 kg/m, D-165)
      const fits = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        businessLine: COVER_LINE,
        issueDate: today(),
        items: [
          { productId: cover.product.id, qty: metersOf(rowsA), unitPricePen: '30', pieces: rowsA },
          { productId: ridge.product.id, qty: metersOf(rowsB), unitPricePen: '25', pieces: rowsB },
        ],
      });
      trail.quotationIds.push(fits.id);
      await postJson<QuotationDto>(api, `/api/sales/quotations/${fits.id}/emit`);
      const order = await postJson<SalesOrderDto>(api, `/api/sales/quotations/${fits.id}/confirm`);
      trail.orderIds.push(order.id);

      expect(order.reservations).toHaveLength(2);
      expect(order.reservations.every((r) => r.itemType === 'RAW_MATERIAL')).toBe(true);
      // Las dos reservas son del **mismo** agregado (mismo color y espesor).
      expect(new Set(order.reservations.map((r) => r.itemId)).size).toBe(1);
      expect(order.reservations.map((r) => r.qty).sort()).toEqual(['404.000', '505.000']);

      const panelAfter = await stockPanel(api, {
        businessLine: COVER_LINE,
        productIds: [cover.product.id],
      });
      // 1 000 físicos − 404 − 505 = 91 disponibles (D-165).
      expect(panelAfter.products.find((p) => p.productId === cover.product.id)).toMatchObject({
        rawMaterialAvailableKg: '91.000',
      });
    } finally {
      await purgeSalesTrail(api, trail);
      await purgeRoofingTrail(api, {
        supplierId: supplier.id,
        finishId: finish.id,
        colorId: color.id,
        productIds: [cover.product.id, ridge.product.id],
        coilIds: [coil.id],
        purchaseIds: [purchaseId],
      });
    }
  });

  // -------------------------------------------------------------------------
  // 2. Dos productos con distinto color: cada uno reserva de su propio agregado
  // -------------------------------------------------------------------------

  test('dos productos con distinto color reservan cada uno de su propio agregado', async () => {
    const supplier = await createCuttingSupplier(api);
    const finish = await createRoofingFinish(api);
    const colorA = await createColor(api, '#c8102e');
    const colorB = await createColor(api, '#0033a0');
    const { product: productA } = await createRoofingProduct(api, {
      finishId: finish.id,
      colorId: colorA.id,
    });
    const { product: productB } = await createRoofingProduct(api, {
      finishId: finish.id,
      colorId: colorB.id,
    });
    const { coil: coilA, purchaseId: purchaseA } = await buyRoofingCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: colorA.id,
      weightKg: '1000',
    });
    const { coil: coilB, purchaseId: purchaseB } = await buyRoofingCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: colorB.id,
      weightKg: '1500',
    });
    const customer = await createCustomer(api);
    const trail = newTrail();

    try {
      const rowsA = pieces([17.5, 10]); // 10 × 17.5 m = 175 m ⇒ 707 kg (4.04 kg/m, D-165)
      const rowsB = pieces([15, 15]); // 15 × 15 m = 225 m ⇒ 909 kg (4.04 kg/m, D-165)
      const quotation = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        businessLine: COVER_LINE,
        issueDate: today(),
        items: [
          { productId: productA.id, qty: metersOf(rowsA), unitPricePen: '90', pieces: rowsA },
          { productId: productB.id, qty: metersOf(rowsB), unitPricePen: '90', pieces: rowsB },
        ],
      });
      trail.quotationIds.push(quotation.id);
      expect(quotation.items.map((i) => i.reserveItemType)).toEqual([
        'RAW_MATERIAL',
        'RAW_MATERIAL',
      ]);
      const specIds = quotation.items.map((i) => i.reserveItemId);
      expect(specIds[0]).not.toBe(specIds[1]); // agregados distintos, por color
      // 175×90=15750 y 225×90=20250 → 36000 subtotal, 6480 igv, 42480 total.
      expect(quotation).toMatchObject({
        subtotalPen: '36000.0000',
        igvPen: '6480.0000',
        totalPen: '42480.0000',
      });

      await postJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}/emit`);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds.push(order.id);
      expect(order.reservations).toHaveLength(2);

      const byItem = new Map(order.reservations.map((r) => [r.itemId, r]));
      expect(byItem.get(specIds[0]!)).toMatchObject({ qty: '707.000', status: 'ACTIVE' });
      expect(byItem.get(specIds[1]!)).toMatchObject({ qty: '909.000', status: 'ACTIVE' });

      // 1 000 físicos del agregado de A − 707 prometidos (D-165: 175 m × 4.04 kg/m).
      const panelA = await stockPanel(api, { businessLine: COVER_LINE, productIds: [productA.id] });
      expect(panelA.products.find((p) => p.productId === productA.id)).toMatchObject({
        rawMaterialAvailableKg: '293.000',
      });
      const panelB = await stockPanel(api, { businessLine: COVER_LINE, productIds: [productB.id] });
      expect(panelB.products.find((p) => p.productId === productB.id)).toMatchObject({
        rawMaterialAvailableKg: '591.000',
      });

      // Anular el pedido libera las dos, no una: la reversa también es "todo o nada".
      const cancelled = await postJson<SalesOrderDto>(api, `/api/sales/orders/${order.id}/cancel`, {
        reason: 'El cliente se echó atrás',
      });
      expect(cancelled.reservations.every((r) => r.status === 'RELEASED')).toBe(true);
      const panelAAfter = await stockPanel(api, {
        businessLine: COVER_LINE,
        productIds: [productA.id],
      });
      expect(panelAAfter.products.find((p) => p.productId === productA.id)).toMatchObject({
        rawMaterialAvailableKg: '1000.000',
      });
      const panelBAfter = await stockPanel(api, {
        businessLine: COVER_LINE,
        productIds: [productB.id],
      });
      expect(panelBAfter.products.find((p) => p.productId === productB.id)).toMatchObject({
        rawMaterialAvailableKg: '1500.000',
      });
    } finally {
      await purgeSalesTrail(api, trail);
      await purgeRoofingTrail(api, {
        supplierId: supplier.id,
        finishId: finish.id,
        colorId: colorA.id,
        productIds: [productA.id, productB.id],
        coilIds: [coilA.id, coilB.id],
        purchaseIds: [purchaseA, purchaseB],
      });
      await api
        .patch(`/api/colors/${colorB.id}`, { data: { isActive: false } })
        .catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // 3. Reserva sobre el propio producto (`itemType=PRODUCT`) — sin cambios
  // -------------------------------------------------------------------------

  /**
   * El otro caso de D-065: sin `saleCoilId` ni un producto a medida, la línea promete **el
   * propio producto** en su unidad de venta. Es el perfil que se vende de stock. Este test
   * nunca dependió de `reserveFromCoilId`, así que D-134 no le cambia nada.
   *
   * La invariante de cantidad tiene que proteger esas piezas igual que protege los kilos de
   * una bobina. Hoy la **única** operación que saca piezas terminadas del almacén es revertir
   * un reporte de producción (el despacho es Fase 5b), así que es esa la que se prueba.
   */
  test('un pedido de perfiles reserva el propio producto y bloquea la reversa que sacaría esas piezas', async () => {
    const customer = await createCustomer(api);
    const scenario = await setupScenario(api);
    const strip = scenario.strips[0]!;
    const trail = newTrail();
    const productionOrderIds: string[] = [];

    try {
      // 100 piezas en stock, fabricadas contra el fleje.
      const op = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: scenario.product.id,
      });
      productionOrderIds.push(op.id);
      await postJson<ProductionOrderDto>(api, `/api/production/${op.id}/consume`, {
        coilId: strip.id,
        qtyKg: '400',
      });
      const reported = await postJson<ProductionOrderDto>(api, `/api/production/${op.id}/report`, {
        pieces: 100,
      });
      const reportId = reported.reports.find((r) => r.status === 'ACTIVE')!.id;
      expect(await availabilityOf(api, 'PRODUCT', scenario.product.id)).toMatchObject({
        qty: '100.000',
        reservedQty: '0.000',
        availableQty: '100.000',
      });

      // La suma también manda cuando lo reservado es el propio producto: dos líneas de 60
      // piezas sobre 100 en stock no entran, y la segunda tiene que ver lo que la primera
      // acaba de prometer dentro de la misma transacción.
      const tooMany = await postExpectingError(api, '/api/sales/orders', {
        customerId: customer.id,
        businessLine: PROFILE_LINE,
        issueDate: today(),
        items: [
          { productId: scenario.product.id, qty: '60', unitPricePen: '35.0000' },
          { productId: scenario.product.id, qty: '60', unitPricePen: '35.0000' },
        ],
      });
      expect(tooMany.status).toBe(400);
      expect(tooMany.message).toContain('Línea 2');
      expect(tooMany.message).toContain('40.000');
      expect(await ordersOfCustomer(api, customer.id)).toHaveLength(0);
      expect(await availabilityOf(api, 'PRODUCT', scenario.product.id)).toMatchObject({
        reservedQty: '0.000',
      });

      // Pedido directo **sin** bobina: la reserva cae sobre el producto terminado.
      const order = await createDirectOrder(api, {
        customerId: customer.id,
        businessLine: PROFILE_LINE,
        items: [{ productId: scenario.product.id, qty: '40', unitPricePen: '35.0000' }],
      });
      trail.orderIds.push(order.id);
      // El perfil del escenario no tiene precio de lista: el vendedor lo escribió a mano.
      expect(order.items[0]).toMatchObject({
        listPricePen: null,
        unitPricePen: '35.0000',
        reserveItemType: 'PRODUCT',
        reserveItemId: scenario.product.id,
        reserveQty: '40.000',
        reserveUnit: 'NIU',
      });
      expect(order.reservations[0]).toMatchObject({
        itemType: 'PRODUCT',
        itemId: scenario.product.id,
        qty: '40.000',
        unit: 'NIU',
        status: 'ACTIVE',
      });
      expect(await availabilityOf(api, 'PRODUCT', scenario.product.id)).toMatchObject({
        qty: '100.000',
        reservedQty: '40.000',
        availableQty: '60.000',
      });

      // Revertir el reporte sacaría las 100 piezas y dejaría 0 con 40 prometidas: la
      // invariante de cantidad (D-066) tiene que cortarlo nombrando el pedido.
      const blocked = await postExpectingError(
        api,
        `/api/production/${op.id}/reports/${reportId}/reverse`,
        { reason: 'Intento con piezas prometidas' },
      );
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain('40.000');
      expect(blocked.message).toContain(order.code);

      // Y liberada la reserva, la misma reversa pasa: el bloqueo era la promesa, no el
      // reporte.
      await postJson(api, `/api/sales/reservations/${order.reservations[0]!.id}/release`, {
        reason: 'Liberación para comprobar que el bloqueo era la reserva',
      });
      await postJson<ProductionOrderDto>(
        api,
        `/api/production/${op.id}/reports/${reportId}/reverse`,
        { reason: 'Deshacer la corrida de prueba' },
      );
      expect(await availabilityOf(api, 'PRODUCT', scenario.product.id)).toMatchObject({
        qty: '0.000',
        reservedQty: '0.000',
      });
    } finally {
      await purgeSalesTrail(api, trail);
      await deactivateTrail(api, {
        productionOrderIds,
        cuttingOrderId: scenario.cuttingOrderId,
        motherId: scenario.mother.id,
        purchaseId: scenario.purchaseId,
        supplierId: scenario.supplier.id,
        finish: scenario.finish,
        productId: scenario.product.id,
      });
    }
  });

  // -------------------------------------------------------------------------
  // 4. Custodia comprometida entre cotizar y confirmar
  // -------------------------------------------------------------------------

  /**
   * Ni el envío a corte (D-050) ni el montaje en una OP (D-060) mueven un gramo de kardex,
   * así que el saldo se ve intacto y el disponible alcanza de sobra. Confirmar igual dejaría
   * al pedido prometiendo material que ya no está en casa.
   *
   * D-134: ya no se puede reservar una fracción de kilos de una bobina desde una línea de
   * venta. Lo que sigue vivo, y se comporta igual, es vender la bobina **entera** (RF-73,
   * `saleCoilId`): reserva su saldo completo, y un envío a corte de por medio la deja
   * `IN_THIRD_PARTY`, que el mismo guardrail de disponibilidad de `createReservations` sigue
   * rechazando antes de confirmar.
   */
  test('no se confirma una cotización cuya bobina (vendida entera) se fue a corte entre medias', async () => {
    const customer = await createCustomer(api);
    const stock = await setupCoilStock(api, { lineCode: PROFILE_LINE, weightKg: '2000' });
    const trail = newTrail();
    let cuttingOrderId: string | undefined;

    try {
      const quotation = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: today(),
        items: [{ saleCoilId: stock.coil.id, qty: stock.coil.availableKg, unitPricePen: '6' }],
      });
      trail.quotationIds.push(quotation.id);
      await postJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}/emit`);

      // La bobina se va a un tercero después de cotizarla y antes de confirmar.
      const cutting = await postJson<{ id: string }>(api, '/api/cutting', {
        supplierId: stock.supplier.id,
        notes: 'Envío E2E que se lleva la bobina cotizada',
        coils: [
          {
            coilId: stock.coil.id,
            widthPlanMm: [{ widthMm: '600', stripsCount: 2 }],
            expectedKerfLossMm: '0',
          },
        ],
      });
      cuttingOrderId = cutting.id;

      const blocked = await postExpectingError(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      expect(blocked.status).toBe(400);
      // El mensaje tiene que decir qué bobina y en qué estado quedó, o el vendedor no sabe
      // si esperar la vuelta del corte o vender otro rollo.
      expect(blocked.message).toContain(stock.coil.code);
      expect(blocked.message).toContain('IN_THIRD_PARTY');

      // Y no queda el pedido creado: la transacción se cae entera.
      expect(await ordersOfCustomer(api, customer.id)).toHaveLength(0);
      const untouched = await getJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}`);
      expect(untouched).toMatchObject({ status: 'EMITTED', salesOrderId: null });
      expect(await availabilityOf(api, 'COIL', stock.coil.id)).toMatchObject({
        reservedQty: '0.000',
      });
    } finally {
      await purgeSalesTrail(api, trail);
      await deactivateTrail(api, {
        cuttingOrderId,
        motherId: stock.coil.id,
        purchaseId: stock.purchaseId,
        supplierId: stock.supplier.id,
        finish: stock.finish,
      });
    }
  });

  /**
   * Qué bloquea —y qué **no**— una bobina montada en una orden de producción ajena.
   *
   * Este caso cambió dos veces. D-134 retiró el mecanismo sobre el que estaba construido (un
   * producto de drywall reservando un fleje concreto) y lo reescribió contra el agregado; y
   * **D-154 invirtió su resultado**, que es lo que codifica ahora.
   *
   * Hasta D-154, montar sacaba del disponible el **rollo entero**, así que un pedido de 200 kg
   * que montaba un rollo de 1 000 dejaba el agregado en cero y ningún otro pedido podía
   * prometer nada. Eso era el defecto, no la regla: el rollo tiene 1 000 kg reales y ese
   * pedido solo prometió 200. El mismo error, visto desde planta, era el «la operación dejaría
   * 0.000 kg libres» sobre una bobina llena que disparó D-154.
   *
   * Lo que queda es la separación que importa: **el material se promete por lo prometido**
   * —800 kg siguen libres— y lo que sigue reservado es **la agenda**: mientras A la tenga
   * montada, la OP de B no puede montar esa misma bobina (`assertStripsNotAssigned`). Y el
   * agregado sigue cortando cuando el faltante es de verdad.
   */
  test('la bobina montada en una OP ajena no bloquea prometer, pero sí bloquea montarla otra vez', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '1000' });
    const customerA = await createCustomer(api);
    const customerB = await createCustomer(api);
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
    const productionOrderIds: string[] = [];

    try {
      // Pedido A: cotiza, confirma y monta la única bobina del agregado en su OP.
      const rowsA = pieces([10, 5]); // 5 × 10 m = 50 m ⇒ 200 kg
      const { quotation: qA, order: orderA } = await quoteAndOrder(api, {
        customerId: customerA.id,
        productId: scenario.product.id,
        rows: rowsA,
      });
      trail.quotationIds = [qA.id];
      trail.orderIds = [orderA.id];
      const reservationA = (await reservationsOf(api, orderA.id))[0]!;
      const opA = await roofingOrder(api, reservationA.id);
      productionOrderIds.push(opA.id);
      await postJson(api, `/api/production/roofing/${opA.id}/coils`, {
        coilId: scenario.coil.id,
      });

      // D-154: con el rollo entero montado en la OP de A, el disponible del agregado son los
      // 1 000 kg físicos menos los 200 que A prometió. **800, no cero**: los kilos que A no
      // prometió siguen siendo del almacén y vuelven a él cuando la orden cierre.
      const afterMount = await stockPanel(api, {
        businessLine: COVER_LINE,
        productIds: [scenario.product.id],
      });
      expect(afterMount.products.find((p) => p.productId === scenario.product.id)).toMatchObject({
        rawMaterialAvailableKg: '798.000',
      });

      // Pedido B (otro cliente) sobre el mismo agregado: **confirma sin problema**, porque hay
      // material de verdad para los dos. Hasta D-154 esto era un 400 que nombraba la orden de
      // A, y era el defecto: le decía que no a un pedido que el almacén podía cumplir.
      const rowsB = pieces([10, 5]); // 5 × 10 m = 50 m ⇒ 200 kg
      const quotationB = await createQuotation(api, {
        customerId: customerB.id,
        businessLine: COVER_LINE,
        productId: scenario.product.id,
        qty: metersOf(rowsB),
        unitPricePen: '30',
        pieces: rowsB,
      });
      trail.quotationIds = [qA.id, quotationB.id];
      await postJson(api, `/api/sales/quotations/${quotationB.id}/emit`);
      const orderB = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotationB.id}/confirm`,
      );
      trail.orderIds = [orderA.id, orderB.id];
      expect(await ordersOfCustomer(api, customerB.id)).toHaveLength(1);

      // **Lo que sigue bloqueado es la agenda, no el material**: la OP de B no puede montar la
      // bobina que A tiene puesta, y el 400 nombra la orden que la retiene. Es la mitad de
      // D-060 que D-154 no tocó, y la que de verdad protege una corrida en marcha.
      const reservationB = (await reservationsOf(api, orderB.id))[0]!;
      const opB = await roofingOrder(api, reservationB.id);
      productionOrderIds.push(opB.id);
      const busy = await postExpectingError(api, `/api/production/roofing/${opB.id}/coils`, {
        coilId: scenario.coil.id,
      });
      expect(busy.status).toBe(400);
      expect(busy.message).toContain(opA.code);

      // Y el agregado sigue cortando cuando el faltante es real: con 400 kg ya prometidos,
      // un tercer pedido de 1 000 kg no entra.
      const rowsC = pieces([10, 25]); // 25 × 10 m = 250 m ⇒ 1 000 kg
      const quotationC = await createQuotation(api, {
        customerId: customerB.id,
        businessLine: COVER_LINE,
        productId: scenario.product.id,
        qty: metersOf(rowsC),
        unitPricePen: '30',
        pieces: rowsC,
      });
      trail.quotationIds = [qA.id, quotationB.id, quotationC.id];
      await postJson(api, `/api/sales/quotations/${quotationC.id}/emit`);
      const blocked = await postExpectingError(
        api,
        `/api/sales/quotations/${quotationC.id}/confirm`,
      );
      expect(blocked.status).toBe(400);
      const untouched = await getJson<QuotationDto>(api, `/api/sales/quotations/${quotationC.id}`);
      expect(untouched).toMatchObject({ status: 'EMITTED', salesOrderId: null });
    } finally {
      for (const opId of [...productionOrderIds].reverse()) {
        await purgeRoofingOrder(api, opId).catch(() => undefined);
      }
      await purgeRoofingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 5. Editar, reemitir, anular y el PDF (RF-65, RF-66, D-068)
  // -------------------------------------------------------------------------

  test('el borrador se edita y no tiene PDF; la emitida no se edita y su anulación sale rotulada', async () => {
    const supplier = await createCuttingSupplier(api);
    const finish = await createRoofingFinish(api);
    const colorA = await createColor(api, '#c8102e');
    const colorB = await createColor(api, '#0033a0');
    const cover = await createRoofingProduct(api, {
      finishId: finish.id,
      colorId: colorA.id,
      listPricePen: '120',
    });
    const ridge = await createRoofingProduct(api, {
      finishId: finish.id,
      colorId: colorB.id,
      listPricePen: '62.5',
    });
    const { coil: coilA, purchaseId: purchaseA } = await buyRoofingCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: colorA.id,
      weightKg: '3000',
    });
    const { coil: coilB, purchaseId: purchaseB } = await buyRoofingCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: colorB.id,
      weightKg: '3000',
    });
    const customer = await createCustomer(api);
    const trail = newTrail();

    try {
      const initialRows = pieces([10, 1]); // 10 m ⇒ 40 kg
      const draft = await createQuotation(api, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: cover.product.id,
        qty: metersOf(initialRows),
        pieces: initialRows,
      });
      trail.quotationIds.push(draft.id);
      expect(draft.totalPen).toBe('1416.0000');

      // Un borrador todavía no es un documento.
      const noPdf = await getExpectingError(api, `/api/sales/quotations/${draft.id}/pdf`);
      expect(noPdf.status).toBe(400);

      // RF-66: editar reemplaza las líneas completas y recalcula los totales.
      const editedRowsCover = pieces([5, 1]); // 5 m ⇒ 20 kg
      const editedRowsRidge = pieces([4, 1]); // 4 m ⇒ 16 kg
      const edited = await putJson<QuotationDto>(
        api,
        `/api/sales/quotations/${draft.id}`,
        updateQuotationBody({
          customerId: customer.id,
          items: [
            {
              productId: cover.product.id,
              qty: metersOf(editedRowsCover),
              pieces: editedRowsCover,
            },
            {
              productId: ridge.product.id,
              qty: metersOf(editedRowsRidge),
              pieces: editedRowsRidge,
            },
          ],
          validityDays: 15,
        }),
      );
      expect(edited.items).toHaveLength(2);
      expect(edited.items.map((i) => i.lineNumber)).toEqual([1, 2]);
      // 5×120=600 y 4×62.5=250 → 850 de subtotal, 153 de IGV.
      expect(edited).toMatchObject({
        status: 'DRAFT',
        subtotalPen: '850.0000',
        igvPen: '153.0000',
        totalPen: '1003.0000',
      });
      expect(edited.items[0]).toMatchObject({
        reserveItemType: 'RAW_MATERIAL',
        reserveQty: '20.200',
      });
      expect(edited.items[1]).toMatchObject({
        reserveItemType: 'RAW_MATERIAL',
        reserveQty: '16.160',
      });

      // Emitida: el PDF existe y la edición se cierra.
      const emitted = await postJson<QuotationDto>(api, `/api/sales/quotations/${draft.id}/emit`);
      expect(emitted.status).toBe('EMITTED');
      const pdf = await api.get(`/api/sales/quotations/${draft.id}/pdf`);
      expect(pdf.ok()).toBe(true);
      const emittedText = pdfText(await pdf.body());
      expect(emittedText).toContain(emitted.code);
      expect(emittedText, 'una cotización vigente no lleva rótulo de estado').not.toContain(
        'COTIZACI',
      );

      const cannotEditRows = pieces([1, 1]);
      const cannotEdit = await putExpectingError(
        api,
        `/api/sales/quotations/${draft.id}`,
        updateQuotationBody({
          customerId: customer.id,
          items: [
            {
              productId: cover.product.id,
              qty: metersOf(cannotEditRows),
              pieces: cannotEditRows,
            },
          ],
        }),
      );
      expect(cannotEdit.status).toBe(400);
      expect(cannotEdit.message).toContain('borrador');
      // Y no cambió nada: el rechazo es antes de tocar las líneas.
      const stillEmitted = await getJson<QuotationDto>(api, `/api/sales/quotations/${draft.id}`);
      expect(stillEmitted).toMatchObject({ status: 'EMITTED', totalPen: '1003.0000' });
      expect(stillEmitted.items).toHaveLength(2);

      // Anular una emitida (RF-65) y comprobar que su PDF sale rotulado.
      const cancelled = await postJson<QuotationDto>(
        api,
        `/api/sales/quotations/${draft.id}/cancel`,
        { reason: 'El cliente compró en otro lado' },
      );
      expect(cancelled.status).toBe('CANCELLED');
      const cancelledPdf = await api.get(`/api/sales/quotations/${draft.id}/pdf`);
      expect(cancelledPdf.ok()).toBe(true);
      expect(pdfText(await cancelledPdf.body())).toContain('COTIZACI');

      // Anular un borrador también entra (RF-65: cualquier estado no confirmado).
      const scrappedRows = pieces([2, 1]);
      const scrapped = await createQuotation(api, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: cover.product.id,
        qty: metersOf(scrappedRows),
        pieces: scrappedRows,
      });
      trail.quotationIds.push(scrapped.id);
      const scrappedCancelled = await postJson<QuotationDto>(
        api,
        `/api/sales/quotations/${scrapped.id}/cancel`,
        { reason: 'Borrador equivocado' },
      );
      expect(scrappedCancelled.status).toBe('CANCELLED');
      // Anulada dos veces, no: la reversa es idempotente y lo dice (mismo criterio D-061).
      const twice = await postExpectingError(api, `/api/sales/quotations/${scrapped.id}/cancel`, {
        reason: 'Otra vez',
      });
      expect(twice.status).toBe(409);

      // Nada de esto tocó el inventario: cotizar no reserva (D-054).
      const panelCover = await stockPanel(api, {
        businessLine: COVER_LINE,
        productIds: [cover.product.id],
      });
      expect(panelCover.products.find((p) => p.productId === cover.product.id)).toMatchObject({
        rawMaterialAvailableKg: '3000.000',
      });
      const panelRidge = await stockPanel(api, {
        businessLine: COVER_LINE,
        productIds: [ridge.product.id],
      });
      expect(panelRidge.products.find((p) => p.productId === ridge.product.id)).toMatchObject({
        rawMaterialAvailableKg: '3000.000',
      });
    } finally {
      await purgeSalesTrail(api, trail);
      await purgeRoofingTrail(api, {
        supplierId: supplier.id,
        finishId: finish.id,
        colorId: colorA.id,
        productIds: [cover.product.id, ridge.product.id],
        coilIds: [coilA.id, coilB.id],
        purchaseIds: [purchaseA, purchaseB],
      });
      await api
        .patch(`/api/colors/${colorB.id}`, { data: { isActive: false } })
        .catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // 6. Confirmar es la puerta que vende: revalida cliente y producto
  // -------------------------------------------------------------------------

  /**
   * D-065 puso cotización y pedido directo en **un solo camino** para que el alta directa
   * no pudiera admitir lo que la cotización rechaza. La confirmación es el tercer camino, y
   * es el que de verdad vende: crea el pedido y compromete stock.
   */
  test('confirmar rechaza una cotización cuyo cliente o producto se desactivó después de emitirla', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
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
      const emitted: QuotationDto[] = [];
      for (let i = 0; i < 2; i += 1) {
        const rows = pieces([5, 1]); // 5 m ⇒ 20 kg, generoso frente a los 2000 kg del agregado
        const q = await createQuotation(api, {
          customerId: customer.id,
          businessLine: COVER_LINE,
          productId: scenario.product.id,
          qty: metersOf(rows),
          unitPricePen: '65',
          pieces: rows,
        });
        trail.quotationIds!.push(q.id);
        emitted.push(await postJson<QuotationDto>(api, `/api/sales/quotations/${q.id}/emit`));
      }

      /**
       * Confirma y, si el API deja pasar lo que no debería, apunta el pedido en el rastro.
       */
      const confirmTracking = async (
        quotationId: string,
      ): Promise<{ status: number; message: string }> => {
        const res = await api.post(`/api/sales/quotations/${quotationId}/confirm`);
        if (res.ok()) {
          const order = (await res.json()) as SalesOrderDto;
          trail.orderIds!.push(order.id);
          return { status: res.status(), message: `se creó el pedido ${order.code}` };
        }
        const body = (await res.json()) as { message?: string | string[] };
        return {
          status: res.status(),
          message: Array.isArray(body.message) ? body.message.join(', ') : (body.message ?? ''),
        };
      };

      // (a) El cliente queda desactivado entre emitir y confirmar.
      await api.patch(`/api/customers/${customer.id}`, { data: { isActive: false } });
      const blockedByCustomer = await confirmTracking(emitted[0]!.id);
      await api.patch(`/api/customers/${customer.id}`, { data: { isActive: true } });

      // (b) El producto se descontinúa entre emitir y confirmar.
      await api.patch(`/api/catalog/${scenario.product.id}`, { data: { isActive: false } });
      const blockedByProduct = await confirmTracking(emitted[1]!.id);
      await api.patch(`/api/catalog/${scenario.product.id}`, { data: { isActive: true } });

      expect
        .soft(
          blockedByCustomer,
          'crear la cotización y el pedido directo rechazan un cliente desactivado; confirmar tiene que rechazarlo igual',
        )
        .toMatchObject({ status: 400 });
      expect.soft(blockedByCustomer.message).toContain('desactivado');
      expect
        .soft(
          blockedByProduct,
          'cotizar un producto desactivado se rechaza; confirmarlo tiene que rechazarse igual',
        )
        .toMatchObject({ status: 400 });
      expect.soft(blockedByProduct.message).toContain('desactivado');

      // Ninguna de las dos puede haber comprometido material.
      const panel = await stockPanel(api, {
        businessLine: COVER_LINE,
        productIds: [scenario.product.id],
      });
      expect
        .soft(panel.products.find((p) => p.productId === scenario.product.id))
        .toMatchObject({ rawMaterialAvailableKg: '2000.000' });
      expect.soft(await ordersOfCustomer(api, customer.id)).toHaveLength(0);
    } finally {
      await api
        .patch(`/api/customers/${customer.id}`, { data: { isActive: true } })
        .catch(() => undefined);
      await purgeRoofingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 7. RF-66 — la cotización de otro vendedor se lee, no se opera
  // -------------------------------------------------------------------------

  test('un vendedor lee la cotización de otro pero no la edita, emite, confirma ni anula', async ({
    baseURL,
  }) => {
    const scenario = await setupRoofingScenario(api, { weightKg: '1500' });
    const customer = await createCustomer(api);
    const author = await createUser(api, 'VENDEDOR');
    const other = await createUser(api, 'VENDEDOR');
    const authorApi = await apiAs(baseURL!, author);
    const otherApi = await apiAs(baseURL!, other);
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
      const rows = pieces([10, 1]); // 10 m ⇒ 40 kg
      const quotation = await createQuotation(authorApi, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: scenario.product.id,
        qty: metersOf(rows),
        unitPricePen: '45',
        pieces: rows,
      });
      trail.quotationIds = [quotation.id];

      // Leerla sí: RF-69 pide una lista de cotizaciones, no una lista por vendedor.
      const read = await getJson<QuotationDto>(otherApi, `/api/sales/quotations/${quotation.id}`);
      expect(read.id).toBe(quotation.id);
      const list = await getItems<{ id: string }>(otherApi, '/api/sales/quotations');
      expect(list.map((q) => q.id)).toContain(quotation.id);

      // Operarla, no.
      const editRows = pieces([1, 1]);
      const cannotEdit = await putExpectingError(
        otherApi,
        `/api/sales/quotations/${quotation.id}`,
        updateQuotationBody({
          customerId: customer.id,
          items: [{ productId: scenario.product.id, qty: metersOf(editRows), pieces: editRows }],
        }),
      );
      expect(cannotEdit.status).toBe(403);
      const cannotEmit = await postExpectingError(
        otherApi,
        `/api/sales/quotations/${quotation.id}/emit`,
      );
      expect(cannotEmit.status).toBe(403);
      const cannotCancel = await postExpectingError(
        otherApi,
        `/api/sales/quotations/${quotation.id}/cancel`,
        { reason: 'Intento sobre la cotización de otro' },
      );
      expect(cannotCancel.status).toBe(403);

      // El ADMINISTRADOR sí opera cualquiera: emite la del vendedor…
      const emitted = await postJson<QuotationDto>(
        api,
        `/api/sales/quotations/${quotation.id}/emit`,
      );
      expect(emitted.status).toBe('EMITTED');

      // …y confirmar sigue cerrado para el vendedor ajeno, que es el acto que compromete
      // stock a nombre del cliente de otro.
      const cannotConfirm = await postExpectingError(
        otherApi,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      expect(cannotConfirm.status).toBe(403);
      const panelBefore = await stockPanel(api, {
        businessLine: COVER_LINE,
        productIds: [scenario.product.id],
      });
      expect(panelBefore.products.find((p) => p.productId === scenario.product.id)).toMatchObject({
        rawMaterialAvailableKg: '1500.000',
      });

      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds = [order.id];
      expect(order.reservations[0]!.status).toBe('ACTIVE');
    } finally {
      await authorApi.dispose();
      await otherApi.dispose();
      await purgeRoofingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 8. El PDF de una vencida (D-068 + D-069)
  // -------------------------------------------------------------------------

  test('el PDF de una cotización vencida sale rotulado aunque el job todavía no la haya marcado', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '1200' });
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
      // Emitida hace 10 días con un día de vigencia: venció hace nueve.
      const rows = pieces([4, 1]); // 4 m ⇒ 16 kg
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: scenario.product.id,
        qty: metersOf(rows),
        unitPricePen: '50',
        pieces: rows,
        issueDate: isoDaysFromTodayFallback(-10),
        validityDays: 1,
      });
      trail.quotationIds = [quotation.id];
      const emitted = await postJson<QuotationDto>(
        api,
        `/api/sales/quotations/${quotation.id}/emit`,
      );
      // El estado todavía dice EMITIDA porque el job no corrió; la fecha ya dice otra cosa.
      expect(emitted).toMatchObject({ status: 'EMITTED', isExpired: true });
      // Y el API ya no la deja confirmar: la vigencia se revalida (D-069).
      const cannotConfirm = await postExpectingError(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      expect(cannotConfirm.status).toBe(400);

      const beforeJob = await api.get(`/api/sales/quotations/${quotation.id}/pdf`);
      expect(beforeJob.ok()).toBe(true);
      expect(
        pdfText(await beforeJob.body()),
        'el PDF de una cotización que ya venció no puede salir sin rótulo solo porque el job no corrió',
      ).toContain('COTIZACI');

      // Con el job al día sí lo lleva: el estado ya no engaña a nadie.
      await postJson<{ expired: number }>(api, '/api/sales/quotations/expire');
      const marked = await getJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}`);
      expect(marked.status).toBe('EXPIRED');
      const afterJob = await api.get(`/api/sales/quotations/${quotation.id}/pdf`);
      expect(pdfText(await afterJob.body())).toContain('COTIZACI');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 9. Dos confirmaciones simultáneas sobre el mismo agregado
  // -------------------------------------------------------------------------

  /**
   * El disponible alcanza para una sola. `createReservations` bloquea primero las bobinas
   * del agregado (`rawMaterialAvailability({ lockCoils: true })`) y después crea la reserva,
   * así que las dos transacciones se serializan: una gana y la otra tiene que fallar
   * **limpio** (400 del dominio, no un 500 de deadlock) y sin dejar media reserva. Es la
   * prueba de concurrencia **del agregado**: la auditoría de esta sesión encontró y arregló
   * una carrera real en este mismo camino.
   */
  test('dos confirmaciones simultáneas sobre el mismo agregado: una gana y la otra falla limpio', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '1000' });
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
      // 150 m y 175 m son 600 y 700 kg: cada una sola entra contra 1000, las dos juntas no.
      const quotations: QuotationDto[] = [];
      for (const meters of [150, 175]) {
        // Piezas de 5 m (dentro del máximo de 20 m) hasta sumar el total buscado.
        const rows = pieces([5, meters / 5]);
        const q = await createQuotation(api, {
          customerId: customer.id,
          businessLine: COVER_LINE,
          productId: scenario.product.id,
          qty: metersOf(rows),
          unitPricePen: '55',
          pieces: rows,
        });
        trail.quotationIds!.push(q.id);
        await postJson<QuotationDto>(api, `/api/sales/quotations/${q.id}/emit`);
        quotations.push(q);
      }

      const responses = await Promise.all(
        quotations.map((q) => api.post(`/api/sales/quotations/${q.id}/confirm`)),
      );
      const winners = responses.filter((r) => r.ok());
      const losers = responses.filter((r) => !r.ok());
      expect(winners, 'solo una confirmación puede ganar contra el mismo agregado').toHaveLength(1);
      expect(losers).toHaveLength(1);

      const loserBody = (await losers[0]!.json()) as { message?: string };
      expect(
        losers[0]!.status(),
        `la perdedora debe fallar con un 400 del dominio, no con un error de base: ${JSON.stringify(loserBody)}`,
      ).toBe(400);

      const winner = (await winners[0]!.json()) as SalesOrderDto;
      trail.orderIds!.push(winner.id);

      const winnerKg = Number(winner.reservations[0]!.qty);
      const panel = await stockPanel(api, {
        businessLine: COVER_LINE,
        productIds: [scenario.product.id],
      });
      expect(panel.products.find((p) => p.productId === scenario.product.id)).toMatchObject({
        rawMaterialAvailableKg: (1000 - winnerKg).toFixed(3),
      });

      // Una sola reserva viva contra este pedido y ningún pedido huérfano de la perdedora.
      // `/api/sales/reservations` devuelve un arreglo plano, no la envoltura paginada
      // ({items, total, ...}) de los otros listados (D-113): no pasa por `getItems`.
      const live = await getJson<{ id: string }[]>(
        api,
        `/api/sales/reservations?salesOrderId=${winner.id}&status=ACTIVE`,
      );
      expect(live).toHaveLength(1);
      expect(await ordersOfCustomer(api, customer.id)).toHaveLength(1);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});

/**
 * `isoDaysFromToday` (de `helpers/sales.ts`) ya evita el corte en UTC (D-112/D-131); se
 * envuelve acá solo para no importar dos veces el mismo nombre bajo otro alias en este
 * archivo, que ya usa `today` de `helpers/production`.
 */
function isoDaysFromTodayFallback(days: number): string {
  const [year, month, day] = todayFromProduction().split('-').map(Number);
  const noonUtc = new Date(Date.UTC(year!, month! - 1, day!, 12, 0, 0));
  noonUtc.setUTCDate(noonUtc.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(noonUtc);
}

function todayFromProduction(): string {
  return today();
}
