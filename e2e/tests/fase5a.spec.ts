import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  adminApi,
  closeCoilKeepingStock,
  createSupplier,
  createUser,
  getJson,
  postJson,
} from '../helpers/api';
import {
  apiAs,
  balanceOf,
  deactivateTrail,
  postExpectingError,
  setupScenario,
  today,
  uniqueDocumentNumber,
  type ProductionOrderDto,
} from '../helpers/production';
import {
  availabilityOf,
  createCustomer,
  createQuotation,
  createSellableProduct,
  isoDaysFromToday,
  purgeSalesTrail,
  setupCoilStock,
  stockPanel,
  type DocumentLookupDto,
  type QuotationDto,
  type SalesOrderDto,
} from '../helpers/sales';
import { metersOf, pieces, purgeRoofingTrail, setupRoofingScenario } from '../helpers/roofing';

/**
 * Fase 5a — cotización → confirmación → pedido + reserva (D-054, D-064..D-069).
 *
 * Lo que estos tests protegen, en una línea: **cotizar no toca el inventario, confirmar sí,
 * y desde que confirma nadie más puede tocar ese material**. Todo lo demás (bloqueos,
 * reversas, vencimiento) sale de ahí.
 *
 * **D-134 cambió el objeto de la promesa de una cobertura**: una línea a medida ya no
 * reserva una bobina elegida a mano (`reserveFromCoilId`/`reserveKg` desaparecieron) sino
 * kilos del agregado de materia prima compatible (línea + color + espesor). Por eso los
 * escenarios de cobertura de este archivo arman un producto **a medida** de verdad —color
 * único, acabado propio, `roofingKind: A_MEDIDA`, vía `setupRoofingScenario` (el mismo
 * fixture de Fase 6)— y las aserciones de disponible pasan por `GET /sales/stock-panel`, no
 * por el saldo propio de una bobina puntual. Los escenarios de perfiles de drywall que antes
 * reservaban una fracción de kilos de una bobina para un producto **comprado** ya no tienen
 * ese camino: donde el punto era la invariante `disponible ≥ reservado` sobre una bobina, se
 * reescribieron con la venta de la bobina **entera** (RF-73, `saleCoilId`), que sigue
 * reservando el 100 % de su saldo.
 *
 * Los E2E son por API, como el resto de la suite: corren igual en local (Neon `dev`),
 * en CI (Neon `ci`) y contra producción con `E2E_ALLOW_WRITES=1`, y cada uno deshace lo
 * que crea en un `finally` — un pedido con una reserva viva bloquea la anulación de la
 * bobina y de su compra, así que dejar basura acá se paga en la purga.
 */

/** Coberturas metálicas: la línea que exige cotización confirmada (RF-31, D-065). */
const COVER_LINE = 'metallic-roofing';
/** Drywall: cotización opcional, admite pedido directo. */
const PROFILE_LINE = 'drywall';

const allowWrites = process.env.E2E_ALLOW_WRITES === '1' || !process.env.E2E_BASE_URL;

/**
 * Cada test de esta fase arma su escenario (compra + recepción de bobina), corre el flujo
 * y lo deshace entero: son ~30 llamadas al API, y contra Neon cada una cuesta más de un
 * segundo. Con el timeout global de 45 s la suite fallaba por reloj, no por defectos.
 */
test.describe.configure({ timeout: 150_000 });

