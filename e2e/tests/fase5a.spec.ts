import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, createUser, getJson, postJson } from '../helpers/api';
import {
  apiAs,
  balanceOf,
  deactivateTrail,
  live,
  movementsOf,
  postExpectingError,
  setupScenario,
  today,
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
  type DocumentLookupDto,
  type QuotationDto,
  type SalesOrderDto,
} from '../helpers/sales';

/**
 * Fase 5a — cotización → confirmación → pedido + reserva (D-054, D-064..D-069).
 *
 * Lo que estos tests protegen, en una línea: **cotizar no toca el inventario, confirmar sí,
 * y desde que confirma nadie más puede tocar ese material**. Todo lo demás (bloqueos,
 * reversas, vencimiento) sale de ahí.
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
  // 1. El flujo completo de una cobertura, hasta la reserva viva
  // -------------------------------------------------------------------------

  test('cotizar una cobertura, confirmarla y ver bajar el disponible de la bobina', async () => {
    const customer = await createCustomer(api);
    const stock = await setupCoilStock(api, { lineCode: COVER_LINE, weightKg: '5000' });
    const product = await createSellableProduct(api, {
      lineCode: COVER_LINE,
      listPricePen: '120.0000',
    });
    const trail: { orderIds: string[]; quotationIds: string[] } = {
      orderIds: [],
      quotationIds: [],
    };

    try {
      // Cotizar NO reserva (D-054): el disponible sigue igual al físico.
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: product.id,
        qty: '10',
        reserveFromCoilId: stock.coil.id,
        reserveKg: '800',
      });
      trail.quotationIds.push(quotation.id);
      expect(quotation.status).toBe('DRAFT');
      expect(quotation.code).toMatch(/^COT-\d{6}$/);
      // Precio de lista tomado del maestro, IGV 18 % separado (D-068).
      expect(quotation.items[0]).toMatchObject({
        listPricePen: '120.0000',
        unitPricePen: '120.0000',
        subtotalPen: '1200.0000',
        igvPen: '216.0000',
        totalPen: '1416.0000',
        reserveItemType: 'COIL',
        reserveItemId: stock.coil.id,
        reserveQty: '800.000',
        reserveUnit: 'KGM',
      });
      expect(quotation.totalPen).toBe('1416.0000');

      const beforeConfirm = await availabilityOf(api, 'COIL', stock.coil.id);
      expect(beforeConfirm).toMatchObject({
        qty: '5000.000',
        reservedQty: '0.000',
        availableQty: '5000.000',
      });

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
      // Un PDF real empieza por `%PDF`; sin esto, un cuerpo vacío pasaría el test.
      expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');

      // Confirmar: pedido y reserva en la misma transacción (D-054).
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds.push(order.id);
      expect(order.code).toMatch(/^PED-\d{6}$/);
      expect(order.status).toBe('CONFIRMED');
      expect(order.quotationId).toBe(quotation.id);
      // El pedido congela los montos de la cotización, no los recalcula.
      expect(order.totalPen).toBe('1416.0000');
      expect(order.reservations).toHaveLength(1);
      expect(order.reservations[0]).toMatchObject({
        itemType: 'COIL',
        itemId: stock.coil.id,
        qty: '800.000',
        unit: 'KGM',
        status: 'ACTIVE',
        productionOrderId: null,
      });

      // Lo que la pantalla de inventario tiene que mostrar: el físico no se movió, el
      // disponible sí. La reserva no es un movimiento de kardex (D-054).
      const afterConfirm = await availabilityOf(api, 'COIL', stock.coil.id);
      expect(afterConfirm).toMatchObject({
        qty: '5000.000',
        reservedQty: '800.000',
        availableQty: '4200.000',
      });
      const movements = live(await movementsOf(api, 'COIL', stock.coil.id));
      expect(movements, 'confirmar no debe emitir ningún movimiento de kardex').toHaveLength(1);
      expect(movements[0]).toMatchObject({ type: 'IN', refType: 'PURCHASE' });

      // La cotización queda confirmada y apunta a su pedido.
      const confirmed = await getJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}`);
      expect(confirmed).toMatchObject({ status: 'CONFIRMED', salesOrderId: order.id });

      // Y no se puede confirmar dos veces (idempotencia, mismo criterio que D-061).
      const twice = await postExpectingError(api, `/api/sales/quotations/${quotation.id}/confirm`);
      expect(twice.status).toBe(409);
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
  // 2. La OP nacida del pedido consume la reserva
  // -------------------------------------------------------------------------

  /**
   * El otro extremo del hook de D-054: una OP creada contra una reserva monta el material
   * reservado (que para cualquier otra orden está bloqueado) y, al emitir el primer
   * material, la reserva pasa a `CONSUMIDA` y el pedido a "en producción".
   *
   * Va sobre drywall y no sobre coberturas porque **producir coberturas es Fase 5b**: el
   * módulo `production` solo sabe fabricar perfiles (D-048). Lo que se prueba acá es el
   * enganche reserva↔OP, que es exactamente el mismo para las dos líneas.
   */
  test('una OP contra la reserva la consume al reportar y el kardex cuadra', async () => {
    const customer = await createCustomer(api);
    const scenario = await setupScenario(api);
    const strip = scenario.strips[0]!;
    const trail: { orderIds: string[]; quotationIds: string[] } = {
      orderIds: [],
      quotationIds: [],
    };
    const productionOrderIds: string[] = [];

    try {
      // Pedido directo de perfiles (drywall no exige cotización, D-065) que promete
      // 1 000 kg del fleje.
      const order = await postJson<SalesOrderDto>(api, '/api/sales/orders', {
        customerId: customer.id,
        businessLine: PROFILE_LINE,
        issueDate: today(),
        items: [
          {
            productId: scenario.product.id,
            qty: '100',
            unitPricePen: '35.0000',
            reserveFromCoilId: strip.id,
            reserveKg: '1000',
          },
        ],
      });
      trail.orderIds.push(order.id);
      const reservation = order.reservations[0]!;
      expect(reservation.status).toBe('ACTIVE');
      expect(await availabilityOf(api, 'COIL', strip.id)).toMatchObject({
        qty: '2400.000',
        reservedQty: '1000.000',
        availableQty: '1400.000',
      });

      // Una OP sin la reserva NO puede montar ese fleje: es el guardrail de custodia.
      const foreign = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: scenario.product.id,
      });
      productionOrderIds.push(foreign.id);
      const blocked = await postExpectingError(api, `/api/production/${foreign.id}/consume`, {
        coilId: strip.id,
      });
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain('reservado');
      expect(blocked.message).toContain(order.code);

      // La OP nacida del pedido sí, porque la excepción es su propia reserva.
      const op = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: scenario.product.id,
        reservationId: reservation.id,
        targetPieces: 100,
      });
      productionOrderIds.push(op.id);
      await postJson<ProductionOrderDto>(api, `/api/production/${op.id}/consume`, {
        coilId: strip.id,
        qtyKg: '1000',
      });

      // Asignar todavía no consume la reserva (D-060: asignar no mueve kardex).
      const stillActive = await getJson<SalesOrderDto>(api, `/api/sales/orders/${order.id}`);
      expect(stillActive.reservations[0]!.status).toBe('ACTIVE');

      // Reportar piezas sí: sale material del fleje, así que la promesa se cumple.
      const reported = await postJson<ProductionOrderDto>(api, `/api/production/${op.id}/report`, {
        pieces: 100,
      });
      expect(reported.piecesReported).toBe(100);

      const afterReport = await getJson<SalesOrderDto>(api, `/api/sales/orders/${order.id}`);
      expect(afterReport.status).toBe('IN_PRODUCTION');
      expect(afterReport.reservations[0]).toMatchObject({
        status: 'CONSUMED',
        productionOrderId: op.id,
      });
      expect(afterReport.reservations[0]!.consumedAt).not.toBeNull();

      // El kardex cuadra: salieron 200 kg del fleje (100 piezas × 2 kg) y entraron
      // 100 piezas al producto, y el disponible ya no descuenta nada reservado.
      const stripBalance = await balanceOf(api, 'COIL', strip.id);
      expect(stripBalance.qty).toBe('2200.000');
      const productBalance = await balanceOf(api, 'PRODUCT', scenario.product.id);
      expect(productBalance.qty).toBe('100.000');
      expect(await availabilityOf(api, 'COIL', strip.id)).toMatchObject({
        reservedQty: '0.000',
        availableQty: '2200.000',
      });

      // Con la OP viva fabricando ese material, el pedido no se puede anular.
      const cannotCancel = await postExpectingError(api, `/api/sales/orders/${order.id}/cancel`, {
        reason: 'Intento con la orden de producción en curso',
      });
      expect(cannotCancel.status).toBe(400);
      expect(cannotCancel.message).toContain(op.code);

      // Pero deshaciendo la OP sí: una reserva `CONSUMIDA` no vuelve atrás (§3.2), así que
      // si el bloqueo mirara solo el estado de la reserva, este pedido quedaría sin poder
      // anularse **para siempre** — el mismo agujero que D-061 cerró con los pagos.
      await postJson<ProductionOrderDto>(
        api,
        `/api/production/${op.id}/reports/${
          reported.reports.find((r) => r.status === 'ACTIVE')!.id
        }/reverse`,
        { reason: 'Deshacer la corrida de prueba' },
      );
      await postJson<ProductionOrderDto>(api, `/api/production/${op.id}/cancel`, {
        reason: 'Deshacer la corrida de prueba',
      });
      const finallyCancelled = await postJson<SalesOrderDto>(
        api,
        `/api/sales/orders/${order.id}/cancel`,
        { reason: 'El cliente se echó atrás tras deshacer la producción' },
      );
      expect(finallyCancelled.status).toBe('CANCELLED');
      // La reserva consumida queda como estaba: el ledger es append-only, no se reescribe.
      expect(finallyCancelled.reservations[0]!.status).toBe('CONSUMED');
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
    const cover = await createSellableProduct(api, { lineCode: COVER_LINE });
    const stock = await setupCoilStock(api, { lineCode: PROFILE_LINE, weightKg: '3000' });
    const trail: { orderIds: string[]; quotationIds: string[] } = {
      orderIds: [],
      quotationIds: [],
    };

    try {
      // Perfiles: pedido directo, sin cotización previa.
      const order = await postJson<SalesOrderDto>(api, '/api/sales/orders', {
        customerId: customer.id,
        businessLine: PROFILE_LINE,
        issueDate: today(),
        items: [
          {
            productId: profile.id,
            qty: '40',
            reserveFromCoilId: stock.coil.id,
            reserveKg: '500',
          },
        ],
      });
      trail.orderIds.push(order.id);
      expect(order.quotationId, 'un pedido directo no tiene cotización detrás').toBeNull();
      // El precio salió del maestro sin escribirlo en la línea (D-068).
      expect(order.items[0]).toMatchObject({ listPricePen: '18.5000', unitPricePen: '18.5000' });
      expect(order.reservations[0]!.status).toBe('ACTIVE');

      // Coberturas: el mismo endpoint tiene que rechazarlo, o el flag no significaría nada.
      const rejected = await postExpectingError(api, '/api/sales/orders', {
        customerId: customer.id,
        businessLine: COVER_LINE,
        issueDate: today(),
        items: [{ productId: cover.id, qty: '5', unitPricePen: '100', reserveKg: '100' }],
      });
      expect(rejected.status).toBe(400);
    } finally {
      await purgeSalesTrail(api, trail);
      await deactivateTrail(api, {
        motherId: stock.coil.id,
        purchaseId: stock.purchaseId,
        supplierId: stock.supplier.id,
        finish: stock.finish,
        productIds: [profile.id, cover.id],
      });
    }
  });

  // -------------------------------------------------------------------------
  // 4. Disponible insuficiente: falla completa, nunca parcial
  // -------------------------------------------------------------------------

  test('confirmar sin disponible suficiente falla entera y no deja pedido a medias', async () => {
    const customer = await createCustomer(api);
    const stock = await setupCoilStock(api, { lineCode: COVER_LINE, weightKg: '1000' });
    const product = await createSellableProduct(api, {
      lineCode: COVER_LINE,
      listPricePen: '90.0000',
    });
    const trail: { orderIds: string[]; quotationIds: string[] } = {
      orderIds: [],
      quotationIds: [],
    };

    try {
      // Primera cotización: reserva 900 de los 1 000 kg.
      const first = await createQuotation(api, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: product.id,
        qty: '5',
        reserveFromCoilId: stock.coil.id,
        reserveKg: '900',
      });
      trail.quotationIds.push(first.id);
      await postJson<QuotationDto>(api, `/api/sales/quotations/${first.id}/emit`);
      const firstOrder = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${first.id}/confirm`,
      );
      trail.orderIds.push(firstOrder.id);

      // Segunda cotización sobre la misma bobina: solo quedan 100 kg disponibles.
      const second = await createQuotation(api, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: product.id,
        qty: '5',
        reserveFromCoilId: stock.coil.id,
        reserveKg: '300',
      });
      trail.quotationIds.push(second.id);
      await postJson<QuotationDto>(api, `/api/sales/quotations/${second.id}/emit`);

      const failed = await postExpectingError(api, `/api/sales/quotations/${second.id}/confirm`);
      expect(failed.status).toBe(400);
      // El mensaje tiene que decir físico, reservado y faltante: sin eso el vendedor no
      // sabe si liberar una reserva o comprar material.
      expect(failed.message).toContain('100.000');
      expect(failed.message).toContain('900.000');

      // Falla completa: la cotización sigue emitida, sin pedido ni reserva colgando.
      const untouched = await getJson<QuotationDto>(api, `/api/sales/quotations/${second.id}`);
      expect(untouched).toMatchObject({ status: 'EMITTED', salesOrderId: null });
      expect(await availabilityOf(api, 'COIL', stock.coil.id)).toMatchObject({
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
        productId: product.id,
      });
    }
  });

  // -------------------------------------------------------------------------
  // 5. La invariante transversal: merma, corte, cierre y anulación
  // -------------------------------------------------------------------------

  test('con stock reservado se bloquean merma, envío a corte, cierre y anulación', async () => {
    const customer = await createCustomer(api);
    const stock = await setupCoilStock(api, { lineCode: COVER_LINE, weightKg: '2000' });
    const product = await createSellableProduct(api, {
      lineCode: COVER_LINE,
      listPricePen: '75.0000',
    });
    const trail: { orderIds: string[]; quotationIds: string[] } = {
      orderIds: [],
      quotationIds: [],
    };

    try {
      // Coberturas exige cotización (D-065), así que la reserva nace de confirmarla.
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: product.id,
        qty: '10',
        reserveFromCoilId: stock.coil.id,
        reserveKg: '1500',
      });
      trail.quotationIds.push(quotation.id);
      await postJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}/emit`);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds.push(order.id);

      // (a) Merma que dejaría menos de lo reservado: bloqueada por la invariante de
      //     cantidad, dentro de `InventoryService` (D-066).
      const scrap = await postExpectingError(api, `/api/coils/${stock.coil.id}/scrap`, {
        qtyKg: '800',
        reason: 'Merma que rompería la reserva',
      });
      expect(scrap.status).toBe(400);
      expect(scrap.message).toContain('1500.000');
      expect(scrap.message).toContain(order.code);

      // (b) Merma que respeta lo reservado: pasa. La invariante bloquea lo que rompe la
      //     promesa, no toda operación sobre la bobina.
      await postJson(api, `/api/coils/${stock.coil.id}/scrap`, {
        qtyKg: '400',
        reason: 'Merma dentro de lo no reservado',
      });
      expect(await availabilityOf(api, 'COIL', stock.coil.id)).toMatchObject({
        qty: '1600.000',
        reservedQty: '1500.000',
        availableQty: '100.000',
      });

      // (c) Envío a corte tercerizado: no mueve kardex (D-050), así que lo tiene que
      //     bloquear el guardrail de custodia.
      const cutting = await postExpectingError(api, '/api/cutting', {
        supplierId: stock.supplier.id,
        notes: 'Envío que se llevaría material prometido',
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

      // (d) Cerrar la bobina (RF-19) tampoco mueve kardex y la sacaría de producción.
      const close = await postExpectingError(api, `/api/coils/${stock.coil.id}/status`, {
        status: 'CLOSED',
      });
      expect(close.status).toBe(400);
      expect(close.message).toContain(order.code);

      // (e) Anular la compra revierte el ingreso de la bobina: misma invariante, otra puerta.
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
        productId: product.id,
      });
    }
  });

  // -------------------------------------------------------------------------
  // 6. Reversas: anular el pedido y liberar a mano
  // -------------------------------------------------------------------------

  test('anular el pedido libera la reserva, restaura el disponible y devuelve la cotización a emitida', async () => {
    const customer = await createCustomer(api);
    const stock = await setupCoilStock(api, { lineCode: COVER_LINE, weightKg: '2500' });
    const product = await createSellableProduct(api, {
      lineCode: COVER_LINE,
      listPricePen: '60.0000',
    });
    const trail: { orderIds: string[]; quotationIds: string[] } = {
      orderIds: [],
      quotationIds: [],
    };

    try {
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: product.id,
        qty: '12',
        reserveFromCoilId: stock.coil.id,
        reserveKg: '1200',
        validityDays: 30,
      });
      trail.quotationIds.push(quotation.id);
      await postJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}/emit`);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds.push(order.id);
      expect(await availabilityOf(api, 'COIL', stock.coil.id)).toMatchObject({
        availableQty: '1300.000',
      });

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

      // El disponible vuelve a ser el físico completo.
      expect(await availabilityOf(api, 'COIL', stock.coil.id)).toMatchObject({
        qty: '2500.000',
        reservedQty: '0.000',
        availableQty: '2500.000',
      });

      // La cotización vuelve a EMITIDA porque sigue vigente, y se puede confirmar de nuevo.
      const back = await getJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}`);
      expect(back).toMatchObject({ status: 'EMITTED', salesOrderId: null });

      const second = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds.push(second.id);
      expect(second.reservations[0]!.status).toBe('ACTIVE');

      // Liberación manual sin anular el pedido (D-054): el pedido sigue vivo, la promesa no.
      const released = await postJson<{ status: string }>(
        api,
        `/api/sales/reservations/${second.reservations[0]!.id}/release`,
        { reason: 'Liberación manual de la prueba' },
      );
      expect(released.status).toBe('RELEASED');
      expect(await availabilityOf(api, 'COIL', stock.coil.id)).toMatchObject({
        availableQty: '2500.000',
      });

      // Idempotencia: una reserva ya liberada no se vuelve a liberar.
      const twice = await postExpectingError(
        api,
        `/api/sales/reservations/${second.reservations[0]!.id}/release`,
        { reason: 'Otra vez' },
      );
      expect(twice.status).toBe(409);

      // Y ahora que no hay reservas vivas, la bobina se puede cerrar sin problema: el
      // bloqueo era la reserva, no la bobina.
      await postJson(api, `/api/coils/${stock.coil.id}/status`, { status: 'CLOSED' });
      await postJson(api, `/api/coils/${stock.coil.id}/status`, { status: 'OPEN' });
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
  // 7. Vencimiento (D-069)
  // -------------------------------------------------------------------------

  test('una cotización vencida la marca el job y ya no se puede confirmar', async () => {
    const customer = await createCustomer(api);
    const stock = await setupCoilStock(api, { lineCode: COVER_LINE, weightKg: '1500' });
    const product = await createSellableProduct(api, {
      lineCode: COVER_LINE,
      listPricePen: '50.0000',
    });
    const trail: { orderIds: string[]; quotationIds: string[] } = {
      orderIds: [],
      quotationIds: [],
    };

    try {
      // Emitida hace 10 días con 1 día de vigencia: venció hace 9.
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

      // Nunca reservó nada: el disponible quedó intacto de punta a punta.
      expect(await availabilityOf(api, 'COIL', stock.coil.id)).toMatchObject({
        reservedQty: '0.000',
        availableQty: '1500.000',
      });
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
    const customer = await createCustomer(api);
    const stock = await setupCoilStock(api, { lineCode: COVER_LINE, weightKg: '1200' });
    const product = await createSellableProduct(api, {
      lineCode: COVER_LINE,
      listPricePen: '40.0000',
    });
    const seller = await createUser(api, 'VENDEDOR');
    const planner = await createUser(api, 'SUPERVISOR_PLANTA');
    const sellerApi = await apiAs(baseURL!, seller);
    const plannerApi = await apiAs(baseURL!, planner);
    const trail: { orderIds: string[]; quotationIds: string[] } = {
      orderIds: [],
      quotationIds: [],
    };

    try {
      // El vendedor cotiza, emite y confirma: es su trabajo (§3.4).
      const quotation = await createQuotation(sellerApi, {
        customerId: customer.id,
        businessLine: COVER_LINE,
        productId: product.id,
        qty: '6',
        reserveFromCoilId: stock.coil.id,
        reserveKg: '400',
      });
      trail.quotationIds.push(quotation.id);
      await postJson<QuotationDto>(sellerApi, `/api/sales/quotations/${quotation.id}/emit`);
      const order = await postJson<SalesOrderDto>(
        sellerApi,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds.push(order.id);

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
