import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  adminApi,
  createFinish,
  createSupplier,
  createUser,
  getItems,
  getJson,
  postJson,
} from '../helpers/api';
import {
  apiAs,
  createCatalogProduct,
  createCuttingSupplier,
  deactivateTrail,
  errorFrom,
  purgeProductionOrder,
  today,
  uniqueDocumentNumber,
  upsertBom,
  KG_PER_PIECE,
  LINE,
  type CoilDto,
  type CuttingOrderDto,
  type MovementDto,
  type ProductionOrderDto,
  type PurchaseDto,
} from '../helpers/production';
import {
  createCustomer,
  createDirectOrder,
  purgeSalesTrail,
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
  reservationsOf,
  ROOFING_LINE,
} from '../helpers/roofing';
import {
  dispatchBody,
  dispatchOrder,
  purgeInvoicingTrail,
  setupOrderScenario,
} from '../helpers/invoicing';
import {
  importCorrelative,
  importDocument,
  importSeriesCode,
  annulImportedTrail,
} from '../helpers/imports';

/**
 * Fase 7 consolidada — **fecha de operación** (D-124).
 *
 * Lo que estos tests protegen, en una línea: **el día de negocio de un hecho es un dato
 * propio, distinto del instante en que se tipeó**, y todo lo que se ordena, corta o reporta
 * por fecha lo hace por el primero.
 *
 * Por eso las aserciones no miran una pantalla nueva: miran el kardex de siempre, el
 * listado de comprobantes de siempre y el saldo de siempre. Si la fecha de operación
 * hubiera quedado como un campo decorativo al costado —guardado pero no usado para
 * ordenar ni para cortar—, ninguno de estos seis casos cerraría.
 *
 * Los seis casos son: (1) el flujo normal no cambia, (2) una carga histórica de agosto
 * entera, (3) el rol que no la puede tocar, (4) los dos topes, (5) el importado que cae en
 * su mes y (6) el guardrail cronológico y su confirmación.
 */

// El mes de la carga histórica. Es fijo y no "el mes pasado" a propósito: el piso
// configurable (`HISTORICAL_LOAD_START`, default 2026-08-01) hace que agosto de 2026 sea el
// único mes retrofechable de este proyecto, y una fecha calculada lo taparía el día que el
// piso se mueva.
const AUG = '2026-08';
const AUG_COIL_IN = '2026-08-03';
const AUG_CUTTING_SENT = '2026-08-05';
const AUG_CUTTING_RECEIVED = '2026-08-06';
const AUG_PRODUCTION_OPEN = '2026-08-10';
const AUG_PRODUCTION_REPORT = '2026-08-12';
const AUG_PRODUCTION_CLOSE = '2026-08-14';
const AUG_DISPATCH = '2026-08-20';
const AUG_INVOICE = '2026-08-11';

/** Un movimiento de kardex tal como lo devuelve el API, ya con la fecha de operación (D-124). */
interface DatedMovement extends MovementDto {
  at: string;
  operationDate: string;
}

interface CoilReportRow {
  id: string;
  code: string;
  openingKg: string;
  weightKg: string;
  closingKg: string;
  unitCostPerKg: string | null;
  operationDate: string;
}

interface CoilMonthReport {
  month: string;
  from: string;
  to: string;
  rows: CoilReportRow[];
  totals: { openingKg: string; weightKg: string; closingKg: string };
}

function coilReport(api: APIRequestContext, month: string): Promise<CoilMonthReport> {
  return getJson<CoilMonthReport>(api, `/api/reports/coils?month=${month}`);
}

/** Kardex de un ítem, tal cual lo devuelve el API (más reciente primero) — sin reordenar. */
function kardexOf(
  api: APIRequestContext,
  itemType: 'COIL' | 'PRODUCT',
  itemId: string,
  range: { from?: string; to?: string } = {},
): Promise<DatedMovement[]> {
  const qs = [
    `itemType=${itemType}`,
    `itemId=${itemId}`,
    ...(range.from ? [`from=${range.from}`] : []),
    ...(range.to ? [`to=${range.to}`] : []),
  ].join('&');
  return getItems<DatedMovement>(api, `/api/inventory/movements?${qs}`);
}

