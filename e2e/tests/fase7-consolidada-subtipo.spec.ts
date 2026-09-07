import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, postJson } from '../helpers/api';
import {
  createCuttingSupplier,
  errorFrom,
  putJson,
  today,
  type ProductBomDto,
  type ProductDto,
} from '../helpers/production';
import {
  buyRoofingCoil,
  createColor,
  createRoofingFinish,
  createRoofingProduct,
  metersOf,
  pieces,
  purgeRoofingTrail,
  reservationsOf,
  NOMINAL_THICKNESS,
  ROOFING_LINE,
} from '../helpers/roofing';
import { createCustomer, queueOf, type QuotationDto, type SalesOrderDto } from '../helpers/sales';

/**
 * Fase 7 consolidada — **subtipo de cobertura** (D-127).
 *
 * Lo que estos tests protegen, en una línea: **`roofingKind` decide la rama de la
 * confirmación**, y una cobertura `A_MEDIDA` reserva materia prima en vez de exigir stock de
 * un producto terminado que no existe hasta que planta lo rola.
 *
 * El primer caso es el que falló en producción: una cotización a medida, sin bobina elegida
 * a mano, que al confirmarse pedía saldo de un SKU que siempre está en cero y moría con
 * "0.000 MTR disponibles". El pedido nunca llegaba a la cola de producción, así que el
 * defecto no se veía como un error de catálogo sino como una venta que se perdía.
 *
 * Los números están elegidos para comprobarse a ojo: bobina de 1 000 mm × 0.50 mm con un
 * acabado de densidad 8.0 son **4 kg por metro lineal** (helpers/roofing).
 */

/** Kilos por metro lineal de la geometría de prueba. Ver el encabezado. */
const KG_PER_METER = 4;

/** Los subítems del caso real: 5 planchas de 5 m + 6 de 6 m = 61 metros lineales. */
const REAL_CASE_ROWS = pieces([5, 5], [6, 6]);

async function emitAndConfirm(api: APIRequestContext, quotationId: string): Promise<SalesOrderDto> {
  await postJson<QuotationDto>(api, `/api/sales/quotations/${quotationId}/emit`);
  return postJson<SalesOrderDto>(api, `/api/sales/quotations/${quotationId}/confirm`, {});
}

async function emitAndConfirmExpectingError(
  api: APIRequestContext,
  quotationId: string,
): Promise<{ status: number; message: string }> {
  await postJson<QuotationDto>(api, `/api/sales/quotations/${quotationId}/emit`);
  return errorFrom(
    await api.post(`/api/sales/quotations/${quotationId}/confirm`, { data: {} }),
    `confirmar la cotización ${quotationId}`,
  );
}

