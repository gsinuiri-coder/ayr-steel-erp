import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, closeCoilKeepingStock, postJson } from '../helpers/api';
import {
  createCuttingSupplier,
  errorFrom,
  optionalBalanceOf,
  today,
  type ProductDto,
} from '../helpers/production';
import {
  buyRoofingCoil,
  createColor,
  createRoofingFinish,
  createRoofingProduct,
  KG_PER_METER,
  metersOf,
  pieces,
  purgeRoofingTrail,
  reservationsOf,
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
 * acabado de densidad 8.0 son 4 kg por metro de geometría, y **4.04 con el 1 % de merma
 * normal que D-165 metió en la densidad estándar** — que es lo que de verdad sale del rollo,
 * y por eso los 61 m del caso real reservan 246.44 kg y no 244 (`KG_PER_METER` en
 * helpers/roofing).
 */

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

      // D-134: la cotización ya nombra el **agregado** de materia prima y los kilos que va a
      // comprometer — no el producto terminado (que no existe hasta que planta lo rola) ni un
      // rollo concreto (que lo elige planta al montar, D-086). Antes de D-134 esto decía
      // `PRODUCT`: la cotización guardaba solo la intención y los kilos aparecían recién al
      // confirmar, así que el vendedor no veía el número contra el que se le iba a decir que
      // sí o que no.
      expect(quotation.items[0]).toMatchObject({
        reserveItemType: 'RAW_MATERIAL',
        reserveUnit: 'KGM',
        reserveQty: (Number(meters) * KG_PER_METER).toFixed(3),
      });
      expect(quotation.items[0]!.reserveItemId).not.toBe(product.id);

      const order = await emitAndConfirm(api, quotation.id);
      trail.orderIds.push(order.id);
      expect(order.status).toBe('CONFIRMED');
      // Y el pedido copia exactamente lo mismo: el agregado que la cotización ya nombraba.
      expect(order.items[0]).toMatchObject({
        reserveItemType: 'RAW_MATERIAL',
        reserveItemId: quotation.items[0]!.reserveItemId,
      });

      // Lo prometido son **kilos del agregado compatible**, no unidades de un producto
      // terminado ni el rollo que hoy los tiene.
      const reservations = await reservationsOf(api, order.id);
      expect(reservations).toHaveLength(1);
      const reservation = reservations[0]!;
      expect(reservation).toMatchObject({
        itemType: 'RAW_MATERIAL',
        itemId: quotation.items[0]!.reserveItemId,
        unit: 'KGM',
        status: 'ACTIVE',
      });
      expect(reservation.itemId, 'la promesa no nombra una bobina física').not.toBe(coil.id);
      expect(reservation.qty, '61 ml × 4.04 kg/ml (D-165)').toBe(
        (Number(meters) * KG_PER_METER).toFixed(3),
      );

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
  // 2 — La plancha también reserva materia prima (D-171 revirtió D-140)
  // -------------------------------------------------------------------------

  test('una plancha de catálogo sin saldo de producto terminado se confirma contra la bobina, y sin bobina no', async () => {
    /**
     * **Este caso afirmaba lo contrario hasta D-171.** Bajo D-140 la plancha se atendía con
     * stock de producto terminado y confirmarla sin saldo tenía que morir con «0.000 NIU
     * disponibles»; el dueño corrigió la premisa —una plancha no espera en el almacén, se rola
     * contra el pedido igual que una cobertura a medida— y ahora lo correcto es justo lo
     * opuesto: se confirma, reservando kilos del agregado.
     *
     * Lo que **no** se aflojó es la invariante de D-066: no se promete lo que no está. Por eso
     * el caso tiene las dos mitades. Cambió contra qué se mide (materia prima en vez de
     * producto terminado), no que se mida.
     */
    const supplier = await createCuttingSupplier(api);
    const finish = await createRoofingFinish(api);
    const color = await createColor(api);
    const customer = await createCustomer(api);
    // Plancha: largo fijo, unidad `NIU`. Se rola contra el pedido desde bobina, y lo que la
    // separa de una cobertura a medida es **cómo se cuenta**, no de dónde sale el material.
    const { product } = await createRoofingProduct(api, {
      finishId: finish.id,
      colorId: color.id,
      pieceLengthMm: '3000',
    });
    // La bobina del color y espesor correctos es ahora la premisa del caso, no su trampa: es
    // el material contra el que la plancha promete.
    const { coil, purchaseId } = await buyRoofingCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: color.id,
      weightKg: '2000',
    });
    const quotationIds: string[] = [];
    const orderIds: string[] = [];

    try {
      expect(product.unit).toBe('NIU');
      expect((product as ProductDto & { roofingKind: string }).roofingKind).toBe('PLANCHA');
      // Y el almacén está vacío de planchas: nunca se compró ni se roló ninguna.
      expect(await optionalBalanceOf(api, 'PRODUCT', product.id)).toBeNull();

      // (a) Sin una sola plancha en el almacén, se confirma. 10 × 3 m = 30 m × 4.04 kg/m.
      const quotation = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        issueDate: today(),
        items: [{ productId: product.id, qty: '10', unitPricePen: '80' }],
      });
      quotationIds.push(quotation.id);
      const order = await emitAndConfirm(api, quotation.id);
      orderIds.push(order.id);

      const reservations = await reservationsOf(api, order.id);
      expect(reservations).toHaveLength(1);
      expect(reservations[0]).toMatchObject({
        itemType: 'RAW_MATERIAL',
        qty: '121.200',
        unit: 'KGM',
        status: 'ACTIVE',
      });
      expect(reservations[0]!.itemId).not.toBe(product.id);

      // (b) Y lo que no está sigue sin poder prometerse: 1 000 planchas son 12 120 kg y del
      // agregado quedan 1 878.8. El rechazo nombra el agregado corto (color y espesor), no el
      // SKU — que es lo que D-134 cambió y D-171 no tocó.
      const tooMany = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        issueDate: today(),
        items: [{ productId: product.id, qty: '1000', unitPricePen: '80' }],
      });
      quotationIds.push(tooMany.id);
      const error = await emitAndConfirmExpectingError(api, tooMany.id);
      expect(error.status).toBe(400);
      expect(error.message.toLowerCase()).toMatch(/disponible|bobina/);
      expect(error.message).toContain(color.name);
    } finally {
      await purgeRoofingTrail(api, {
        orderIds,
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
  // 3 — Cambiar el subtipo cambia la forma de la línea, no de dónde sale el material
  // -------------------------------------------------------------------------

  test('cambiar un producto de plancha a a-medida cambia cómo se cuenta la línea, y las dos reservan materia prima', async () => {
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
      /**
       * **Lo que este caso afirmaba hasta D-171**: que como plancha, sin stock, no se
       * confirmaba, y que corregir el subtipo era lo que abría la venta. D-171 revirtió D-140 y
       * con eso las dos formas reservan materia prima, así que el subtipo dejó de decidir *de
       * dónde sale el material*. Sigue decidiendo lo otro —y es lo que ahora se compara—:
       * **cómo se cuenta la línea**. Una plancha va en `NIU` sin detalle de largos y sus metros
       * los pone el SKU; una cobertura a medida va en `MTR` con subítems y los trae la línea.
       */
      // (a) Como plancha, sin una sola en el almacén, **se confirma**: promete los kilos que
      // sus metros van a consumir. 10 planchas × 3 m = 30 m × 4.04 kg/m = 121.200 kg.
      const asPlancha = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        issueDate: today(),
        items: [{ productId: product.id, qty: '10', unitPricePen: '80' }],
      });
      trail.quotationIds.push(asPlancha.id);
      const sheetOrder = await emitAndConfirm(api, asPlancha.id);
      trail.orderIds.push(sheetOrder.id);

      const sheetLine = sheetOrder.items[0]!;
      expect(sheetLine.qty).toBe('10.000');
      expect(sheetLine.unit).toBe('NIU');
      // Línea simple: `sellsByLength` es la unidad, y esta no es `MTR` (regla dura 14).
      expect(sheetLine.pieces ?? []).toEqual([]);
      const sheetReservation = (await reservationsOf(api, sheetOrder.id))[0]!;
      expect(sheetReservation).toMatchObject({
        itemType: 'RAW_MATERIAL',
        unit: 'KGM',
        qty: (10 * 3 * KG_PER_METER).toFixed(3),
        status: 'ACTIVE',
      });

      // (b) Se corrige el subtipo. La unidad y el largo van con él: `A_MEDIDA` se mide en
      // `MTR` y tiene prohibido el largo fijo (lo traen los subítems de cada línea).
      const patched = await api.patch(`/api/catalog/${product.id}`, {
        data: { roofingKind: 'A_MEDIDA', unit: 'MTR', lengthMm: '' },
      });
      expect(patched.ok(), `PATCH catálogo falló: ${await patched.text()}`).toBe(true);
      const updated = (await patched.json()) as ProductDto & { roofingKind: string | null };
      expect(updated).toMatchObject({ roofingKind: 'A_MEDIDA', unit: 'MTR', lengthMm: null });

      // D-122: acá iba una reescritura de la receta. Ya no hay ninguna que reescribir — una
      // cobertura no lleva receta desde D-122, porque su acabado, su geometría y su color
      // son del propio producto, que es justo lo que el PATCH de arriba acaba de dejar
      // correcto. El API rechaza hoy un `PUT /production/boms/:id` con `kind: 'ROOFING'`.

      // (c) La misma venta, ahora contada de la otra forma: en metros y con el detalle de
      // largos. Reserva materia prima igual que la plancha; lo que cambia es de dónde salen
      // los metros —de la línea, no del largo del SKU— y la unidad de la cantidad.
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
      // D-134: el agregado compatible, no el rollo. Que la bobina exista sigue importando —
      // sin ella el agregado tendría cero kilos y esto no se confirmaría—, pero no es lo que
      // la promesa nombra.
      expect(reservations[0]).toMatchObject({
        itemType: 'RAW_MATERIAL',
        unit: 'KGM',
        qty: (Number(meters) * KG_PER_METER).toFixed(3),
        status: 'ACTIVE',
      });
      expect(reservations[0]!.itemId).not.toBe(coil.id);
      // Las dos promesas nombran **el mismo agregado**: es el mismo material, contado de dos
      // formas. Ahí se ve que el subtipo no decide de dónde sale.
      expect(reservations[0]!.itemId).toBe(sheetReservation.itemId);
      // Y la línea sí cambió de forma: metros con subítems, no planchas.
      expect(order.items[0]!.unit).toBe('MTR');
      expect(order.items[0]!.pieces).toHaveLength(REAL_CASE_ROWS.length);
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
      // D-134: la cotización nombra el agregado desde el primer momento, y el agregado
      // existe aunque no tenga una sola bobina detrás — su disponible es cero, que es
      // exactamente lo que hace falta decir.
      expect(quotation.items[0]!.reserveItemType).toBe('RAW_MATERIAL');

      // (b) Confirmarla sin material sí se cae, y con el mensaje que dice qué hacer.
      const blocked = await emitAndConfirmExpectingError(api, quotation.id);
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain('0.000 kg disponibles');
      expect(blocked.message).toContain('Compra o abre una bobina de ese color y espesor');

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
        itemType: 'RAW_MATERIAL',
        itemId: quotation.items[0]!.reserveItemId,
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
  // 5 — Lo que cuenta es el material vivo al confirmar, no el que había al cotizar
  //
  // D-134 retiró el mecanismo que este caso probaba: la reserva ya no elige un rollo, así
  // que "el pedido reserva la otra bobina" dejó de tener sentido. La regla de fondo sigue
  // viva y es la que importa —**lo que decide es el material disponible en el momento de
  // confirmar**— y acá se prueba en los dos sentidos, que es más fuerte que el caso que
  // reemplaza: cerrar la única bobina compatible deja el agregado en cero y la confirmación
  // se cae; comprar otra lo repone y la misma cotización, sin tocarla, se confirma.
  // -------------------------------------------------------------------------

  test('cerrar la única bobina compatible deja al agregado sin material, y comprar otra lo repone', async () => {
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

      // La primera bobina se cierra (RF-19): deja de contar para el agregado, igual que si
      // se hubiera consumido entera. Es lo que pasa de verdad entre cotizar y confirmar
      // cuando pasan días.
      // D-164: el caso mide que una bobina **cerrada** sale del agregado aunque conserve su
      // saldo, así que se declara el saldo entero. Liquidarlo probaría otra cosa —que el
      // agregado baja porque los kilos se fueron—, que es justo lo que este caso descarta.
      await closeCoilKeepingStock(
        api,
        first.coil.id,
        'La bobina se guarda para otra corrida (prueba E2E)',
      );

      // Sin material vivo, la misma cotización no se confirma: el agregado quedó en cero
      // aunque la bobina cerrada siga existiendo con su saldo.
      const blocked = await emitAndConfirmExpectingError(api, quotation.id);
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain('0.000 kg disponibles');

      const second = await buyRoofingCoil(api, {
        supplierId: supplier.id,
        finishId: finish.id,
        colorId: color.id,
        weightKg: '2000',
      });
      secondPurchaseId = second.purchaseId;
      trail.coilIds.push(second.coil.id);

      // Y con la bobina nueva, la misma cotización —sin tocarle una línea— se confirma. La
      // promesa nombra el agregado, así que el rollo que la cumple puede cambiar entre un
      // intento y el siguiente sin que la cotización se entere.
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
        {},
      );
      trail.orderIds.push(order.id);

      const reservations = await reservationsOf(api, order.id);
      expect(reservations).toHaveLength(1);
      expect(reservations[0]).toMatchObject({
        itemType: 'RAW_MATERIAL',
        unit: 'KGM',
        qty: (Number(meters) * KG_PER_METER).toFixed(3),
        status: 'ACTIVE',
      });
      expect(reservations[0]!.itemId).not.toBe(first.coil.id);
      expect(reservations[0]!.itemId).not.toBe(second.coil.id);
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
  // 6 — Dos líneas del mismo producto **suman** contra el mismo agregado
  //
  // El caso viejo probaba que cada línea eligiera una bobina distinta; con D-134 no hay
  // elección de bobina y las dos líneas prometen contra el **mismo** agregado. La regla que
  // de verdad protegía —dos líneas que por separado entran y sumadas no, no pueden dejar un
  // pedido prometiendo material que no existe— sigue viva y se prueba acá en los dos
  // sentidos: con dos bobinas alcanza y el pedido nace con las dos reservas sobre la misma
  // spec; con una sola, la confirmación se cae **entera** y no deja media promesa.
  // -------------------------------------------------------------------------

  test('dos líneas a medida del mismo producto suman contra el mismo agregado, y si no alcanza fallan las dos', async () => {
    const supplier = await createCuttingSupplier(api);
    const finish = await createRoofingFinish(api);
    const color = await createColor(api);
    const customer = await createCustomer(api);
    const { product } = await createRoofingProduct(api, {
      finishId: finish.id,
      colorId: color.id,
    });
    const meters = metersOf(REAL_CASE_ROWS);
    const neededKg = Number(meters) * KG_PER_METER; // 246.44 kg por línea (61 m × 4.04, D-165).
    // 300 kg: alcanza para **una** línea y no para las dos. Con la segunda bobina el
    // agregado llega a 600 y las dos entran.
    const first = await buyRoofingCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: color.id,
      weightKg: '300',
    });
    const orderIds: string[] = [];
    const quotationIds: string[] = [];
    let second: Awaited<ReturnType<typeof buyRoofingCoil>> | undefined;

    try {
      expect(neededKg).toBeLessThan(300);
      expect(neededKg * 2).toBeGreaterThan(300);

      // Vía cotización y no alta directa: una cobertura fabricada exige cotización
      // confirmada (RF-31).
      const twoLines = {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        issueDate: today(),
        items: [
          { productId: product.id, qty: meters, unitPricePen: '30', pieces: REAL_CASE_ROWS },
          { productId: product.id, qty: meters, unitPricePen: '30', pieces: REAL_CASE_ROWS },
        ],
      };

      // (a) Con una sola bobina de 300 kg, las dos líneas suman 488 y **el pedido entero se
      // cae**. Es la mitad que más importa: cada línea por separado entra, y si el agregado
      // no las sumara el pedido nacería prometiendo material que no existe.
      const short = await postJson<QuotationDto>(api, '/api/sales/quotations', twoLines);
      quotationIds.push(short.id);
      const blocked = await emitAndConfirmExpectingError(api, short.id);
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain('300.000');
      expect(blocked.message).toContain(neededKg.toFixed(3));

      // (b) Con la segunda bobina del **mismo** agregado, las mismas dos líneas entran.
      second = await buyRoofingCoil(api, {
        supplierId: supplier.id,
        finishId: finish.id,
        colorId: color.id,
        weightKg: '300',
      });
      const quotation = await postJson<QuotationDto>(api, '/api/sales/quotations', twoLines);
      quotationIds.push(quotation.id);
      const order = await emitAndConfirm(api, quotation.id);
      orderIds.push(order.id);

      const reservations = await reservationsOf(api, order.id);
      expect(reservations).toHaveLength(2);
      const specs = new Set(reservations.map((r) => r.itemId));
      expect(specs.size, 'las dos líneas prometen contra el mismo agregado').toBe(1);
      expect(specs.has(first.coil.id), 'y el agregado no es una bobina').toBe(false);
      for (const reservation of reservations) {
        expect(reservation).toMatchObject({
          itemType: 'RAW_MATERIAL',
          unit: 'KGM',
          qty: neededKg.toFixed(3),
          status: 'ACTIVE',
        });
      }
    } finally {
      await purgeRoofingTrail(api, {
        orderIds,
        quotationIds,
        coilIds: [first.coil.id, ...(second ? [second.coil.id] : [])],
        purchaseIds: [first.purchaseId, ...(second ? [second.purchaseId] : [])],
        productIds: [product.id],
        supplierId: supplier.id,
        finishId: finish.id,
        colorId: color.id,
      });
    }
  });
});