test.describe('Fase 5a — cotización, pedido y reserva', () => {
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
  // 1. El flujo completo de una cobertura a medida, hasta la reserva genérica viva
  // -------------------------------------------------------------------------

  test('cotizar una cobertura a medida, confirmarla y ver bajar el disponible del agregado', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '5000' });
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
      // 2 planchas de 5 m = 10 m. La geometría (densidad 8.0, 1 000 mm, 0.50 mm) da 4 kg/m, y
      // D-165 los deja en 4.04 con el 1 % de merma normal adentro: 40.4 kg.
      const rows = pieces([5, 2]);
      expect(metersOf(rows)).toBe('10.000');

      // Cotizar NO reserva (D-054): el disponible del agregado sigue igual al físico.
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: scenario.product.id,
        qty: metersOf(rows),
        unitPricePen: '120',
        pieces: rows,
      });
      trail.quotationIds = [quotation.id];
      expect(quotation.status).toBe('DRAFT');
      expect(quotation.code).toMatch(/^COT-\d{6}$/);
      // D-134: la línea reserva kilos del agregado, no un ítem de kardex.
      expect(quotation.items[0]).toMatchObject({
        unitPricePen: '120.0000',
        subtotalPen: '1200.0000',
        igvPen: '216.0000',
        totalPen: '1416.0000',
        reserveItemType: 'RAW_MATERIAL',
        reserveQty: '40.400',
        reserveUnit: 'KGM',
      });
      expect(quotation.totalPen).toBe('1416.0000');

      const beforeConfirm = await stockPanel(api, {
        businessLine: COVER_LINE,
        productIds: [scenario.product.id],
      });
      expect(beforeConfirm.products.find((p) => p.productId === scenario.product.id)).toMatchObject(
        { rawMaterialAvailableKg: '5000.000' },
      );

      // Emitir genera el PDF (D-068) y habilita la confirmación.
      const emitted = await postJson<QuotationDto>(
        api,
        `/api/sales/quotations/${quotation.id}/emit`,
      );
      expect(emitted.status).toBe('EMITTED');
      expect(emitted.pdfKey, 'la emisión debe dejar el PDF en R2').not.toBeNull();
      const pdf = await api.get(`/api/sales/quotations/${quotation.id}/pdf`);
      expect(pdf.ok(), 'el PDF de la cotización debe descargarse').toBe(true);
      expect(pdf.headers()['content-type']).toContain('application/pdf');
      expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');

      // Confirmar: pedido y reserva en la misma transacción (D-054).
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds = [order.id];
      expect(order.code).toMatch(/^PED-\d{6}$/);
      expect(order.status).toBe('CONFIRMED');
      expect(order.quotationId).toBe(quotation.id);
      // El pedido congela los montos de la cotización, no los recalcula.
      expect(order.totalPen).toBe('1416.0000');
      expect(order.reservations).toHaveLength(1);
      expect(order.reservations[0]).toMatchObject({
        itemType: 'RAW_MATERIAL',
        qty: '40.400',
        unit: 'KGM',
        status: 'ACTIVE',
        productionOrderId: null,
      });
      // La reserva nombra el agregado (una fila de `raw_material_specs`), no la bobina.
      expect(order.reservations[0]!.itemId).not.toBe(scenario.coil.id);

      // El disponible del agregado ya descuenta lo prometido, aunque el físico de la
      // bobina no se haya movido: la reserva genérica no es un movimiento de kardex.
      const afterConfirm = await stockPanel(api, {
        businessLine: COVER_LINE,
        productIds: [scenario.product.id],
      });
      // 5 000 físicos − 40.4 prometidos (D-165: 10 m × 4.04 kg/m).
      expect(afterConfirm.products.find((p) => p.productId === scenario.product.id)).toMatchObject({
        rawMaterialAvailableKg: '4959.600',
      });
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('5000.000');

      // La cotización queda confirmada y apunta a su pedido.
      const confirmed = await getJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}`);
      expect(confirmed).toMatchObject({ status: 'CONFIRMED', salesOrderId: order.id });

      // Y no se puede confirmar dos veces (idempotencia, mismo criterio que D-061).
      const twice = await postExpectingError(api, `/api/sales/quotations/${quotation.id}/confirm`);
      expect(twice.status).toBe(409);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 2. Una OP de drywall se produce a stock (D-060: el pedido detrás es opcional)
  // -------------------------------------------------------------------------

  /**
   * D-134 retiró la única forma en que un pedido de drywall podía comprometer un fleje
   * (`reserveFromCoilId`): un perfil ya solo reserva su propio stock (`PRODUCT`), nunca
   * materia prima. Lo que **no** cambió es que una OP de producción siempre pudo nacer sin
   * pedido detrás (`reservationId` es opcional, D-060): es la corrida de stock de siempre,
   * y es el único camino que le queda a drywall hoy.
   */
  test('una OP de drywall se produce a stock, sin ningún pedido detrás, y lo producido se vende reservando el propio producto', async () => {
    const scenario = await setupScenario(api);
    const strip = scenario.strips[0]!;
    const productionOrderIds: string[] = [];
    const trail: { orderIds: string[] } = { orderIds: [] };

    try {
      const op = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: scenario.product.id,
        targetPieces: 100,
      });
      productionOrderIds.push(op.id);
      expect(op.reservationId, 'una corrida de stock no tiene reserva detrás').toBeNull();

      await postJson<ProductionOrderDto>(api, `/api/production/${op.id}/consume`, {
        coilId: strip.id,
        qtyKg: '1000',
      });
      const reported = await postJson<ProductionOrderDto>(api, `/api/production/${op.id}/report`, {
        pieces: 100,
      });
      expect(reported.piecesReported).toBe(100);

      // El kardex cuadra igual que siempre: 200 kg salieron del fleje (100 × 2 kg) y 100
      // piezas entraron al producto — nada de esto dependía de que hubiera un pedido detrás.
      expect((await balanceOf(api, 'COIL', strip.id)).qty).toBe('2200.000');
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('100.000');

      // Con las 100 piezas ya en stock, un pedido de un cliente reserva el propio producto
      // (D-134): ya no hay ninguna reserva de bobina que atender.
      const customer = await createCustomer(api);
      const order = await postJson<SalesOrderDto>(api, '/api/sales/orders', {
        customerId: customer.id,
        businessLine: PROFILE_LINE,
        issueDate: today(),
        items: [{ productId: scenario.product.id, qty: '60', unitPricePen: '35' }],
      });
      trail.orderIds = [order.id];
      expect(order.reservations[0]).toMatchObject({
        itemType: 'PRODUCT',
        itemId: scenario.product.id,
        qty: '60.000',
        status: 'ACTIVE',
      });
      expect(await availabilityOf(api, 'PRODUCT', scenario.product.id)).toMatchObject({
        qty: '100.000',
        reservedQty: '60.000',
        availableQty: '40.000',
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
  // 3. El flag de D-065: cotización obligatoria vs. opcional
  // -------------------------------------------------------------------------

  test('el pedido directo va en perfiles y se rechaza en coberturas', async () => {
    const customer = await createCustomer(api);
    const profile = await createSellableProduct(api, {
      lineCode: PROFILE_LINE,
      listPricePen: '18.5000',
    });
    // Stock del perfil vía compra de producto terminado: D-134 ya no deja reservar una
    // fracción de kilos de una bobina para un producto comprado.
    const supplier = await createSupplier(api);
    const purchase = await postJson<{ id: string }>(api, '/api/purchases', {
      supplierId: supplier.id,
      businessLine: PROFILE_LINE,
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
          productId: profile.id,
          description: 'Perfil E2E',
          qty: '40',
          unit: 'NIU',
          unitPrice: '10',
        },
      ],
    });
    await postJson(api, `/api/purchases/${purchase.id}/receive`);

    const cover = await setupRoofingScenario(api, { weightKg: '500' });
    const trail: { orderIds: string[]; quotationIds: string[] } = {
      orderIds: [],
      quotationIds: [],
    };

    try {
      // Perfiles: pedido directo, sin cotización previa. Reserva su propio stock.
      const order = await postJson<SalesOrderDto>(api, '/api/sales/orders', {
        customerId: customer.id,
        businessLine: PROFILE_LINE,
        issueDate: today(),
        items: [{ productId: profile.id, qty: '30', unitPricePen: '20' }],
      });
      trail.orderIds.push(order.id);
      expect(order.quotationId, 'un pedido directo no tiene cotización detrás').toBeNull();
      expect(order.items[0]).toMatchObject({ unitPricePen: '20.0000' });
      expect(order.reservations[0]).toMatchObject({ itemType: 'PRODUCT', status: 'ACTIVE' });

      // Coberturas: el mismo endpoint tiene que rechazarlo, o el flag no significaría nada.
      const rejected = await postExpectingError(api, '/api/sales/orders', {
        customerId: customer.id,
        businessLine: COVER_LINE,
        issueDate: today(),
        items: [
          { productId: cover.product.id, qty: '5', unitPricePen: '100', pieces: pieces([5, 1]) },
        ],
      });
      expect(rejected.status).toBe(400);
    } finally {
      await purgeSalesTrail(api, trail);
      await deactivateTrail(api, {
        purchaseId: purchase.id,
        supplierId: supplier.id,
        productIds: [profile.id],
      });
      await purgeRoofingTrail(api, {
        supplierId: cover.supplier.id,
        finishId: cover.finish.id,
        colorId: cover.color.id,
        productIds: [cover.product.id],
        coilIds: [cover.coil.id],
        purchaseIds: [cover.purchaseId],
      });
    }
  });

  // -------------------------------------------------------------------------
  // 4. Disponible insuficiente: falla completa, nunca parcial
  // -------------------------------------------------------------------------

  test('confirmar sin disponible suficiente del agregado falla entera y no deja pedido a medias', async () => {
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
      // Primera cotización: 20 m ⇒ 80 de los 100 kg del agregado.
      const firstRows = pieces([20, 1]);
      const first = await createQuotation(api, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: scenario.product.id,
        qty: metersOf(firstRows),
        unitPricePen: '90',
        pieces: firstRows,
      });
      trail.quotationIds = [first.id];
      await postJson<QuotationDto>(api, `/api/sales/quotations/${first.id}/emit`);
      const firstOrder = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${first.id}/confirm`,
      );
      trail.orderIds = [firstOrder.id];

      // Segunda cotización sobre el mismo agregado: solo quedan 20 kg disponibles y pide 40.
      const secondRows = pieces([10, 1]);
      const second = await createQuotation(api, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: scenario.product.id,
        qty: metersOf(secondRows),
        unitPricePen: '90',
        pieces: secondRows,
      });
      trail.quotationIds = [first.id, second.id];
      await postJson<QuotationDto>(api, `/api/sales/quotations/${second.id}/emit`);

      const failed = await postExpectingError(api, `/api/sales/quotations/${second.id}/confirm`);
      expect(failed.status).toBe(400);
      // El mensaje tiene que decir disponible y necesitado: sin eso el vendedor no sabe si
      // liberar una reserva o comprar/abrir otra bobina de ese color y espesor.
      expect(failed.message).toContain('19.200');
      expect(failed.message).toContain('40.400');

      // Falla completa: la cotización sigue emitida, sin pedido ni reserva colgando.
      const untouched = await getJson<QuotationDto>(api, `/api/sales/quotations/${second.id}`);
      expect(untouched).toMatchObject({ status: 'EMITTED', salesOrderId: null });
      const panel = await stockPanel(api, {
        businessLine: COVER_LINE,
        productIds: [scenario.product.id],
      });
      expect(panel.products.find((p) => p.productId === scenario.product.id)).toMatchObject({
        rawMaterialAvailableKg: '19.200',
      });
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 5. La invariante transversal: merma, corte, cierre y anulación
  // -------------------------------------------------------------------------

  /**
   * D-134 retiró la reserva de una fracción de kilos de una bobina para un perfil de
   * drywall. Lo que sigue vivo, y protege exactamente igual, es la venta de la bobina
   * **entera** (RF-73, `saleCoilId`): reserva el 100 % de su saldo, y la misma invariante
   * de D-066 bloquea merma, envío a corte, cierre y anulación de la compra mientras esa
   * reserva siga viva. D-120 (Fase 7e, E) hace que el corte tercerizado sea exclusivo de
   * Drywall, así que el escenario se queda en `PROFILE_LINE`, como ya lo dejó esa sesión.
   */
  test('con una bobina vendida entera se bloquean merma, envío a corte, cierre y anulación', async () => {
    const customer = await createCustomer(api);
    const stock = await setupCoilStock(api, { lineCode: PROFILE_LINE, weightKg: '2000' });
    const trail: { orderIds: string[]; quotationIds: string[] } = {
      orderIds: [],
      quotationIds: [],
    };

    try {
      const order = await postJson<SalesOrderDto>(api, '/api/sales/orders', {
        customerId: customer.id,
        businessLine: PROFILE_LINE,
        issueDate: today(),
        items: [{ saleCoilId: stock.coil.id, qty: stock.coil.availableKg, unitPricePen: '6' }],
      });
      trail.orderIds.push(order.id);
      expect(order.reservations[0]).toMatchObject({
        itemType: 'COIL',
        itemId: stock.coil.id,
        qty: '2000.000',
        status: 'ACTIVE',
      });

      // (a) Cualquier merma rompería la reserva completa (100 % del saldo vendido).
      const scrap = await postExpectingError(api, `/api/coils/${stock.coil.id}/scrap`, {
        qtyKg: '10',
        reason: 'Merma que rompería la reserva',
      });
      expect(scrap.status).toBe(400);
      expect(scrap.message).toContain(order.code);
      expect(await availabilityOf(api, 'COIL', stock.coil.id)).toMatchObject({
        qty: '2000.000',
        reservedQty: '2000.000',
        availableQty: '0.000',
      });

      // (b) Envío a corte tercerizado: no mueve kardex (D-050), así que lo tiene que
      //     bloquear el guardrail de custodia, igual que antes de D-134.
      const cutting = await postExpectingError(api, '/api/cutting', {
        supplierId: stock.supplier.id,
        notes: 'Envío que se llevaría material vendido',
        coils: [
          {
            coilId: stock.coil.id,
            widthPlanMm: [{ widthMm: '600', stripsCount: 2 }],
            expectedKerfLossMm: '0',
          },
        ],
      });
      expect(cutting.status).toBe(400);
      expect(cutting.message).toContain(order.code);

      // (c) Cerrar la bobina (RF-19) tampoco mueve kardex y la sacaría de la venta.
      const close = await postExpectingError(api, `/api/coils/${stock.coil.id}/status`, {
        status: 'CLOSED',
      });
      expect(close.status).toBe(400);
      expect(close.message).toContain(order.code);

      // (d) Anular la compra revierte el ingreso de la bobina: misma invariante, otra puerta.
      const cancelPurchase = await postExpectingError(
        api,
        `/api/purchases/${stock.purchaseId}/cancel`,
        { reason: 'Intento con material reservado' },
      );
      expect(cancelPurchase.status).toBe(400);
    } finally {
      await purgeSalesTrail(api, trail);
      await deactivateTrail(api, {
        motherId: stock.coil.id,
        purchaseId: stock.purchaseId,
        supplierId: stock.supplier.id,
        finish: stock.finish,
      });
    }
  });

  // -------------------------------------------------------------------------
  // 6. Reversas: anular el pedido y liberar a mano
  // -------------------------------------------------------------------------

  test('anular el pedido libera la reserva del agregado, restaura el disponible y devuelve la cotización a emitida', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '2500' });
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
      // 3 planchas de 4 m = 12 m ⇒ 48 kg.
      const rows = pieces([4, 3]);
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: scenario.product.id,
        qty: metersOf(rows),
        unitPricePen: '60',
        pieces: rows,
        validityDays: 30,
      });
      trail.quotationIds = [quotation.id];
      await postJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}/emit`);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds = [order.id];
      const panelAfterConfirm = await stockPanel(api, {
        businessLine: COVER_LINE,
        productIds: [scenario.product.id],
      });
      expect(
        panelAfterConfirm.products.find((p) => p.productId === scenario.product.id),
      ).toMatchObject({ rawMaterialAvailableKg: '2451.520' });

      // Una cotización confirmada no se anula por su cuenta: primero el pedido.
      const wrongOrder = await postExpectingError(
        api,
        `/api/sales/quotations/${quotation.id}/cancel`,
        { reason: 'Intento en el orden equivocado' },
      );
      expect(wrongOrder.status).toBe(400);

      const cancelled = await postJson<SalesOrderDto>(api, `/api/sales/orders/${order.id}/cancel`, {
        reason: 'El cliente se echó atrás',
      });
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.reservations[0]).toMatchObject({ status: 'RELEASED' });
      expect(cancelled.reservations[0]!.releasedAt).not.toBeNull();

      // El disponible del agregado vuelve a ser el físico completo.
      const panelAfterCancel = await stockPanel(api, {
        businessLine: COVER_LINE,
        productIds: [scenario.product.id],
      });
      expect(
        panelAfterCancel.products.find((p) => p.productId === scenario.product.id),
      ).toMatchObject({ rawMaterialAvailableKg: '2500.000' });

      // La cotización vuelve a EMITIDA porque sigue vigente, y se puede confirmar de nuevo.
      const back = await getJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}`);
      expect(back).toMatchObject({ status: 'EMITTED', salesOrderId: null });

      const second = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds = [order.id, second.id];
      expect(second.reservations[0]!.status).toBe('ACTIVE');

      // Liberación manual sin anular el pedido (D-054): el pedido sigue vivo, la promesa no.
      const released = await postJson<{ status: string }>(
        api,
        `/api/sales/reservations/${second.reservations[0]!.id}/release`,
        { reason: 'Liberación manual de la prueba' },
      );
      expect(released.status).toBe('RELEASED');
      const panelAfterRelease = await stockPanel(api, {
        businessLine: COVER_LINE,
        productIds: [scenario.product.id],
      });
      expect(
        panelAfterRelease.products.find((p) => p.productId === scenario.product.id),
      ).toMatchObject({ rawMaterialAvailableKg: '2500.000' });

      // Idempotencia: una reserva ya liberada no se vuelve a liberar.
      const twice = await postExpectingError(
        api,
        `/api/sales/reservations/${second.reservations[0]!.id}/release`,
        { reason: 'Otra vez' },
      );
      expect(twice.status).toBe(409);

      // Y ahora que no hay reservas vivas, la bobina se puede cerrar sin problema: el
      // bloqueo era la reserva, no la bobina.
      // D-164: se cierra declarando el saldo entero, así que no hay ajuste que liquidar y
      // reabrir tampoco necesita motivo. Lo que se prueba acá es el bloqueo por reserva.
      await closeCoilKeepingStock(api, scenario.coil.id);
      await postJson(api, `/api/coils/${scenario.coil.id}/status`, { status: 'OPEN' });
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 7. Vencimiento (D-069)
  // -------------------------------------------------------------------------

  test('una cotización vencida la marca el job y ya no se puede confirmar', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '1500' });
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
      // Emitida hace 10 días con 1 día de vigencia: venció hace 9.
      const rows = pieces([4, 1]);
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: scenario.product.id,
        qty: metersOf(rows),
        unitPricePen: '50',
        pieces: rows,
        issueDate: isoDaysFromToday(-10),
        validityDays: 1,
      });
      trail.quotationIds = [quotation.id];
      expect(quotation.validUntil).toBe(isoDaysFromToday(-9));
      expect(quotation.isExpired, 'la fecha ya pasó, aunque el estado siga en borrador').toBe(true);

      await postJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}/emit`);

      // Confirmar antes de que el job corra ya falla: el estado es una comodidad de la
      // lista, la vigencia se revalida siempre (D-069).
      const beforeJob = await postExpectingError(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      expect(beforeJob.status).toBe(400);
      expect(beforeJob.message).toContain(isoDaysFromToday(-9));

      // El job (o su endpoint de puesta al día) la deja marcada VENCIDA.
      const result = await postJson<{ expired: number }>(api, '/api/sales/quotations/expire');
      expect(result.expired).toBeGreaterThanOrEqual(1);
      const expired = await getJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}`);
      expect(expired.status).toBe('EXPIRED');

      // Y sigue sin poder confirmarse, ahora por estado.
      const afterJob = await postExpectingError(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      expect(afterJob.status).toBe(400);

      // Una vencida sí se puede anular (RF-65: cualquier estado no confirmado).
      const cancelled = await postJson<QuotationDto>(
        api,
        `/api/sales/quotations/${quotation.id}/cancel`,
        { reason: 'Vencida sin respuesta del cliente' },
      );
      expect(cancelled.status).toBe('CANCELLED');

      // Nunca reservó nada: el disponible del agregado quedó intacto de punta a punta.
      const panel = await stockPanel(api, {
        businessLine: COVER_LINE,
        productIds: [scenario.product.id],
      });
      expect(panel.products.find((p) => p.productId === scenario.product.id)).toMatchObject({
        rawMaterialAvailableKg: '1500.000',
      });
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 8. Lookup de RUC/DNI (D-067): opcional de punta a punta
  // -------------------------------------------------------------------------

  test('el lookup de documento nunca bloquea el alta del cliente', async () => {
    // Un RUC que no existe en ningún padrón. Responda lo que responda apis.net.pe —404,
    // timeout, o nada porque el token no está configurado—, el endpoint tiene que
    // contestar 200 con `found:false` y un motivo, nunca un 5xx.
    const missing = await getJson<DocumentLookupDto>(
      api,
      '/api/customers/lookup?docType=RUC&docNumber=20000000001',
    );
    expect(missing.found).toBe(false);
    expect(['NOT_FOUND', 'UNAVAILABLE', 'NOT_CONFIGURED']).toContain(missing.reason);
    expect(missing.name).toBeNull();

    // El carné de extranjería no tiene padrón consultable: se responde sin salir a la red.
    const ce = await getJson<DocumentLookupDto>(
      api,
      '/api/customers/lookup?docType=CE&docNumber=001234567',
    );
    expect(ce.found).toBe(false);

    // Un documento mal formado se rechaza acá y no se gasta una llamada al tercero.
    const invalid = await api.get('/api/customers/lookup?docType=RUC&docNumber=123');
    expect(invalid.status()).toBe(400);

    // Y con el lookup sin datos, la captura manual crea el cliente igual: es el criterio
    // de D-067 (y el mismo fallback del tipo de cambio, D-029).
    const customer = await createCustomer(api);
    expect(customer.name).toContain('E2E Cliente');
    expect(customer.isActive).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 9. Roles (§3.4, D-046)
  // -------------------------------------------------------------------------

  test('el vendedor cotiza y confirma pero no anula pedidos ni libera reservas', async ({
    baseURL,
  }) => {
    const scenario = await setupRoofingScenario(api, { weightKg: '1200' });
    const customer = await createCustomer(api);
    const seller = await createUser(api, 'VENDEDOR');
    const planner = await createUser(api, 'SUPERVISOR_PLANTA');
    const sellerApi = await apiAs(baseURL!, seller);
    const plannerApi = await apiAs(baseURL!, planner);
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
      // El vendedor NO llega a `/coils` (§3.4: esa ruta expone costos y proveedor), así que
      // el material disponible tiene que salir por una ruta propia de ventas sin costos.
      // D-134/D-136: `reservable-coils` ya no existe; lo reemplaza el panel de stock.
      const coilsForSeller = await sellerApi.get(`/api/coils?businessLine=${COVER_LINE}`);
      expect(coilsForSeller.status()).toBe(403);
      const panel = await getJson<{
        rawMaterial: { colorId: string | null; availableKg: string }[];
        products: { productId: string; rawMaterialAvailableKg: string | null }[];
      }>(
        sellerApi,
        `/api/sales/stock-panel?businessLine=${COVER_LINE}&productIds=${scenario.product.id}`,
      );
      const mine = panel.rawMaterial.find((g) => g.colorId === scenario.color.id);
      expect(
        mine,
        'el vendedor tiene que ver el agregado disponible para prometerlo',
      ).toBeDefined();
      expect(mine).toMatchObject({ availableKg: '1200.000' });
      // Ni un campo de costo en la respuesta: es lo que hace que la ruta sea admisible.
      expect(Object.keys(mine!)).not.toContain('unitCostPerKg');
      expect(panel.products.find((p) => p.productId === scenario.product.id)).toMatchObject({
        rawMaterialAvailableKg: '1200.000',
      });

      // El vendedor cotiza, emite y confirma: es su trabajo (§3.4).
      const rows = pieces([6, 1]);
      const quotation = await createQuotation(sellerApi, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: scenario.product.id,
        qty: metersOf(rows),
        unitPricePen: '40',
        pieces: rows,
      });
      trail.quotationIds = [quotation.id];
      await postJson<QuotationDto>(sellerApi, `/api/sales/quotations/${quotation.id}/emit`);
      const order = await postJson<SalesOrderDto>(
        sellerApi,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds = [order.id];

      // Anular el pedido libera stock prometido: es de ADMINISTRADOR (D-046).
      const cancel = await postExpectingError(sellerApi, `/api/sales/orders/${order.id}/cancel`, {
        reason: 'Intento del vendedor',
      });
      expect(cancel.status).toBe(403);

      // Liberar una reserva a mano, también.
      const release = await postExpectingError(
        sellerApi,
        `/api/sales/reservations/${order.reservations[0]!.id}/release`,
        { reason: 'Intento del vendedor' },
      );
      expect(release.status).toBe(403);

      // El supervisor de planta no entra al módulo comercial.
      const forbidden = await sellerApi.get('/api/sales/orders');
      expect(forbidden.ok()).toBe(true);
      const plannerRes = await plannerApi.get('/api/sales/quotations');
      expect(plannerRes.status()).toBe(403);
    } finally {
      await sellerApi.dispose();
      await plannerApi.dispose();
      await purgeRoofingTrail(api, trail);
    }
  });
});