test.describe('D-127 — subtipo de cobertura', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  // Cada caso arma compra, recepción, catálogo, receta, cotización y confirmación.
  test.describe.configure({ timeout: 120_000 });

  // -------------------------------------------------------------------------
  // 1 — El caso que falló en producción
  // -------------------------------------------------------------------------

  test('una cotización a medida sin bobina elegida se confirma sin stock de producto terminado y reserva kilos de bobina', async () => {
    const supplier = await createCuttingSupplier(api);
    const finish = await createRoofingFinish(api);
    const color = await createColor(api);
    const customer = await createCustomer(api);
    const { product } = await createRoofingProduct(api, {
      finishId: finish.id,
      colorId: color.id,
    });
    const { coil, purchaseId } = await buyRoofingCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: color.id,
      weightKg: '2000',
    });
    const trail: { orderIds: string[]; quotationIds: string[] } = {
      orderIds: [],
      quotationIds: [],
    };

    try {
      expect(product.unit, 'una cobertura a medida se mide en metros lineales').toBe('MTR');
      expect((product as ProductDto & { roofingKind: string }).roofingKind).toBe('A_MEDIDA');

      const meters = metersOf(REAL_CASE_ROWS);
      expect(meters, '5×5 m + 6×6 m').toBe('61.000');

      // La línea NO elige bobina: es exactamente lo que manda el vendedor, que sabe metros
      // y color y no qué rollo concreto los va a dar.
      const quotation = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        issueDate: today(),
        items: [
          {
            productId: product.id,
            qty: meters,
            unitPricePen: '30',
            pieces: REAL_CASE_ROWS,
          },
        ],
      });
      trail.quotationIds.push(quotation.id);

      // La **cotización** no congela materia prima: guarda su intención (producto y metros)
      // y nada más. Elegir la bobina acá impediría cotizar sin stock y dejaría el rollo
      // apuntado por hasta 365 días (D-069), cuando ya puede estar cerrado o consumido.
      expect(quotation.items[0]).toMatchObject({
        reserveItemType: 'PRODUCT',
        reserveItemId: product.id,
      });

      const order = await emitAndConfirm(api, quotation.id);
      trail.orderIds.push(order.id);
      expect(order.status).toBe('CONFIRMED');
      // Y el **pedido** sí: la línea nace apuntando a la bobina que el API acaba de elegir.
      expect(order.items[0]).toMatchObject({ reserveItemType: 'COIL', reserveItemId: coil.id });

      // Lo prometido son **kilos de esa bobina**, no unidades de un producto terminado.
      const reservations = await reservationsOf(api, order.id);
      expect(reservations).toHaveLength(1);
      const reservation = reservations[0]!;
      expect(reservation).toMatchObject({
        itemType: 'COIL',
        itemId: coil.id,
        unit: 'KGM',
        status: 'ACTIVE',
      });
      expect(reservation.qty, '61 ml × 4 kg/ml').toBe((Number(meters) * KG_PER_METER).toFixed(3));

      // Y el pedido llega a la cola de producción, que es lo que el defecto impedía: sin
      // reserva de materia prima no había nada que fabricar y la orden nunca aparecía.
      const queue = await queueOf(api);
      const entry = queue.find((q) => q.reservationId === reservation.id);
      expect(entry, 'el pedido a medida entra a la cola de producción (RF-37)').toBeDefined();
      expect(entry!.salesOrderId).toBe(order.id);
      expect(entry!.productId).toBe(product.id);
      expect(entry!.pieces.map((p) => ({ lengthMm: p.lengthMm, qty: p.qty }))).toEqual(
        REAL_CASE_ROWS.map((r) => ({ lengthMm: r.lengthMm, qty: r.qty })),
      );
    } finally {
      await purgeRoofingTrail(api, {
        orderIds: trail.orderIds,
        quotationIds: trail.quotationIds,
        coilIds: [coil.id],
        purchaseIds: [purchaseId],
        productIds: [product.id],
        supplierId: supplier.id,
        finishId: finish.id,
        colorId: color.id,
      });
    }
  });

  // -------------------------------------------------------------------------
  // 2 — La plancha sigue exigiendo stock
  // -------------------------------------------------------------------------

  test('una plancha de catálogo sin saldo de producto terminado no se puede confirmar', async () => {
    const supplier = await createCuttingSupplier(api);
    const finish = await createRoofingFinish(api);
    const color = await createColor(api);
    const customer = await createCustomer(api);
    // Plancha: largo fijo, unidad `NIU`. La receta existe igual —planta la rola— pero la
    // venta sale del almacén, no de la bobina.
    const { product } = await createRoofingProduct(api, {
      finishId: finish.id,
      colorId: color.id,
      pieceLengthMm: '3000',
    });
    // Hay bobina disponible del color y espesor correctos a propósito: si la rama del
    // subtipo estuviera invertida, la confirmación pasaría reservando materia prima y este
    // test se pondría verde por el motivo equivocado.
    const { coil, purchaseId } = await buyRoofingCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: color.id,
      weightKg: '2000',
    });
    const quotationIds: string[] = [];

    try {
      expect(product.unit).toBe('NIU');
      expect((product as ProductDto & { roofingKind: string }).roofingKind).toBe('PLANCHA');

      const quotation = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        issueDate: today(),
        items: [{ productId: product.id, qty: '10', unitPricePen: '80' }],
      });
      quotationIds.push(quotation.id);

      const error = await emitAndConfirmExpectingError(api, quotation.id);
      expect(error.status).toBe(400);
      expect(
        error.message.toLowerCase(),
        'la plancha se atiende con stock de producto terminado, y no lo hay',
      ).toContain('disponible');
    } finally {
      await purgeRoofingTrail(api, {
        quotationIds,
        coilIds: [coil.id],
        purchaseIds: [purchaseId],
        productIds: [product.id],
        supplierId: supplier.id,
        finishId: finish.id,
        colorId: color.id,
      });
    }
  });

  // -------------------------------------------------------------------------
  // 3 — Cambiar el subtipo cambia la rama
  // -------------------------------------------------------------------------

  test('cambiar un producto de plancha a a-medida cambia la rama de la confirmación', async () => {
    const supplier = await createCuttingSupplier(api);
    const finish = await createRoofingFinish(api);
    const color = await createColor(api);
    const customer = await createCustomer(api);
    // Nace plancha **con receta activa**: es el SKU mal dado de alta que hay que corregir, y
    // la corrección tiene que poder hacerse tal como está. Cambiar la unidad sola sigue
    // bloqueada mientras haya receta (D-055/D-059); lo que se permite es cambiarla **junto
    // con** el subtipo, porque ahí no se está esquivando la validación sino reclasificando
    // el producto entero.
    const { product } = await createRoofingProduct(api, {
      finishId: finish.id,
      colorId: color.id,
      pieceLengthMm: '3000',
    });
    const { coil, purchaseId } = await buyRoofingCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: color.id,
      weightKg: '2000',
    });
    const trail: { orderIds: string[]; quotationIds: string[] } = {
      orderIds: [],
      quotationIds: [],
    };

    try {
      // (a) Como plancha, sin stock, no se confirma.
      const asPlancha = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        issueDate: today(),
        items: [{ productId: product.id, qty: '10', unitPricePen: '80' }],
      });
      trail.quotationIds.push(asPlancha.id);
      const blocked = await emitAndConfirmExpectingError(api, asPlancha.id);
      expect(blocked.status).toBe(400);
      expect(blocked.message.toLowerCase()).toContain('disponible');

      // (b) Se corrige el subtipo. La unidad y el largo van con él: `A_MEDIDA` se mide en
      // `MTR` y tiene prohibido el largo fijo (lo traen los subítems de cada línea).
      const patched = await api.patch(`/api/catalog/${product.id}`, {
        data: { roofingKind: 'A_MEDIDA', unit: 'MTR', lengthMm: '' },
      });
      expect(patched.ok(), `PATCH catálogo falló: ${await patched.text()}`).toBe(true);
      const updated = (await patched.json()) as ProductDto & { roofingKind: string | null };
      expect(updated).toMatchObject({ roofingKind: 'A_MEDIDA', unit: 'MTR', lengthMm: null });

      // La receta se reescribe sin `pieceLengthMm`: una cobertura a medida no tiene largo
      // propio, lo traen los subítems de cada línea (D-083).
      await putJson<ProductBomDto>(api, `/api/production/boms/${product.id}`, {
        kind: 'ROOFING',
        finishId: finish.id,
        inputThicknessMm: NOMINAL_THICKNESS,
      });

      // (c) La misma venta, ahora por la otra rama: reserva materia prima y no exige stock.
      const meters = metersOf(REAL_CASE_ROWS);
      const asMedida = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        issueDate: today(),
        items: [{ productId: product.id, qty: meters, unitPricePen: '30', pieces: REAL_CASE_ROWS }],
      });
      trail.quotationIds.push(asMedida.id);
      const order = await emitAndConfirm(api, asMedida.id);
      trail.orderIds.push(order.id);

      const reservations = await reservationsOf(api, order.id);
      expect(reservations).toHaveLength(1);
      expect(reservations[0]).toMatchObject({
        itemType: 'COIL',
        itemId: coil.id,
        unit: 'KGM',
        qty: (Number(meters) * KG_PER_METER).toFixed(3),
        status: 'ACTIVE',
      });
    } finally {
      await purgeRoofingTrail(api, {
        orderIds: trail.orderIds,
        quotationIds: trail.quotationIds,
        coilIds: [coil.id],
        purchaseIds: [purchaseId],
        productIds: [product.id],
        supplierId: supplier.id,
        finishId: finish.id,
        colorId: color.id,
      });
    }
  });

  // -------------------------------------------------------------------------
  // 4 — Cotizar sin stock (la materia prima se resuelve al confirmar)
  // -------------------------------------------------------------------------

  test('una cotización a medida se crea sin ninguna bobina disponible, y recién el confirmar exige material', async () => {
    const supplier = await createCuttingSupplier(api);
    const finish = await createRoofingFinish(api);
    // Color propio del test: es lo que garantiza que **ninguna** bobina de la base sirva.
    // El filtro compara el color con igualdad estricta (D-086), así que un color recién
    // creado no tiene ni puede tener materia prima detrás.
    const color = await createColor(api);
    const customer = await createCustomer(api);
    const { product } = await createRoofingProduct(api, {
      finishId: finish.id,
      colorId: color.id,
    });
    const meters = metersOf(REAL_CASE_ROWS);
    const trail: { orderIds: string[]; quotationIds: string[]; coilIds: string[] } = {
      orderIds: [],
      quotationIds: [],
      coilIds: [],
    };
    let purchaseId: string | undefined;

    try {
      // (a) Sin una sola bobina de ese color, la cotización se crea igual. Es el caso normal
      // del rubro: se cotiza y recién si el cliente acepta se compra el material.
      const quotation = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        issueDate: today(),
        items: [{ productId: product.id, qty: meters, unitPricePen: '30', pieces: REAL_CASE_ROWS }],
      });
      trail.quotationIds.push(quotation.id);
      expect(quotation.items[0]!.reserveItemType).toBe('PRODUCT');

      // (b) Confirmarla sin material sí se cae, y con el mensaje que dice qué hacer.
      const blocked = await emitAndConfirmExpectingError(api, quotation.id);
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain('no hay ninguna bobina abierta');

      // (c) Se compra la bobina y la misma cotización, sin tocarla, ya se confirma.
      const bought = await buyRoofingCoil(api, {
        supplierId: supplier.id,
        finishId: finish.id,
        colorId: color.id,
        weightKg: '2000',
      });
      purchaseId = bought.purchaseId;
      trail.coilIds.push(bought.coil.id);

      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
        {},
      );
      trail.orderIds.push(order.id);
      const reservations = await reservationsOf(api, order.id);
      expect(reservations).toHaveLength(1);
      expect(reservations[0]).toMatchObject({
        itemType: 'COIL',
        itemId: bought.coil.id,
        qty: (Number(meters) * KG_PER_METER).toFixed(3),
        status: 'ACTIVE',
      });
    } finally {
      await purgeRoofingTrail(api, {
        orderIds: trail.orderIds,
        quotationIds: trail.quotationIds,
        coilIds: trail.coilIds,
        purchaseIds: purchaseId ? [purchaseId] : [],
        productIds: [product.id],
        supplierId: supplier.id,
        finishId: finish.id,
        colorId: color.id,
      });
    }
  });

  // -------------------------------------------------------------------------
  // 5 — La bobina se elige al confirmar, no al cotizar
  // -------------------------------------------------------------------------

  test('si la bobina que había al cotizar ya no sirve, el pedido reserva la que sí está disponible al confirmar', async () => {
    const supplier = await createCuttingSupplier(api);
    const finish = await createRoofingFinish(api);
    const color = await createColor(api);
    const customer = await createCustomer(api);
    const { product } = await createRoofingProduct(api, {
      finishId: finish.id,
      colorId: color.id,
    });
    const first = await buyRoofingCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: color.id,
      weightKg: '2000',
    });
    const meters = metersOf(REAL_CASE_ROWS);
    const trail: { orderIds: string[]; quotationIds: string[]; coilIds: string[] } = {
      orderIds: [],
      quotationIds: [],
      coilIds: [first.coil.id],
    };
    let secondPurchaseId: string | undefined;

    try {
      const quotation = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        issueDate: today(),
        items: [{ productId: product.id, qty: meters, unitPricePen: '30', pieces: REAL_CASE_ROWS }],
      });
      trail.quotationIds.push(quotation.id);

      // La primera bobina se cierra (RF-19): sale del filtro de la OP y de la elección de
      // materia prima, igual que si se hubiera consumido entera. Es lo que pasa de verdad
      // entre cotizar y confirmar cuando pasan días.
      await postJson(api, `/api/coils/${first.coil.id}/status`, {
        status: 'CLOSED',
        reason: 'La bobina se agotó en otra corrida (prueba E2E)',
      });

      const second = await buyRoofingCoil(api, {
        supplierId: supplier.id,
        finishId: finish.id,
        colorId: color.id,
        weightKg: '2000',
      });
      secondPurchaseId = second.purchaseId;
      trail.coilIds.push(second.coil.id);

      const order = await emitAndConfirm(api, quotation.id);
      trail.orderIds.push(order.id);

      const reservations = await reservationsOf(api, order.id);
      expect(reservations).toHaveLength(1);
      expect(
        reservations[0]!.itemId,
        'la reserva tiene que apuntar a la bobina viva de hoy, no a la que había al cotizar',
      ).toBe(second.coil.id);
      expect(reservations[0]!.itemId).not.toBe(first.coil.id);
    } finally {
      await purgeRoofingTrail(api, {
        orderIds: trail.orderIds,
        quotationIds: trail.quotationIds,
        coilIds: trail.coilIds,
        purchaseIds: [first.purchaseId, ...(secondPurchaseId ? [secondPurchaseId] : [])],
        productIds: [product.id],
        supplierId: supplier.id,
        finishId: finish.id,
        colorId: color.id,
      });
    }
  });

  // -------------------------------------------------------------------------
  // 6 — Dos líneas del mismo producto no se pisan la bobina
  // -------------------------------------------------------------------------

  test('dos líneas a medida del mismo producto no eligen la misma bobina cuando una sola no alcanza para las dos', async () => {
    const supplier = await createCuttingSupplier(api);
    const finish = await createRoofingFinish(api);
    const color = await createColor(api);
    const customer = await createCustomer(api);
    const { product } = await createRoofingProduct(api, {
      finishId: finish.id,
      colorId: color.id,
    });
    const meters = metersOf(REAL_CASE_ROWS);
    const neededKg = Number(meters) * KG_PER_METER; // 244 kg por línea.
    // 300 kg cada una: alcanza para **una** línea y no para las dos. Si el API no
    // descontara lo que la línea anterior ya comprometió, las dos elegirían la primera y el
    // pedido se caería más abajo, contra la invariante de reservas.
    const first = await buyRoofingCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: color.id,
      weightKg: '300',
    });
    const second = await buyRoofingCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: color.id,
      weightKg: '300',
    });
    const orderIds: string[] = [];
    const quotationIds: string[] = [];

    try {
      expect(neededKg).toBeLessThan(300);
      expect(neededKg * 2).toBeGreaterThan(300);

      // Vía cotización y no alta directa: una cobertura fabricada exige cotización
      // confirmada (RF-31), que además es donde vive la elección de materia prima.
      const quotation = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        issueDate: today(),
        items: [
          { productId: product.id, qty: meters, unitPricePen: '30', pieces: REAL_CASE_ROWS },
          { productId: product.id, qty: meters, unitPricePen: '30', pieces: REAL_CASE_ROWS },
        ],
      });
      quotationIds.push(quotation.id);
      const order = await emitAndConfirm(api, quotation.id);
      orderIds.push(order.id);

      const reservations = await reservationsOf(api, order.id);
      expect(reservations).toHaveLength(2);
      const usedCoils = reservations.map((r) => r.itemId);
      expect(new Set(usedCoils).size, 'cada línea toma una bobina distinta').toBe(2);
      expect(new Set(usedCoils)).toEqual(new Set([first.coil.id, second.coil.id]));
      for (const reservation of reservations) {
        expect(reservation).toMatchObject({
          itemType: 'COIL',
          unit: 'KGM',
          qty: neededKg.toFixed(3),
          status: 'ACTIVE',
        });
      }
    } finally {
      await purgeRoofingTrail(api, {
        orderIds,
        quotationIds,
        coilIds: [first.coil.id, second.coil.id],
        purchaseIds: [first.purchaseId, second.purchaseId],
        productIds: [product.id],
        supplierId: supplier.id,
        finishId: finish.id,
        colorId: color.id,
      });
    }
  });
});