/** Compra de bobina en la línea de drywall, sin recibir. Devuelve el id de la compra. */
async function buyCoil(
  api: APIRequestContext,
  input: { supplierId: string; finishId: string; weightKg: string; issueDate?: string },
): Promise<string> {
  const purchase = await postJson<PurchaseDto>(api, '/api/purchases', {
    supplierId: input.supplierId,
    businessLine: LINE,
    type: 'COIL',
    docType: 'FACTURA',
    series: 'F001',
    number: uniqueDocumentNumber(),
    issueDate: input.issueDate ?? today(),
    currency: 'PEN',
    igvRate: '18',
    paymentTerms: 'CONTADO',
    items: [
      {
        description: 'Bobina E2E D-124',
        qty: input.weightKg,
        unit: 'KGM',
        unitPrice: '4',
        finishId: input.finishId,
        widthMm: '1200',
        thicknessMm: '0.50',
        coilStatus: 'OPEN',
      },
    ],
  });
  return purchase.id;
}

/** La bobina que dejó esa compra. */
async function coilOfPurchase(
  api: APIRequestContext,
  supplierId: string,
  purchaseId: string,
): Promise<CoilDto> {
  const coils = await getItems<CoilDto>(api, `/api/coils?supplierId=${supplierId}`);
  const coil = coils.find((c) => c.purchaseId === purchaseId);
  expect(coil, 'la compra no dejó ninguna bobina').toBeDefined();
  return coil!;
}

