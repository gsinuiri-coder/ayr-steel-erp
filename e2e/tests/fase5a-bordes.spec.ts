import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, createUser, getJson, postJson } from '../helpers/api';
import {
  apiAs,
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
  cancelCoils,
  createCustomer,
  createDirectOrder,
  createQuotation,
  createQuotationWithLines,
  createSellableProduct,
  isoDaysFromToday,
  ordersOfCustomer,
  pdfText,
  purgeSalesTrail,
  setupCoilBatch,
  setupCoilStock,
  updateQuotationBody,
  type QuotationDto,
  type SalesOrderDto,
} from '../helpers/sales';

/**
 * Fase 5a — bordes del ciclo comercial (D-054, D-064..D-069).
 *
 * `fase5a.spec.ts` cubre el camino feliz y las reversas con **una sola línea**. Acá van los
 * huecos que quedaron:
 *
 * - la cotización de varias líneas (misma bobina, bobinas distintas, precio de lista contra
 *   precio editado, y el total del documento como Σ subtotales + Σ IGV);
 * - la reserva sobre el propio producto (`itemType=PRODUCT`), que solo estaba probada de
 *   refilón, y la única operación que hoy saca piezas del almacén;
 * - la reserva sobre material cuya **custodia** ya está comprometida: la bobina se fue a
 *   corte, o el fleje quedó montado en una OP, entre cotizar y confirmar;
 * - editar/reemitir/anular una cotización y el rótulo de su PDF;
 * - RF-66: la cotización de otro vendedor se lee pero no se opera;
 * - dos confirmaciones simultáneas sobre la misma bobina.
 *
 * Cada test arma su escenario contra Neon y lo deshace entero en un `finally`: un pedido con
 * una reserva viva bloquea la anulación de la bobina y de su compra, así que dejar basura
 * acá se paga en la purga de producción.
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
  // 1. Varias líneas sobre la misma bobina: la suma es lo que cuenta
  // -------------------------------------------------------------------------

  /**
   * El agujero que abre la segunda línea: si cada una se comprobara contra el disponible
   * **inicial**, dos líneas de 600 kg pasarían sobre una bobina de 1 000 y el pedido saldría
   * prometiendo 1 200 kg que no existen. La comprobación tiene que ver las reservas que la
   * propia transacción acaba de crear.
   */
  test('dos líneas sobre la misma bobina suman contra el disponible y fallan enteras si lo exceden', async () => {
    const customer = await createCustomer(api);
    const stock = await setupCoilStock(api, { lineCode: COVER_LINE, weightKg: '1000' });
    const cover = await createSellableProduct(api, {
      lineCode: COVER_LINE,
      listPricePen: '120.0000',
    });
    const ridge = await createSellableProduct(api, {
      lineCode: COVER_LINE,
      listPricePen: '80.0000',
    });
    const trail = newTrail();

    try {
      // Dos líneas de la misma bobina que juntas se pasan: 600 + 600 sobre 1 000 kg.
      const tooMuch = await createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        items: [
          { productId: cover.id, qty: '10', reserveFromCoilId: stock.coil.id, reserveKg: '600' },
          {
            productId: ridge.id,
            qty: '7',
            // Precio editado a mano: la línea tiene que guardar el de lista **y** el pactado.
            unitPricePen: '55.5000',
            reserveFromCoilId: stock.coil.id,
            reserveKg: '600',
          },
        ],
      });
      trail.quotationIds.push(tooMuch.id);

      expect(tooMuch.items).toHaveLength(2);
      expect(tooMuch.items[0]).toMatchObject({
        lineNumber: 1,
        listPricePen: '120.0000',
        unitPricePen: '120.0000',
        subtotalPen: '1200.0000',
        igvPen: '216.0000',
        totalPen: '1416.0000',
      });
      // D-068: se guardan los dos precios. Con solo el cotizado se pierde contra qué se dio
      // el descuento; con solo el de lista se pierde lo que se le prometió al cliente.
      expect(tooMuch.items[1]).toMatchObject({
        lineNumber: 2,
        listPricePen: '80.0000',
        unitPricePen: '55.5000',
        subtotalPen: '388.5000',
        igvPen: '69.9300',
        totalPen: '458.4300',
      });
      // Totales del documento: Σ subtotales + Σ IGV, no Σ de totales de línea (D-068).
      expect(tooMuch).toMatchObject({
        subtotalPen: '1588.5000',
        igvPen: '285.9300',
        totalPen: '1874.4300',
      });

      await postJson<QuotationDto>(api, `/api/sales/quotations/${tooMuch.id}/emit`);
      const failed = await postExpectingError(api, `/api/sales/quotations/${tooMuch.id}/confirm`);
      expect(failed.status).toBe(400);
      // La línea 1 ya reservó 600 dentro de la misma transacción: la 2 tiene que verlo.
      expect(failed.message).toContain('Línea 2');
      expect(failed.message).toContain('400.000');
      expect(failed.message).toContain('600.000');

      // Falla completa: ni pedido, ni una reserva de la línea 1 colgando.
      expect(await ordersOfCustomer(api, customer.id)).toHaveLength(0);
      expect(await availabilityOf(api, 'COIL', stock.coil.id)).toMatchObject({
        reservedQty: '0.000',
        availableQty: '1000.000',
      });
      const untouched = await getJson<QuotationDto>(api, `/api/sales/quotations/${tooMuch.id}`);
      expect(untouched).toMatchObject({ status: 'EMITTED', salesOrderId: null });

      // La misma cotización con 400 + 500 sí entra: dos reservas sobre la misma bobina.
      const fits = await createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        items: [
          { productId: cover.id, qty: '10', reserveFromCoilId: stock.coil.id, reserveKg: '400' },
          {
            productId: ridge.id,
            qty: '7',
            unitPricePen: '55.5000',
            reserveFromCoilId: stock.coil.id,
            reserveKg: '500',
          },
        ],
      });
      trail.quotationIds.push(fits.id);
      await postJson<QuotationDto>(api, `/api/sales/quotations/${fits.id}/emit`);
      const order = await postJson<SalesOrderDto>(api, `/api/sales/quotations/${fits.id}/confirm`);
      trail.orderIds.push(order.id);

      expect(order.reservations).toHaveLength(2);
      expect(order.reservations.map((r) => r.qty).sort()).toEqual(['400.000', '500.000']);
      expect(order.reservations.every((r) => r.itemId === stock.coil.id)).toBe(true);
      // El pedido congela los dos precios de la cotización, no los recalcula.
      expect(order.items[1]).toMatchObject({ listPricePen: '80.0000', unitPricePen: '55.5000' });
      expect(order.totalPen).toBe(fits.totalPen);

      // Y el disponible baja por la **suma** de las dos líneas.
      expect(await availabilityOf(api, 'COIL', stock.coil.id)).toMatchObject({
        qty: '1000.000',
        reservedQty: '900.000',
        availableQty: '100.000',
      });
    } finally {
      await purgeSalesTrail(api, trail);
      await deactivateTrail(api, {
        motherId: stock.coil.id,
        purchaseId: stock.purchaseId,
        supplierId: stock.supplier.id,
        finish: stock.finish,
        productIds: [cover.id, ridge.id],
      });
    }
  });

  // -------------------------------------------------------------------------
  // 2. Varias líneas sobre bobinas distintas
  // -------------------------------------------------------------------------

  test('dos líneas sobre bobinas distintas reservan de cada una por separado', async () => {
    const customer = await createCustomer(api);
    const batch = await setupCoilBatch(api, {
      lineCode: COVER_LINE,
      weightsKg: ['1000', '1500'],
    });
    const first = batch.coils[0]!;
    const second = batch.coils[1]!;
    const cover = await createSellableProduct(api, {
      lineCode: COVER_LINE,
      listPricePen: '90.0000',
    });
    const trail = newTrail();

    try {
      const quotation = await createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        items: [
          { productId: cover.id, qty: '8', reserveFromCoilId: first.id, reserveKg: '700' },
          { productId: cover.id, qty: '12', reserveFromCoilId: second.id, reserveKg: '900' },
        ],
      });
      trail.quotationIds.push(quotation.id);
      expect(quotation.items.map((i) => i.reserveItemId)).toEqual([first.id, second.id]);
      // 8 × 90 = 720 y 12 × 90 = 1 080; el documento suma subtotales e IGV por separado.
      expect(quotation).toMatchObject({
        subtotalPen: '1800.0000',
        igvPen: '324.0000',
        totalPen: '2124.0000',
      });

      await postJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}/emit`);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds.push(order.id);
      expect(order.reservations).toHaveLength(2);

      const byItem = new Map(order.reservations.map((r) => [r.itemId, r]));
      expect(byItem.get(first.id)).toMatchObject({ qty: '700.000', status: 'ACTIVE' });
      expect(byItem.get(second.id)).toMatchObject({ qty: '900.000', status: 'ACTIVE' });

      expect(await availabilityOf(api, 'COIL', first.id)).toMatchObject({
        qty: '1000.000',
        reservedQty: '700.000',
        availableQty: '300.000',
      });
      expect(await availabilityOf(api, 'COIL', second.id)).toMatchObject({
        qty: '1500.000',
        reservedQty: '900.000',
        availableQty: '600.000',
      });

      // Anular el pedido libera las dos, no una: la reversa también es "todo o nada".
      const cancelled = await postJson<SalesOrderDto>(api, `/api/sales/orders/${order.id}/cancel`, {
        reason: 'El cliente se echó atrás',
      });
      expect(cancelled.reservations.every((r) => r.status === 'RELEASED')).toBe(true);
      expect(await availabilityOf(api, 'COIL', first.id)).toMatchObject({
        reservedQty: '0.000',
      });
      expect(await availabilityOf(api, 'COIL', second.id)).toMatchObject({
        reservedQty: '0.000',
      });
    } finally {
      await purgeSalesTrail(api, trail);
      await cancelCoils(
        api,
        batch.coils.map((c) => c.id),
      );
      await deactivateTrail(api, {
        purchaseId: batch.purchaseId,
        supplierId: batch.supplier.id,
        finish: batch.finish,
        productId: cover.id,
      });
    }
  });

  // -------------------------------------------------------------------------
  // 3. Reserva sobre el propio producto (`itemType=PRODUCT`)
  // -------------------------------------------------------------------------

  /**
   * El otro caso de D-065: sin `reserveFromCoilId` la línea promete **el propio producto**
   * en su unidad de venta. Es el perfil que se vende de stock.
   *
   * La invariante de cantidad tiene que proteger esas piezas igual que protege los kilos de
   * una bobina. Hoy la **única** operación que saca piezas terminadas del almacén es revertir
   * un reporte de producción (el despacho es Fase 5b y todavía no existe; la otra puerta,
   * anular una compra de producto terminado, sale por el mismo `InventoryService.reverse`),
   * así que es esa la que se prueba.
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
   * así que el saldo de la bobina se ve intacto y el disponible alcanza de sobra. Confirmar
   * igual dejaría al pedido prometiendo material que ya no está en casa — y, peor, haría que
   * la recepción del corte o el reporte de esa OP se cayeran después contra la invariante,
   * sin más salida que liberar la reserva a mano.
   */
  test('no se confirma una cotización cuya bobina se fue a corte entre medias', async () => {
    const customer = await createCustomer(api);
    const stock = await setupCoilStock(api, { lineCode: COVER_LINE, weightKg: '2000' });
    const product = await createSellableProduct(api, {
      lineCode: COVER_LINE,
      listPricePen: '70.0000',
    });
    const trail = newTrail();
    let cuttingOrderId: string | undefined;

    try {
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: product.id,
        qty: '9',
        reserveFromCoilId: stock.coil.id,
        reserveKg: '800',
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
      // si esperar la vuelta del corte o cotizar otro rollo.
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
        productId: product.id,
      });
    }
  });

  test('no se confirma una cotización cuyo fleje quedó montado en una orden de producción', async () => {
    const customer = await createCustomer(api);
    const scenario = await setupScenario(api);
    const strip = scenario.strips[0]!;
    const trail = newTrail();
    const productionOrderIds: string[] = [];

    try {
      // Drywall no exige cotización, pero admite cotizar: la ruta de confirmación es la
      // misma para las dos líneas de negocio (D-065), y es la única línea que se produce.
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: PROFILE_LINE,
        productId: scenario.product.id,
        qty: '100',
        unitPricePen: '35.0000',
        reserveFromCoilId: strip.id,
        reserveKg: '1000',
      });
      trail.quotationIds.push(quotation.id);
      await postJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}/emit`);

      // Planta monta el fleje en una orden que no nació de este pedido.
      const op = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: scenario.product.id,
      });
      productionOrderIds.push(op.id);
      await postJson<ProductionOrderDto>(api, `/api/production/${op.id}/consume`, {
        coilId: strip.id,
        qtyKg: '1200',
      });

      const blocked = await postExpectingError(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain(op.code);
      expect(blocked.message).toContain(strip.code);

      expect(await ordersOfCustomer(api, customer.id)).toHaveLength(0);
      const untouched = await getJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}`);
      expect(untouched).toMatchObject({ status: 'EMITTED', salesOrderId: null });
      expect(await availabilityOf(api, 'COIL', strip.id)).toMatchObject({ reservedQty: '0.000' });

      // El fleje montado tampoco se ofrece como material reservable: si se ofreciera, el
      // vendedor lo elegiría y se comería este mismo 400 al confirmar.
      const reservable = await getJson<{ coilId: string }[]>(
        api,
        `/api/sales/reservable-coils?businessLine=${PROFILE_LINE}`,
      );
      expect(reservable.map((c) => c.coilId)).not.toContain(strip.id);
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
  // 5. Editar, reemitir, anular y el PDF (RF-65, RF-66, D-068)
  // -------------------------------------------------------------------------

  test('el borrador se edita y no tiene PDF; la emitida no se edita y su anulación sale rotulada', async () => {
    const customer = await createCustomer(api);
    const stock = await setupCoilStock(api, { lineCode: COVER_LINE, weightKg: '3000' });
    const cover = await createSellableProduct(api, {
      lineCode: COVER_LINE,
      listPricePen: '120.0000',
    });
    const ridge = await createSellableProduct(api, {
      lineCode: COVER_LINE,
      listPricePen: '80.0000',
    });
    const trail = newTrail();

    try {
      const draft = await createQuotation(api, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: cover.id,
        qty: '10',
        reserveFromCoilId: stock.coil.id,
        reserveKg: '500',
      });
      trail.quotationIds.push(draft.id);
      expect(draft.totalPen).toBe('1416.0000');

      // Un borrador todavía no es un documento: sin este corte, un vendedor podía armar un
      // borrador con el precio que quisiera, no emitirlo nunca y mandárselo igual al cliente.
      const noPdf = await getExpectingError(api, `/api/sales/quotations/${draft.id}/pdf`);
      expect(noPdf.status).toBe(400);

      // RF-66: editar reemplaza las líneas completas y recalcula los totales.
      const edited = await putJson<QuotationDto>(
        api,
        `/api/sales/quotations/${draft.id}`,
        updateQuotationBody({
          customerId: customer.id,
          items: [
            { productId: cover.id, qty: '5', reserveFromCoilId: stock.coil.id, reserveKg: '300' },
            {
              productId: ridge.id,
              qty: '4',
              unitPricePen: '62.5000',
              reserveFromCoilId: stock.coil.id,
              reserveKg: '200',
            },
          ],
          validityDays: 15,
        }),
      );
      expect(edited.items).toHaveLength(2);
      expect(edited.items.map((i) => i.lineNumber)).toEqual([1, 2]);
      // 5 × 120 = 600 y 4 × 62.5 = 250 → 850 de subtotal, 153 de IGV.
      expect(edited).toMatchObject({
        status: 'DRAFT',
        subtotalPen: '850.0000',
        igvPen: '153.0000',
        totalPen: '1003.0000',
      });
      expect(edited.items[1]).toMatchObject({ listPricePen: '80.0000', unitPricePen: '62.5000' });

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

      const cannotEdit = await putExpectingError(
        api,
        `/api/sales/quotations/${draft.id}`,
        updateQuotationBody({
          customerId: customer.id,
          items: [
            { productId: cover.id, qty: '99', reserveFromCoilId: stock.coil.id, reserveKg: '100' },
          ],
        }),
      );
      expect(cannotEdit.status).toBe(400);
      expect(cannotEdit.message).toContain('borrador');
      // Y no cambió nada: el rechazo es antes de tocar las líneas.
      const stillEmitted = await getJson<QuotationDto>(api, `/api/sales/quotations/${draft.id}`);
      expect(stillEmitted).toMatchObject({ status: 'EMITTED', totalPen: '1003.0000' });
      expect(stillEmitted.items).toHaveLength(2);

      // Anular una emitida (RF-65) y comprobar que su PDF sale rotulado: sin el rótulo, el
      // papel de una anulada es idéntico al de una vigente.
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
      const scrapped = await createQuotation(api, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: cover.id,
        qty: '2',
        reserveFromCoilId: stock.coil.id,
        reserveKg: '100',
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
      expect(await availabilityOf(api, 'COIL', stock.coil.id)).toMatchObject({
        reservedQty: '0.000',
        availableQty: '3000.000',
      });
    } finally {
      await purgeSalesTrail(api, trail);
      await deactivateTrail(api, {
        motherId: stock.coil.id,
        purchaseId: stock.purchaseId,
        supplierId: stock.supplier.id,
        finish: stock.finish,
        productIds: [cover.id, ridge.id],
      });
    }
  });

  // -------------------------------------------------------------------------
  // 6. Confirmar es la puerta que vende: revalida cliente y producto
  // -------------------------------------------------------------------------

  /**
   * D-065 puso cotización y pedido directo en **un solo camino** para que el alta directa
   * no pudiera admitir lo que la cotización rechaza. La confirmación es el tercer camino, y
   * es el que de verdad vende: crea el pedido y compromete stock.
   *
   * Los otros dos rechazan un cliente desactivado (`requireHeaderRefs`, `createDirect`) y un
   * producto desactivado (`resolveSalesLines`). Desactivar un cliente es la única palanca
   * que tiene el negocio para dejar de venderle —moroso, bloqueado, dado de baja— y
   * desactivar un producto es como se descontinúa. Si confirmar no los mira, basta con
   * tener una cotización emitida de antes para saltarse las dos.
   */
  test('confirmar rechaza una cotización cuyo cliente o producto se desactivó después de emitirla', async () => {
    const customer = await createCustomer(api);
    const stock = await setupCoilStock(api, { lineCode: COVER_LINE, weightKg: '2000' });
    const product = await createSellableProduct(api, {
      lineCode: COVER_LINE,
      listPricePen: '65.0000',
    });
    const trail = newTrail();

    try {
      const emitted: QuotationDto[] = [];
      for (let i = 0; i < 2; i += 1) {
        const q = await createQuotation(api, {
          customerId: customer.id,
          businessLine: COVER_LINE,
          productId: product.id,
          qty: '5',
          reserveFromCoilId: stock.coil.id,
          reserveKg: '300',
        });
        trail.quotationIds.push(q.id);
        emitted.push(await postJson<QuotationDto>(api, `/api/sales/quotations/${q.id}/emit`));
      }

      /**
       * Confirma y, si el API deja pasar lo que no debería, apunta el pedido en el rastro:
       * un pedido con una reserva viva bloquea la anulación de la bobina y de su compra, y
       * un test que falla no puede además dejar residuo que la purga no sepa deshacer.
       */
      const confirmTracking = async (
        quotationId: string,
      ): Promise<{ status: number; message: string }> => {
        const res = await api.post(`/api/sales/quotations/${quotationId}/confirm`);
        if (res.ok()) {
          const order = (await res.json()) as SalesOrderDto;
          trail.orderIds.push(order.id);
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
      await api.patch(`/api/catalog/${product.id}`, { data: { isActive: false } });
      const blockedByProduct = await confirmTracking(emitted[1]!.id);
      await api.patch(`/api/catalog/${product.id}`, { data: { isActive: true } });

      // Las dos se comprueban aunque la primera falle: interesa saber si el hueco es de la
      // cabecera, de las líneas o de las dos.
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
      expect.soft(await availabilityOf(api, 'COIL', stock.coil.id)).toMatchObject({
        reservedQty: '0.000',
        availableQty: '2000.000',
      });
      expect.soft(await ordersOfCustomer(api, customer.id)).toHaveLength(0);
    } finally {
      await api
        .patch(`/api/customers/${customer.id}`, { data: { isActive: true } })
        .catch(() => undefined);
      await purgeSalesTrail(api, trail);
      await deactivateTrail(api, {
        motherId: stock.coil.id,
        purchaseId: stock.purchaseId,
        supplierId: stock.supplier.id,
        finish: stock.finish,
        productId: product.id,
      });
    }
  });

  // -------------------------------------------------------------------------
  // 7. RF-66 — la cotización de otro vendedor se lee, no se opera
  // -------------------------------------------------------------------------

  test('un vendedor lee la cotización de otro pero no la edita, emite, confirma ni anula', async ({
    baseURL,
  }) => {
    const customer = await createCustomer(api);
    const stock = await setupCoilStock(api, { lineCode: COVER_LINE, weightKg: '1500' });
    const product = await createSellableProduct(api, {
      lineCode: COVER_LINE,
      listPricePen: '45.0000',
    });
    const author = await createUser(api, 'VENDEDOR');
    const other = await createUser(api, 'VENDEDOR');
    const authorApi = await apiAs(baseURL!, author);
    const otherApi = await apiAs(baseURL!, other);
    const trail = newTrail();

    try {
      const quotation = await createQuotation(authorApi, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: product.id,
        qty: '10',
        reserveFromCoilId: stock.coil.id,
        reserveKg: '500',
      });
      trail.quotationIds.push(quotation.id);

      // Leerla sí: RF-69 pide una lista de cotizaciones, no una lista por vendedor.
      const read = await getJson<QuotationDto>(otherApi, `/api/sales/quotations/${quotation.id}`);
      expect(read.id).toBe(quotation.id);
      const list = await getJson<{ id: string }[]>(otherApi, '/api/sales/quotations');
      expect(list.map((q) => q.id)).toContain(quotation.id);

      // Operarla, no. Con solo el id (que la lista le da) podría editar el borrador de un
      // compañero, emitirlo, confirmarlo a nombre de su cliente o anulárselo.
      const cannotEdit = await putExpectingError(
        otherApi,
        `/api/sales/quotations/${quotation.id}`,
        updateQuotationBody({
          customerId: customer.id,
          items: [
            { productId: product.id, qty: '1', reserveFromCoilId: stock.coil.id, reserveKg: '10' },
          ],
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
      expect(await availabilityOf(api, 'COIL', stock.coil.id)).toMatchObject({
        reservedQty: '0.000',
      });

      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds.push(order.id);
      expect(order.reservations[0]!.status).toBe('ACTIVE');
    } finally {
      await authorApi.dispose();
      await otherApi.dispose();
      await purgeSalesTrail(api, trail);
      await deactivateTrail(api, {
        motherId: stock.coil.id,
        purchaseId: stock.purchaseId,
        supplierId: stock.supplier.id,
        finish: stock.finish,
        productId: product.id,
      });
    }
  });

  // -------------------------------------------------------------------------
  // 8. El PDF de una vencida (D-068 + D-069)
  // -------------------------------------------------------------------------

  /**
   * El rótulo del PDF existe para que el papel de una cotización que ya no vale no sea
   * idéntico al de una vigente. Y D-069 dice, con todas las letras, que **el job no es la
   * regla**: el API escala a cero en Cloud Run, así que una cotización vencida puede seguir
   * figurando `EMITIDA` indefinidamente, y por eso `confirm()` revalida la fecha por su
   * cuenta en vez de fiarse del estado.
   *
   * La descarga del PDF es la otra puerta por la que esa cotización sale al cliente, y es la
   * que más se usa: el vendedor la reenvía por correo. Si se fía del estado, durante toda la
   * ventana en la que el job no corrió entrega un documento sin rótulo — uno que el cliente
   * lee como vigente y que el propio API ya no dejaría confirmar.
   */
  test('el PDF de una cotización vencida sale rotulado aunque el job todavía no la haya marcado', async () => {
    const customer = await createCustomer(api);
    const stock = await setupCoilStock(api, { lineCode: COVER_LINE, weightKg: '1200' });
    const product = await createSellableProduct(api, {
      lineCode: COVER_LINE,
      listPricePen: '50.0000',
    });
    const trail = newTrail();

    try {
      // Emitida hace 10 días con un día de vigencia: venció hace nueve.
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: product.id,
        qty: '4',
        reserveFromCoilId: stock.coil.id,
        reserveKg: '300',
        issueDate: isoDaysFromToday(-10),
        validityDays: 1,
      });
      trail.quotationIds.push(quotation.id);
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
      await purgeSalesTrail(api, trail);
      await deactivateTrail(api, {
        motherId: stock.coil.id,
        purchaseId: stock.purchaseId,
        supplierId: stock.supplier.id,
        finish: stock.finish,
        productId: product.id,
      });
    }
  });

  // -------------------------------------------------------------------------
  // 9. Dos confirmaciones simultáneas sobre la misma bobina
  // -------------------------------------------------------------------------

  /**
   * El disponible alcanza para una sola. `createReservations` bloquea primero la fila de la
   * bobina y después el saldo, así que las dos transacciones se serializan: una gana y la
   * otra tiene que fallar **limpio** (400 del dominio, no un 500 de deadlock) y sin dejar
   * media reserva.
   */
  test('dos confirmaciones simultáneas sobre la misma bobina: una gana y la otra falla limpio', async () => {
    const customer = await createCustomer(api);
    const stock = await setupCoilStock(api, { lineCode: COVER_LINE, weightKg: '1000' });
    const product = await createSellableProduct(api, {
      lineCode: COVER_LINE,
      listPricePen: '55.0000',
    });
    const trail = newTrail();

    try {
      const quotations: QuotationDto[] = [];
      for (const qty of ['6', '7']) {
        const q = await createQuotation(api, {
          customerId: customer.id,
          businessLine: COVER_LINE,
          productId: product.id,
          qty,
          reserveFromCoilId: stock.coil.id,
          reserveKg: '800',
        });
        trail.quotationIds.push(q.id);
        await postJson<QuotationDto>(api, `/api/sales/quotations/${q.id}/emit`);
        quotations.push(q);
      }

      const responses = await Promise.all(
        quotations.map((q) => api.post(`/api/sales/quotations/${q.id}/confirm`)),
      );
      const winners = responses.filter((r) => r.ok());
      const losers = responses.filter((r) => !r.ok());
      expect(winners, 'solo una confirmación puede ganar 800 de 1 000 kg').toHaveLength(1);
      expect(losers).toHaveLength(1);

      const loserBody = (await losers[0]!.json()) as { message?: string };
      expect(
        losers[0]!.status(),
        `la perdedora debe fallar con un 400 del dominio, no con un error de base: ${JSON.stringify(loserBody)}`,
      ).toBe(400);

      const winner = (await winners[0]!.json()) as SalesOrderDto;
      trail.orderIds.push(winner.id);

      // Una sola reserva viva y el disponible que le corresponde: ninguna huérfana.
      expect(await availabilityOf(api, 'COIL', stock.coil.id)).toMatchObject({
        qty: '1000.000',
        reservedQty: '800.000',
        availableQty: '200.000',
      });
      const live = await getJson<{ id: string }[]>(
        api,
        `/api/sales/reservations?itemId=${stock.coil.id}&status=ACTIVE`,
      );
      expect(live).toHaveLength(1);
      expect(await ordersOfCustomer(api, customer.id)).toHaveLength(1);
    } finally {
      await purgeSalesTrail(api, trail);
      await deactivateTrail(api, {
        motherId: stock.coil.id,
        purchaseId: stock.purchaseId,
        supplierId: stock.supplier.id,
        finish: stock.finish,
        productId: product.id,
      });
    }
  });
});