test.describe('D-124 — fecha de operación', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
    // Toda la carga histórica de esta suite se fecha en agosto de 2026. Si el reloj de la
    // máquina cae dentro de ese mes, esas fechas serían futuras y el API las rechazaría con
    // razón: el test lo dice acá, en vez de fallar más abajo con un 400 que parece un
    // defecto de la implementación.
    expect(
      today() >= '2026-09-01',
      `Esta suite retrofecha a ${AUG} y hoy es ${today()}: solo corre con el reloj en septiembre de 2026 o después`,
    ).toBe(true);
  });

  // La carga histórica completa arma compra, corte tercerizado, OP y despacho: son ocho
  // escrituras encadenadas contra Neon y el timeout de 45 s no alcanza.
  test.describe.configure({ timeout: 180_000 });

  // -------------------------------------------------------------------------
  // 1 — Regresión: sin el campo, nada cambia
  // -------------------------------------------------------------------------

  test('sin mandar fecha de operación, una recepción normal queda fechada hoy en Lima (regresión)', async () => {
    const supplier = await createCuttingSupplier(api);
    const finish = await createFinish(api);
    const purchaseId = await buyCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      weightKg: '800',
    });

    try {
      // El cuerpo va vacío a propósito: es exactamente lo que manda el formulario de todos
      // los días, y D-124 no puede haberle cambiado nada.
      await postJson<PurchaseDto>(api, `/api/purchases/${purchaseId}/receive`);
      const coil = await coilOfPurchase(api, supplier.id, purchaseId);

      expect(coil.operationDate, 'la bobina nace fechada hoy').toBe(today());

      const movements = await kardexOf(api, 'COIL', coil.id);
      expect(movements).toHaveLength(1);
      const entry = movements[0]!;
      expect(entry.type).toBe('IN');
      expect(entry.operationDate).toBe(today());
      // `at` es el instante de grabación y sigue existiendo: en una operación del día las
      // dos fechas coinciden, y es justamente eso lo que hace que el flujo normal no cambie.
      // Se mide como antigüedad y no como fecha: `at` viaja en UTC y Lima va cinco horas
      // detrás, así que compararlo con `today()` falla de noche por el huso.
      expect((Date.now() - Date.parse(entry.at)) / 3_600_000).toBeLessThan(12);

      // El reporte mensual del mes en curso la ubica sola, sin pasarle `month`.
      const report = await coilReport(api, today().slice(0, 7));
      const row = report.rows.find((r) => r.id === coil.id);
      expect(row, 'la bobina de hoy sale en el reporte del mes en curso').toBeDefined();
      expect(row!.operationDate).toBe(today());
      expect(row!.openingKg).toBe('0.000');
      expect(row!.closingKg).toBe('800.000');
    } finally {
      await deactivateTrail(api, {
        purchaseId,
        supplierId: supplier.id,
        finish,
      });
    }
  });

  // -------------------------------------------------------------------------
  // 2 — Carga histórica de agosto, en orden cronológico
  // -------------------------------------------------------------------------

  test('un administrador carga agosto entero (bobina → corte → OP → despacho) y el mes lo refleja', async () => {
    const supplier = await createCuttingSupplier(api);
    const finish = await createFinish(api);
    const customer = await createCustomer(api);
    const purchaseId = await buyCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      weightKg: '4800',
      issueDate: AUG_COIL_IN,
    });
    const trail: {
      productionOrderIds: string[];
      orderIds: string[];
      dispatchIds: string[];
      productId?: string;
      cuttingOrderId?: string;
      motherId?: string;
    } = { productionOrderIds: [], orderIds: [], dispatchIds: [] };

    try {
      // (a) La bobina entra el 3 de agosto.
      await postJson<PurchaseDto>(api, `/api/purchases/${purchaseId}/receive`, {
        operationDate: AUG_COIL_IN,
      });
      const mother = await coilOfPurchase(api, supplier.id, purchaseId);
      trail.motherId = mother.id;
      expect(mother.operationDate).toBe(AUG_COIL_IN);

      // (b) Sale a corte el 5 y vuelve partida en dos flejes el 6.
      const cutting = await postJson<CuttingOrderDto & { operationDate: string }>(
        api,
        '/api/cutting',
        {
          supplierId: supplier.id,
          notes: 'Corte E2E de carga histórica',
          operationDate: AUG_CUTTING_SENT,
          coils: [
            {
              coilId: mother.id,
              widthPlanMm: [{ widthMm: '600', stripsCount: 2 }],
              expectedKerfLossMm: '0',
            },
          ],
        },
      );
      trail.cuttingOrderId = cutting.id;
      expect(cutting.operationDate).toBe(AUG_CUTTING_SENT);

      const received = await postJson<CuttingOrderDto>(
        api,
        `/api/cutting/${cutting.id}/coils/${mother.id}/receive`,
        {
          receivedWidthsMm: [{ widthMm: '600', stripsCount: 2 }],
          receivedWeightKg: '4800',
          kerfLossMm: '0',
          operationDate: AUG_CUTTING_RECEIVED,
        },
      );
      const stripRefs = received.coils.find((c) => c.coilId === mother.id)!.strips;
      expect(stripRefs).toHaveLength(2);
      const strips = await Promise.all(
        stripRefs.map((ref) => getJson<CoilDto>(api, `/api/coils/${ref.id}`)),
      );
      for (const strip of strips) {
        expect(strip.operationDate, 'el fleje nace el día en que se recibió el corte').toBe(
          AUG_CUTTING_RECEIVED,
        );
      }

      // (c) Una OP abierta el 10, con 100 piezas reportadas el 12 y cerrada el 14.
      const product = await createCatalogProduct(api);
      trail.productId = product.id;
      await upsertBom(api, product.id, { finishId: finish.id, kgPerPiece: KG_PER_PIECE });

      const order = await postJson<ProductionOrderDto & { operationDate: string }>(
        api,
        '/api/production',
        { productId: product.id, operationDate: AUG_PRODUCTION_OPEN },
      );
      trail.productionOrderIds.push(order.id);
      expect(order.operationDate).toBe(AUG_PRODUCTION_OPEN);
      await postJson(api, `/api/production/${order.id}/consume`, { coilId: strips[0]!.id });
      await postJson(api, `/api/production/${order.id}/report`, {
        pieces: 100,
        operationDate: AUG_PRODUCTION_REPORT,
      });
      // El cierre lleva motivo porque deja merma: se montaron 2 400 kg y solo se
      // consumieron 200 (100 piezas × 2 kg). El guardrail de merma alta es de Fase 4 y no
      // tiene nada que ver con D-124; acá simplemente se le da lo que pide.
      const closed = await postJson<ProductionOrderDto & { closedOperationDate: string | null }>(
        api,
        `/api/production/${order.id}/close`,
        {
          operationDate: AUG_PRODUCTION_CLOSE,
          reason: 'Cierre de la corrida histórica E2E: el resto del fleje vuelve a almacén',
        },
      );
      expect(closed.closedOperationDate).toBe(AUG_PRODUCTION_CLOSE);
      expect(closed.reports[0]).toMatchObject({ operationDate: AUG_PRODUCTION_REPORT });

      // (d) Se despachan 20 de esas piezas el 20 de agosto.
      const sale = await createDirectOrder(api, {
        customerId: customer.id,
        businessLine: LINE,
        items: [{ productId: product.id, qty: '20', unitPricePen: '10' }],
      });
      trail.orderIds.push(sale.id);
      const dispatch = await dispatchOrder(api, {
        salesOrderId: sale.id,
        items: [{ salesOrderItemId: sale.items[0]!.id, qty: '20', weightKg: '40' }],
        dispatchDate: AUG_DISPATCH,
      });
      trail.dispatchIds.push(dispatch.id);
      expect(dispatch.dispatchDate).toBe(AUG_DISPATCH);

      // ---- Lo que el mes tiene que mostrar -------------------------------

      const august = await coilReport(api, AUG);
      expect(august.from).toBe('2026-08-01');
      expect(august.to).toBe('2026-08-31');
      const augustIds = august.rows.map((r) => r.id);
      expect(augustIds, 'la bobina madre de agosto sale en agosto').toContain(mother.id);
      expect(augustIds, 'los flejes de agosto salen en agosto').toContain(strips[0]!.id);
      expect(augustIds).toContain(strips[1]!.id);

      // El fleje que nadie tocó: nace en agosto (apertura en cero) y cierra con sus 2 400 kg.
      const idleAugust = august.rows.find((r) => r.id === strips[1]!.id)!;
      expect(idleAugust).toMatchObject({
        openingKg: '0.000',
        weightKg: '2400.000',
        closingKg: '2400.000',
        operationDate: AUG_CUTTING_RECEIVED,
      });
      // La madre entró y salió entera dentro del mes: apertura y cierre en cero, y el peso
      // nominal con el que se dio de alta intacto (RF-13: no cambia con los consumos).
      expect(august.rows.find((r) => r.id === mother.id)).toMatchObject({
        openingKg: '0.000',
        weightKg: '4800.000',
        closingKg: '0.000',
        operationDate: AUG_COIL_IN,
      });

      // Julio no las ve: son anteriores al mes en que existen.
      const july = await coilReport(api, '2026-07');
      const julyIds = july.rows.map((r) => r.id);
      expect(julyIds).not.toContain(mother.id);
      expect(julyIds).not.toContain(strips[0]!.id);

      // Septiembre sí, y con el saldo de apertura correcto: lo comprado en agosto es
      // **saldo inicial** de septiembre. Es la columna que no se podía calcular antes de
      // D-124, porque sin fecha de operación no había con qué cortar el kardex por mes.
      const september = await coilReport(api, '2026-09');
      const idleSeptember = september.rows.find((r) => r.id === strips[1]!.id);
      expect(idleSeptember, 'el fleje de agosto sigue siendo saldo de septiembre').toBeDefined();
      expect(idleSeptember!.openingKg).toBe(idleAugust.closingKg);
      expect(idleSeptember!.openingKg).toBe('2400.000');

      // ---- El kardex ordena y corta por fecha de operación ----------------

      const productKardex = await kardexOf(api, 'PRODUCT', product.id);
      const dates = productKardex.map((m) => m.operationDate);
      // El API devuelve el más reciente primero: la lista tiene que venir no creciente.
      expect([...dates].sort().reverse()).toEqual(dates);
      expect(dates).toContain(AUG_PRODUCTION_REPORT);
      expect(dates).toContain(AUG_DISPATCH);
      // Y todos se acaban de grabar: es la diferencia entera entre `at` y `operationDate`.
      // Se compara contra el reloj y no contra `today()`: `at` es un instante **UTC**, que
      // desde las 19:00 de Lima ya cae en el día siguiente (la misma trampa que documenta
      // `today()` en helpers/production). Una corrida larga de noche cruzaba esa medianoche
      // y el test fallaba por el huso, no por la fecha de operación.
      for (const movement of productKardex) {
        const ageHours = (Date.now() - Date.parse(movement.at)) / 3_600_000;
        expect(
          ageHours,
          'el movimiento se grabó recién, aunque su fecha de negocio sea agosto',
        ).toBeLessThan(12);
        expect(movement.operationDate.startsWith(AUG)).toBe(true);
      }

      const inAugust = await kardexOf(api, 'PRODUCT', product.id, {
        from: '2026-08-01',
        to: '2026-08-31',
      });
      expect(
        inAugust.length,
        'el filtro desde/hasta corta por día de negocio, no por el instante de grabación',
      ).toBe(productKardex.length);

      const inSeptember = await kardexOf(api, 'PRODUCT', product.id, { from: '2026-09-01' });
      expect(
        inSeptember,
        'nada de lo cargado como agosto puede aparecer en el corte de septiembre',
      ).toHaveLength(0);
    } finally {
      await purgeInvoicingTrail(api, {
        dispatchIds: trail.dispatchIds,
        orderIds: trail.orderIds,
      });
      await purgeSalesTrail(api, { orderIds: trail.orderIds });
      for (const orderId of trail.productionOrderIds) {
        await purgeProductionOrder(api, orderId).catch(() => undefined);
      }
      await deactivateTrail(api, {
        cuttingOrderId: trail.cuttingOrderId,
        motherId: trail.motherId,
        purchaseId,
        supplierId: supplier.id,
        finish,
        productId: trail.productId,
      });
    }
  });

  // -------------------------------------------------------------------------
  // 3 — Quién la puede tocar
  // -------------------------------------------------------------------------

  test('un vendedor que manda una fecha de operación distinta de hoy recibe 403, y con la de hoy pasa', async ({
    baseURL,
  }) => {
    // El despacho es la operación retrofechable que un VENDEDOR **sí** puede hacer (RF-77):
    // es la única forma de comprobar que el 403 lo pone D-124 y no el guardia de la ruta.
    // Sobre `POST /purchases/:id/receive`, por ejemplo, un vendedor recibe un 403 genérico
    // sin haber llegado nunca a la validación de la fecha, y el test pasaría por vacío.
    const sc = await setupOrderScenario(api, { coilKg: '500', qty: '50' });
    const seller = await createUser(api, 'VENDEDOR');
    const sellerApi = await apiAs(baseURL!, seller);
    const supervisor = await createUser(api, 'SUPERVISOR_PLANTA');
    const supervisorApi = await apiAs(baseURL!, supervisor);
    const supplier = await createCuttingSupplier(api);
    const finish = await createFinish(api);
    const purchaseId = await buyCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      weightKg: '300',
      issueDate: AUG_COIL_IN,
    });
    const dispatchIds: string[] = [];

    const dispatchAs = (dispatchDate: string) =>
      dispatchBody({
        salesOrderId: sc.order.id,
        items: [{ salesOrderItemId: sc.item.id, qty: '10', weightKg: '10' }],
        totalWeightKg: '10',
        dispatchDate,
      });

    try {
      // (a) Retrofechado: 403 con el motivo real.
      const error = await errorFrom(
        await sellerApi.post('/api/dispatches', { data: dispatchAs(AUG_DISPATCH) }),
        'despacho retrofechado por un vendedor',
      );
      expect(error.status).toBe(403);
      expect(error.message).toContain('Solo un administrador puede cambiar la fecha de operación');

      // (b) El mismo despacho con la fecha de hoy pasa: lo que le falta al vendedor es el
      // permiso de **la fecha**, no el de despachar. Sin esta mitad, el caso anterior no
      // distingue "no puede retrofechar" de "no puede despachar".
      const ok = await postJson<{ id: string; dispatchDate: string }>(
        sellerApi,
        '/api/dispatches',
        dispatchAs(today()),
      );
      dispatchIds.push(ok.id);
      expect(ok.dispatchDate).toBe(today());

      // (c) Y no es solo el vendedor: un supervisor de planta, que sí puede recibir una
      // compra, se topa con el mismo 403 al retrofecharla y la recibe sin problema sin la
      // fecha. La regla es del rol ADMINISTRADOR, no de la ruta.
      const supervisorError = await errorFrom(
        await supervisorApi.post(`/api/purchases/${purchaseId}/receive`, {
          data: { operationDate: AUG_COIL_IN },
        }),
        'recepción retrofechada por un supervisor de planta',
      );
      expect(supervisorError.status).toBe(403);
      expect(supervisorError.message).toContain(
        'Solo un administrador puede cambiar la fecha de operación',
      );
      // El 403 no dejó media recepción hecha.
      expect((await getJson<PurchaseDto>(api, `/api/purchases/${purchaseId}`)).status).not.toBe(
        'RECEIVED',
      );
      await postJson<PurchaseDto>(supervisorApi, `/api/purchases/${purchaseId}/receive`);
      expect((await coilOfPurchase(api, supplier.id, purchaseId)).operationDate).toBe(today());
    } finally {
      await sellerApi.dispose();
      await supervisorApi.dispose();
      await purgeInvoicingTrail(api, {
        dispatchIds,
        orderIds: [sc.order.id],
        coilIds: [sc.coil.id],
        purchaseId: sc.purchaseId,
        supplierId: sc.supplier.id,
        finish: sc.finish,
        productIds: [sc.product.id],
      });
      await deactivateTrail(api, { purchaseId, supplierId: supplier.id, finish });
    }
  });

  // -------------------------------------------------------------------------
  // 4 — Los dos topes
  // -------------------------------------------------------------------------

  test('la fecha futura y la anterior al inicio de la carga histórica se rechazan con 400', async () => {
    const supplier = await createCuttingSupplier(api);
    const finish = await createFinish(api);
    const purchaseId = await buyCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      weightKg: '300',
    });

    try {
      const future = new Date(`${today()}T00:00:00.000Z`);
      future.setUTCDate(future.getUTCDate() + 1);
      const futureDate = future.toISOString().slice(0, 10);

      const futureError = await errorFrom(
        await api.post(`/api/purchases/${purchaseId}/receive`, {
          data: { operationDate: futureDate },
        }),
        'recepción fechada mañana',
      );
      expect(futureError.status).toBe(400);
      expect(futureError.message).toContain('no puede ser futura');

      const oldError = await errorFrom(
        await api.post(`/api/purchases/${purchaseId}/receive`, {
          data: { operationDate: '2026-07-31' },
        }),
        'recepción fechada antes del piso histórico',
      );
      expect(oldError.status).toBe(400);
      expect(oldError.message).toContain('2026-08-01');

      // Un día que no existe en el calendario tampoco entra. `2026-02-31` es el caso
      // peligroso: el formato es válido y, sin la comprobación, rodaba en silencio al 2 de
      // marzo — el movimiento terminaba fechado en un mes que nadie escribió.
      for (const impossible of ['2026-02-31', '2026-09-31']) {
        const res = await api.post(`/api/purchases/${purchaseId}/receive`, {
          data: { operationDate: impossible },
        });
        expect(res.status(), `recepción fechada el ${impossible}`).toBe(400);
      }

      // Y el borde inferior exacto sí entra: 2026-08-01 es el primer día admitido, no el
      // primero rechazado. Sin esta línea, un `<` cambiado por `<=` pasaría inadvertido.
      await postJson<PurchaseDto>(api, `/api/purchases/${purchaseId}/receive`, {
        operationDate: '2026-08-01',
      });
      const coil = await coilOfPurchase(api, supplier.id, purchaseId);
      expect(coil.operationDate).toBe('2026-08-01');
    } finally {
      await deactivateTrail(api, { purchaseId, supplierId: supplier.id, finish });
    }
  });

  test('un día por encima de 31 se rechaza con 400 y no revienta el servidor', async () => {
    const supplier = await createCuttingSupplier(api);
    const finish = await createFinish(api);
    const purchaseId = await buyCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      weightKg: '300',
    });

    try {
      // Va en un test aparte del resto de las validaciones a propósito: `2026-02-31` y
      // `2026-09-31` (día que ese mes no tiene) se rechazan bien, pero un día **fuera del
      // rango 1-31** —o un mes fuera de 1-12— sigue cayendo por otro camino. Aislado, el
      // rojo señala exactamente el caso que falta y no ensucia el de los dos topes.
      for (const impossible of ['2026-08-32', '2026-13-01', '2026-00-10']) {
        const res = await api.post(`/api/purchases/${purchaseId}/receive`, {
          data: { operationDate: impossible },
        });
        expect(res.status(), `recepción fechada el ${impossible}`).toBe(400);
      }
    } finally {
      await deactivateTrail(api, { purchaseId, supplierId: supplier.id, finish });
    }
  });

  // -------------------------------------------------------------------------
  // 5 — El importado cae en el mes de su emisión
  // -------------------------------------------------------------------------

  test('un comprobante importado con fecha de emisión de agosto cae en agosto y el listado ordena por ella', async () => {
    const customer = await createCustomer(api);
    const documentIds: string[] = [];

    try {
      // Se importa **primero** el de agosto y después el de hoy: si el listado ordenara por
      // el instante de creación (lo que hacía antes de D-124), el de agosto saldría segundo
      // por accidente y el test pasaría sin probar nada. Al invertir el orden de carga, la
      // única forma de que el de hoy salga primero es que ordene por `issueDate`.
      const old = await importDocument(api, {
        series: importSeriesCode(),
        correlative: importCorrelative(),
        customerDocNumber: customer.docNumber,
        issueDate: AUG_INVOICE,
        totalPen: '236.00',
        lines: [{ description: 'E2E factura de agosto', qty: '2', unitPricePen: '100.00' }],
      });
      documentIds.push(old.documentId);

      const recent = await importDocument(api, {
        series: importSeriesCode(),
        correlative: importCorrelative(),
        customerDocNumber: customer.docNumber,
        issueDate: today(),
        totalPen: '118.00',
        lines: [{ description: 'E2E factura de hoy', qty: '1', unitPricePen: '100.00' }],
      });
      documentIds.push(recent.documentId);

      const listed = await getItems<{ id: string; issueDate: string }>(
        api,
        `/api/invoicing/documents?customerId=${customer.id}`,
      );
      const ours = listed.filter((d) => documentIds.includes(d.id));
      expect(ours).toHaveLength(2);
      expect(
        ours.map((d) => d.id),
        'el listado ordena por fecha de emisión descendente, no por cuándo se importó',
      ).toEqual([recent.documentId, old.documentId]);

      // El de agosto conserva la fecha del papel: es lo que lo ubica en el mes de agosto y
      // no en el de la importación.
      const august = ours.find((d) => d.id === old.documentId)!;
      expect(august.issueDate.slice(0, 10)).toBe(AUG_INVOICE);
    } finally {
      await annulImportedTrail(api, documentIds);
    }
  });

  // -------------------------------------------------------------------------
  // 6 — El guardrail cronológico
  // -------------------------------------------------------------------------

  test('retrofechar por detrás de movimientos que el ítem ya tiene se corta con BACKDATE_OUT_OF_ORDER y se reintenta confirmando', async () => {
    const supplier = await createSupplier(api, { name: 'E2E Proveedor retrofecha' });
    const product = await createCatalogProduct(api, { source: 'PURCHASED' });
    const purchases: string[] = [];

    const buyFinishedGood = async (qty: string, issueDate: string): Promise<string> => {
      const purchase = await postJson<PurchaseDto>(api, '/api/purchases', {
        supplierId: supplier.id,
        businessLine: LINE,
        type: 'FINISHED_GOOD',
        docType: 'FACTURA',
        series: 'F001',
        number: uniqueDocumentNumber(),
        issueDate,
        currency: 'PEN',
        igvRate: '18',
        paymentTerms: 'CONTADO',
        items: [
          {
            productId: product.id,
            description: 'Producto E2E para el guardrail de retrofecha',
            qty,
            unit: 'NIU',
            unitPrice: '10',
          },
        ],
      });
      purchases.push(purchase.id);
      return purchase.id;
    };

    try {
      // (a) Un movimiento de HOY sobre el producto.
      const todayPurchase = await buyFinishedGood('10', today());
      await postJson<PurchaseDto>(api, `/api/purchases/${todayPurchase}/receive`);

      // (b) Ahora se intenta meter uno de agosto POR DETRÁS. El API corta.
      const backdated = await buyFinishedGood('5', AUG_COIL_IN);
      const res = await api.post(`/api/purchases/${backdated}/receive`, {
        data: { operationDate: AUG_COIL_IN },
      });
      expect(res.status(), 'la retrofecha fuera de orden se corta con 400').toBe(400);
      const body = (await res.json()) as { code?: string; message?: string };
      // El código viaja en el cuerpo justamente para que el web sepa que **esta** falla se
      // puede reintentar confirmando, sin tener que reconocer el texto del mensaje.
      expect(body.code).toBe('BACKDATE_OUT_OF_ORDER');
      expect(body.message).toContain(today());

      // Y no dejó nada a medias: la compra sigue sin recibir y el saldo es el de (a).
      const stillPending = await getJson<PurchaseDto>(api, `/api/purchases/${backdated}`);
      expect(stillPending.status).not.toBe('RECEIVED');
      expect((await kardexOf(api, 'PRODUCT', product.id)).length).toBe(1);

      // (c) Reintento acusando el aviso: pasa.
      await postJson<PurchaseDto>(api, `/api/purchases/${backdated}/receive`, {
        operationDate: AUG_COIL_IN,
        confirmBackdate: true,
      });

      const movements = await kardexOf(api, 'PRODUCT', product.id);
      expect(movements).toHaveLength(2);
      // El kardex los muestra en orden de **fecha de operación** (más reciente primero), que
      // es el inverso del orden en que se grabaron: el de agosto quedó por debajo del de hoy
      // aunque se haya tipeado después.
      expect(movements.map((m) => m.operationDate)).toEqual([today(), AUG_COIL_IN]);
      expect(Number(movements[0]!.id)).toBeLessThan(Number(movements[1]!.id));
    } finally {
      for (const purchaseId of [...purchases].reverse()) {
        await api
          .post(`/api/purchases/${purchaseId}/cancel`, {
            data: { reason: 'Limpieza de prueba E2E' },
          })
          .catch(() => undefined);
      }
      await deactivateTrail(api, { supplierId: supplier.id, productId: product.id });
    }
  });

  // -------------------------------------------------------------------------
  // 7 — El reporte de coberturas fecha los DOS lados del movimiento
  // -------------------------------------------------------------------------

  test('un reporte de coberturas retrofechado fecha con la misma fecha la salida de bobina y la entrada de producto', async () => {
    const supplier = await createCuttingSupplier(api);
    const finish = await createRoofingFinish(api);
    const color = await createColor(api);
    const customer = await createCustomer(api);
    const { product } = await createRoofingProduct(api, {
      finishId: finish.id,
      colorId: color.id,
    });
    // La bobina también entra en agosto: un consumo retrofechado sobre material que entró
    // hoy chocaría —con razón— contra el guardrail cronológico, y el test estaría probando
    // el guardrail en vez de la fecha del reporte.
    const { coil, purchaseId } = await buyRoofingCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: color.id,
      weightKg: '2000',
      operationDate: AUG_COIL_IN,
    });
    // 2 planchas de 5 m + 2 de 6 m = 22 m; a 4 kg/m, 88 kg de bobina.
    const rows = pieces([5, 2], [6, 2]);
    const meters = metersOf(rows);
    const trail: { orderIds: string[]; quotationIds: string[]; productionOrderIds: string[] } = {
      orderIds: [],
      quotationIds: [],
      productionOrderIds: [],
    };

    try {
      // Una cobertura fabricada solo se vende con cotización confirmada (RF-31).
      const quotation = await postJson<{ id: string }>(api, '/api/sales/quotations', {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        issueDate: today(),
        items: [{ productId: product.id, qty: meters, unitPricePen: '30', pieces: rows }],
      });
      trail.quotationIds.push(quotation.id);
      await postJson(api, `/api/sales/quotations/${quotation.id}/emit`);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
        {},
      );
      trail.orderIds.push(order.id);
      const reservation = (await reservationsOf(api, order.id))[0]!;
      expect(reservation.itemId).toBe(coil.id);

      const op = await postJson<{ id: string; operationDate: string }>(
        api,
        '/api/production/roofing',
        {
          reservationId: reservation.id,
          operationDate: AUG_PRODUCTION_OPEN,
        },
      );
      expect(op.operationDate, 'la OP se abre en la fecha que se le pasó').toBe(
        AUG_PRODUCTION_OPEN,
      );
      trail.productionOrderIds.push(op.id);
      await postJson(api, `/api/production/roofing/${op.id}/coils`, { coilId: coil.id });

      await postJson(api, `/api/production/roofing/${op.id}/report`, {
        pieces: rows,
        operationDate: AUG_PRODUCTION_REPORT,
      });

      // **Los dos lados del mismo hecho.** Rolar es una salida de bobina y una entrada de
      // producto en el mismo instante: si la salida quedara fechada en agosto y la entrada
      // hoy, el kardex de agosto mostraría material desaparecido y el de septiembre
      // producto aparecido de la nada.
      const coilKardex = await kardexOf(api, 'COIL', coil.id);
      const productKardex = await kardexOf(api, 'PRODUCT', product.id);
      const coilOut = coilKardex.find((m) => m.type === 'OUT');
      expect(coilOut, 'el reporte descuenta kilos de la bobina').toBeDefined();
      expect(coilOut!.operationDate).toBe(AUG_PRODUCTION_REPORT);
      expect(coilOut!.qty).toBe('88.000');

      const productIn = productKardex.find((m) => m.type === 'IN');
      expect(productIn, 'el reporte da de alta los metros fabricados').toBeDefined();
      expect(productIn!.operationDate).toBe(AUG_PRODUCTION_REPORT);
      expect(productIn!.operationDate).toBe(coilOut!.operationDate);
      expect(productIn!.qty).toBe(meters);
    } finally {
      for (const opId of [...trail.productionOrderIds].reverse()) {
        await purgeRoofingOrder(api, opId).catch(() => undefined);
      }
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
});
