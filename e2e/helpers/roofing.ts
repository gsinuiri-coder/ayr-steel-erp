import { expect, type APIRequestContext } from '@playwright/test';
import {
  createFinish,
  getItems,
  getJson,
  postJson,
  type CreatedFinish,
  type CreatedSupplier,
} from './api';
import {
  businessLineId,
  createCuttingSupplier,
  randomLetters,
  today,
  uniqueDocumentNumber,
  type CoilDto,
  type ProductDto,
  type ProductionOrderDto,
  type PurchaseDto,
} from './production';
import type { QuotationDto, SalesOrderDto } from './sales';

/**
 * Utilidades de la Fase 6 (producción de coberturas metálicas y color; D-082..D-091).
 *
 * Viven acá y no dentro de un spec para que `fase6.spec.ts` (ciclo completo) y
 * `fase6-bordes.spec.ts` (filtro, guardrails y reversas) armen exactamente el mismo
 * escenario y lo deshagan de la misma forma — mismo criterio que `production.ts` en Fase 4.
 *
 * **Los números están elegidos para que la aritmética se pueda comprobar a ojo:** una bobina
 * de 1 000 mm × 0.50 mm con un acabado de densidad 8.0 da exactamente 4 kg por metro de
 * geometría pura (`1000 × 0.5 × 1000 × 8 / 1e6`).
 *
 * **D-165 cambió lo que se consume, no la geometría.** El 1 % de merma normal vive dentro de
 * la densidad estándar, así que el kilo que de verdad sale de la bobina por metro es
 * `4 × 1.01 = 4.04` ({@link KG_PER_METER}), y por eso los kilos esperados de estos escenarios
 * dejaron de ser redondos: 61 m son 246.44 kg y no 244. Los específicos que siguen escritos
 * como literal llevan al lado el número geométrico del que salen.
 */

export const ROOFING_LINE = 'metallic-roofing';
export const UPVC_LINE = 'roofing';

/** Densidad del acabado de prueba: deja la geometría en un número redondo. */
export const TEST_DENSITY = '8.0000';
/** Espesor nominal del producto y de la bobina que sí sirve. */
export const NOMINAL_THICKNESS = '0.50';
/** Ancho de la bobina de prueba: con la densidad de arriba, 4 kg por metro de geometría. */
export const COIL_WIDTH = '1000';
/**
 * D-165: la merma normal que la densidad estándar absorbe. Vive acá y no como un `1.01`
 * repetido para que revisar el porcentaje —que es el pendiente escrito de D-165— sea cambiar
 * un número y correr la suite, no buscar decimales por los fixtures.
 */
export const NORMAL_SCRAP_FACTOR = 1.01;
/** Kilos de bobina que consume un metro lineal de la geometría de prueba, con D-165 adentro. */
export const KG_PER_METER = 4 * NORMAL_SCRAP_FACTOR;

export interface ColorDto {
  id: string;
  code: string;
  name: string;
  hexColor: string;
  isActive: boolean;
}

export interface RoofingCoilOptionDto {
  coilId: string;
  code: string;
  colorId: string | null;
  widthMm: string;
  thicknessMm: string;
  availableKg: string;
  estimatedMeters: string;
}

export interface ReservationRow {
  id: string;
  salesOrderItemId: string;
  /** D-134: una cobertura a medida reserva `RAW_MATERIAL` (el agregado), no una bobina. */
  itemType: 'COIL' | 'PRODUCT' | 'RAW_MATERIAL';
  itemId: string;
  qty: string;
  unit: string;
  status: string;
  /** D-084: la OP viva que nace de esta reserva, si ya existe. */
  productionOrderId: string | null;
  productionOrderCode: string | null;
}

/**
 * Correlativo del proceso para los colores de la suite. Mismo motivo que el de
 * `createCuttingSupplier`: `colors.code` es único y el maestro **no se vacía entre corridas**
 * —`reset-test-db.ts` trunca inventario, compras y usuarios, no los maestros—, así que en una
 * máquina que ya corrió la suite muchas veces hay cientos de códigos `E2E····` vivos y cuatro
 * letras al azar chocan cada tanto. El 409 sale desde dentro de `setupRoofingScenario`, en un
 * test que no habla de colores.
 */
let colorSeq = 0;

/** `1` → `AAAB`: un correlativo en letras, que es lo que el código del color admite. */
function letterSeq(value: number, length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  let rest = value;
  for (let i = 0; i < length; i += 1) {
    out = (alphabet[rest % 26] ?? 'A') + out;
    rest = Math.floor(rest / 26);
  }
  return out;
}

/** Un color nuevo del maestro (D-085). El prefijo `E2E` es la marca de la purga. */
export async function createColor(api: APIRequestContext, hex = '#c8102e'): Promise<ColorDto> {
  colorSeq += 1;
  // Dos letras al azar separan corridas distintas contra la misma base; el correlativo hace
  // que dos colores del mismo proceso no puedan chocar nunca.
  const code = `E2E${randomLetters(2)}${letterSeq(colorSeq, 4)}`;
  return postJson<ColorDto>(api, '/api/colors', {
    code,
    name: `E2E Color ${code}`,
    hexColor: hex,
  });
}

/** Acabado con densidad fija, para que el kilo teórico sea comprobable a mano. */
export async function createRoofingFinish(api: APIRequestContext): Promise<CreatedFinish> {
  return createFinish(api, { densityFactor: TEST_DENSITY });
}

/**
 * Producto de cobertura **a medida**: unidad `MTR`, fabricado, con color y con el acabado
 * en el propio SKU (D-122: una cobertura ya no lleva receta; su acabado, su espesor, su
 * ancho y su color viven en `products`, y de ahí sale la densidad, RF-25).
 */
export async function createRoofingProduct(
  api: APIRequestContext,
  options: {
    finishId: string;
    colorId?: string | null;
    thicknessMm?: string;
    /** D-118: ancho nominal del SKU (catálogo), independiente del ancho de la bobina real. */
    catalogWidthMm?: string;
    /** Con largo, es una plancha de catálogo (`NIU`); sin él, una cobertura a medida (`MTR`). */
    pieceLengthMm?: string;
    listPricePen?: string;
  },
): Promise<{ product: ProductDto }> {
  const lineId = await businessLineId(api, ROOFING_LINE);
  const madeToMeasure = options.pieceLengthMm === undefined;
  const product = await postJson<ProductDto>(api, '/api/catalog', {
    businessLineId: lineId,
    sku: `E2E-COB${randomLetters(5)}`,
    name: `Cobertura E2E ${randomLetters(3)}`,
    unit: madeToMeasure ? 'MTR' : 'NIU',
    source: 'MANUFACTURED',
    listPricePen: options.listPricePen ?? '30',
    // D-118 (Fase 7e): Metallic Roofing exige espesor y ancho del SKU desde el alta.
    // D-122: y desde entonces también el acabado, que es de donde sale la densidad.
    finishId: options.finishId,
    thicknessMm: options.thicknessMm ?? NOMINAL_THICKNESS,
    widthMm: options.catalogWidthMm ?? COIL_WIDTH,
    // D-127: el subtipo es explícito y obligatorio en esta línea; antes se deducía de la
    // unidad. La plancha además lleva su largo fijo en el catálogo, y la cobertura a
    // medida tiene prohibido llevarlo.
    ...(madeToMeasure
      ? { roofingKind: 'A_MEDIDA' }
      : { roofingKind: 'PLANCHA', lengthMm: options.pieceLengthMm }),
    ...(options.colorId ? { colorId: options.colorId } : {}),
  });
  return { product };
}

export interface RoofingCoilOptions {
  supplierId: string;
  finishId: string;
  colorId?: string | null;
  weightKg?: string;
  thicknessMm?: string;
  widthMm?: string;
  unitPrice?: string;
  lineCode?: string;
  /**
   * D-117 (Fase 7e): una bobina nueva nace `CLOSED` salvo que se pida `OPEN`. La mayoría
   * de estos escenarios la montan de inmediato en una OP o la reservan por kilos, y las
   * dos cosas exigen `OPEN` (D-116 solo admite `CLOSED` en la venta de la bobina entera),
   * así que el default de este helper sigue siendo `OPEN` para no romper Fase 6.
   */
  coilStatus?: 'OPEN' | 'CLOSED';
  /**
   * D-124: día de negocio en que la bobina entra (`AAAA-MM-DD`). Por defecto hoy. Sirve
   * para las cargas históricas: un consumo retrofechado a agosto exige que la bobina que lo
   * soporta también sea de agosto, o el guardrail cronológico lo corta con razón.
   */
  operationDate?: string;
}

/**
 * Una bobina comprada y recibida, con color. Devuelve la bobina y el id de la compra para
 * poder deshacerla.
 *
 * Cada llamada abre su propia compra: dos bobinas del mismo proveedor en la misma compra
 * comparten anulación, y varios tests necesitan anular una sin tocar la otra.
 */
export async function buyRoofingCoil(
  api: APIRequestContext,
  options: RoofingCoilOptions,
): Promise<{ coil: CoilDto; purchaseId: string }> {
  const purchase = await postJson<PurchaseDto>(api, '/api/purchases', {
    supplierId: options.supplierId,
    businessLine: options.lineCode ?? ROOFING_LINE,
    type: 'COIL',
    docType: 'FACTURA',
    series: 'F001',
    number: uniqueDocumentNumber(),
    issueDate: options.operationDate ?? today(),
    currency: 'PEN',
    igvRate: '18',
    paymentTerms: 'CONTADO',
    items: [
      {
        description: 'Bobina E2E Fase 6 para rolar coberturas',
        qty: options.weightKg ?? '2000',
        unit: 'KGM',
        unitPrice: options.unitPrice ?? '5',
        finishId: options.finishId,
        widthMm: options.widthMm ?? COIL_WIDTH,
        thicknessMm: options.thicknessMm ?? NOMINAL_THICKNESS,
        ...(options.colorId ? { colorId: options.colorId } : {}),
        coilStatus: options.coilStatus ?? 'OPEN',
      },
    ],
  });
  await postJson<PurchaseDto>(api, `/api/purchases/${purchase.id}/receive`, {
    ...(options.operationDate ? { operationDate: options.operationDate } : {}),
  });
  // Se filtra por `purchaseId` y no por "la primera del proveedor": varios tests compran
  // dos o tres bobinas al mismo proveedor y quedarse con la primera devolvía la del test
  // anterior, con un fallo que no se parecía en nada a su causa.
  const coils = await getItems<CoilDto & { purchaseId: string | null }>(
    api,
    `/api/coils?supplierId=${options.supplierId}`,
  );
  const coil = coils.find((c) => c.purchaseId === purchase.id);
  expect(coil, 'La compra no dejó ninguna bobina').toBeDefined();
  return { coil: coil!, purchaseId: purchase.id };
}

/** Escenario base de la fase: proveedor, acabado, color, producto a medida y bobina. */
export interface RoofingScenario {
  supplier: CreatedSupplier;
  finish: CreatedFinish;
  color: ColorDto;
  product: ProductDto;
  coil: CoilDto;
  purchaseId: string;
}

export async function setupRoofingScenario(
  api: APIRequestContext,
  options: { weightKg?: string; pieceLengthMm?: string } = {},
): Promise<RoofingScenario> {
  const supplier = await createCuttingSupplier(api);
  const finish = await createRoofingFinish(api);
  const color = await createColor(api);
  const { product } = await createRoofingProduct(api, {
    finishId: finish.id,
    colorId: color.id,
    ...(options.pieceLengthMm === undefined ? {} : { pieceLengthMm: options.pieceLengthMm }),
  });
  const { coil, purchaseId } = await buyRoofingCoil(api, {
    supplierId: supplier.id,
    finishId: finish.id,
    colorId: color.id,
    weightKg: options.weightKg ?? '2000',
  });
  return { supplier, finish, color, product, coil, purchaseId };
}

/** Subítems `{cantidad, largo}` en la forma que espera el API (milímetros, D-083). */
export function pieces(
  ...rows: [meters: number, qty: number][]
): { lengthMm: string; qty: number }[] {
  return rows.map(([meters, qty]) => ({ lengthMm: (meters * 1000).toFixed(2), qty }));
}

/** Metros lineales de esa lista, para escribir la cantidad de la línea sin recalcular. */
export function metersOf(rows: { lengthMm: string; qty: number }[]): string {
  const mm = rows.reduce((acc, r) => acc + Number(r.lengthMm) * r.qty, 0);
  return (mm / 1000).toFixed(3);
}

/**
 * Cotización de coberturas con una línea compuesta, emitida y confirmada, con su OP creada
 * a partir de la reserva. Es el arranque de casi todos los tests de la fase.
 *
 * D-134: ya no se elige una bobina al cotizar (`reserveFromCoilId`/`reserveKg`
 * desaparecieron). La línea solo manda `productId`, `qty` (metros) y `pieces`; el API
 * resuelve solo el agregado de materia prima (línea + color + espesor de la receta) y
 * calcula los kilos teóricos (`ml × espesor × ancho × densidad`). Qué bobina cumple esa
 * promesa lo decide planta al montar la OP (`mountCoil`), no el vendedor acá.
 */
export async function quoteAndOrder(
  api: APIRequestContext,
  input: {
    customerId: string;
    productId: string;
    rows: { lengthMm: string; qty: number }[];
    unitPricePen?: string;
    /** Fase 7 (D-096): única ventana en la que el vendedor la fija, en la confirmación. */
    promisedDeliveryDate?: string;
  },
): Promise<{ quotation: QuotationDto; order: SalesOrderDto }> {
  return quoteAndOrderLines(api, {
    customerId: input.customerId,
    lines: [
      {
        productId: input.productId,
        rows: input.rows,
        ...(input.unitPricePen === undefined ? {} : { unitPricePen: input.unitPricePen }),
      },
    ],
    ...(input.promisedDeliveryDate === undefined
      ? {}
      : { promisedDeliveryDate: input.promisedDeliveryDate }),
  });
}

/**
 * Lo mismo, con **varias líneas a medida en el mismo pedido**.
 *
 * Es el escenario que D-155 puso en el centro y que D-154 vino a arreglar: un pedido de
 * coberturas tiene una reserva por línea y una OP por reserva, así que montar la bobina de la
 * línea 1 se comprobaba contra la promesa —viva y del mismo pedido— de la línea 2. Un pedido
 * de una sola línea no puede reproducirlo.
 */
export async function quoteAndOrderLines(
  api: APIRequestContext,
  input: {
    customerId: string;
    lines: {
      productId: string;
      rows: { lengthMm: string; qty: number }[];
      unitPricePen?: string;
    }[];
    promisedDeliveryDate?: string;
  },
): Promise<{ quotation: QuotationDto; order: SalesOrderDto }> {
  const quotation = await postJson<QuotationDto>(api, '/api/sales/quotations', {
    customerId: input.customerId,
    businessLine: ROOFING_LINE,
    issueDate: today(),
    items: input.lines.map((line) => ({
      productId: line.productId,
      qty: metersOf(line.rows),
      unitPricePen: line.unitPricePen ?? '30',
      pieces: line.rows,
    })),
  });
  await postJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}/emit`);
  // `confirmQuotationSchema` (Fase 7) valida un objeto; `ZodValidationPipe` trata un body
  // ausente como `{}`, así que esto funciona con o sin `promisedDeliveryDate`.
  const order = await postJson<SalesOrderDto>(
    api,
    `/api/sales/quotations/${quotation.id}/confirm`,
    { promisedDeliveryDate: input.promisedDeliveryDate },
  );
  return { quotation, order };
}

/** D-148: la OP de cada línea del pedido que todavía no la tiene, de una sola vez. */
export async function roofingOrdersFromSalesOrder(
  api: APIRequestContext,
  salesOrderId: string,
): Promise<{ created: { orderId: string; code: string }[]; alreadyQueued: number }> {
  return postJson<{ created: { orderId: string; code: string }[]; alreadyQueued: number }>(
    api,
    `/api/production/roofing/from-sales-order/${salesOrderId}`,
    {},
  );
}

/**
 * Una fila de `GET /production/roofing/batch`: lo que el espacio de producción del pedido
 * (D-155) pinta en cada pestaña. El `POST` de la tanda (D-147) ya no existe; el guardado es
 * por orden, con `POST /production/roofing/:id/report`.
 */
export interface BatchOrderRow {
  orderId: string;
  code: string;
  status: string;
  /** D-155: la reserva de la orden, para pedir las bobinas candidatas sin esconder su material. */
  reservationId: string | null;
  productId: string;
  productSku: string;
  salesOrderId: string | null;
  salesOrderCode: string | null;
  planMeters: string;
  reportedMeters: string;
  remainingMeters: string;
  declaredKg: string;
  reportedKg: string;
  planItems: { lineNumber: number; lengthMm: string; qty: number }[];
  remainingPieces: { lineNumber: number; lengthMm: string; qty: number }[];
  coils: {
    coilId: string;
    /** D-155: la asignación, para poder bajar la bobina desde la propia pestaña. */
    consumptionId: string;
    coilCode: string;
    consumedKg: string;
    remainingKg: string;
  }[];
}

export async function batchOrders(
  api: APIRequestContext,
  salesOrderId?: string,
): Promise<BatchOrderRow[]> {
  return getJson<BatchOrderRow[]>(
    api,
    `/api/production/roofing/batch${salesOrderId ? `?salesOrderId=${salesOrderId}` : ''}`,
  );
}

/** Montar una bobina en la roladora (D-086). Devuelve la orden con los avisos de D-154. */
export async function mountCoil(
  api: APIRequestContext,
  orderId: string,
  input: { coilId: string; qtyKg?: string },
): Promise<ProductionOrderDto> {
  return postJson<ProductionOrderDto>(api, `/api/production/roofing/${orderId}/coils`, input);
}

/** Reportar los largos que salieron (D-083). Devuelve la orden con los avisos de D-154. */
export async function reportPieces(
  api: APIRequestContext,
  orderId: string,
  input: {
    pieces: { lengthMm: string; qty: number }[];
    coilId?: string;
    consumedKg?: string;
  },
): Promise<ProductionOrderDto> {
  return postJson<ProductionOrderDto>(api, `/api/production/roofing/${orderId}/report`, input);
}

/** El reporte vigente más reciente de la orden, que es donde D-154 deja su aviso. */
export async function lastActiveReport(
  api: APIRequestContext,
  orderId: string,
): Promise<ProductionOrderDto['reports'][number]> {
  const order = await getJson<ProductionOrderDto>(api, `/api/production/${orderId}`);
  const active = order.reports.filter((r) => r.status === 'ACTIVE');
  expect(active.length, `${orderId} no tiene ningún reporte vigente`).toBeGreaterThan(0);
  return active[active.length - 1]!;
}

/** Reservas del pedido, tal como las devuelve el detalle. */
export async function reservationsOf(
  api: APIRequestContext,
  orderId: string,
): Promise<ReservationRow[]> {
  const order = await getJson<{ reservations: ReservationRow[] }>(
    api,
    `/api/sales/orders/${orderId}`,
  );
  return order.reservations;
}

export async function roofingOrder(
  api: APIRequestContext,
  reservationId: string,
): Promise<ProductionOrderDto> {
  return postJson<ProductionOrderDto>(api, '/api/production/roofing', { reservationId });
}

export async function coilOptions(
  api: APIRequestContext,
  productId: string,
  reservationId?: string,
): Promise<RoofingCoilOptionDto[]> {
  const qs = reservationId ? `&reservationId=${reservationId}` : '';
  return getJson<RoofingCoilOptionDto[]>(
    api,
    `/api/production/roofing/coils?productId=${productId}${qs}`,
  );
}

/**
 * Deja la OP de coberturas anulada y su kardex en cero. Mismo camino que la purga de
 * producción de Fase 4 pero contra las rutas de coberturas.
 */
export async function purgeRoofingOrder(api: APIRequestContext, orderId: string): Promise<void> {
  const order = await getJson<ProductionOrderDto>(api, `/api/production/${orderId}`);
  if (order.status === 'CANCELLED') return;
  if (order.status === 'CLOSED') {
    await postJson<ProductionOrderDto>(api, `/api/production/roofing/${orderId}/reopen`, {
      reason: 'Limpieza de la prueba E2E',
    });
  }
  const current = await getJson<ProductionOrderDto>(api, `/api/production/${orderId}`);
  const active = current.reports.filter((r) => r.status === 'ACTIVE');
  for (const report of [...active].reverse()) {
    await postJson<ProductionOrderDto>(
      api,
      `/api/production/roofing/${orderId}/reports/${report.id}/reverse`,
      { reason: 'Limpieza de la prueba E2E' },
    );
  }
  await postJson<ProductionOrderDto>(api, `/api/production/roofing/${orderId}/cancel`, {
    reason: 'Limpieza de la prueba E2E',
  });
}

/**
 * Deshace todo lo que un test de la fase creó. Nunca lanza: es limpieza de `finally`.
 *
 * El orden importa y es el mismo que en el resto del proyecto: primero lo que retiene
 * material (OP), después lo comercial (pedido, cotización), y recién ahí las anulaciones de
 * bobina y compra, que la reserva bloquea mientras exista.
 */
export async function purgeRoofingTrail(
  api: APIRequestContext,
  trail: {
    productionOrderIds?: string[];
    orderIds?: string[];
    quotationIds?: string[];
    coilIds?: string[];
    purchaseIds?: string[];
    productIds?: string[];
    supplierId?: string;
    finishId?: string;
    colorId?: string;
  },
): Promise<void> {
  for (const orderId of [...(trail.productionOrderIds ?? [])].reverse()) {
    await purgeRoofingOrder(api, orderId).catch(() => undefined);
  }
  for (const orderId of trail.orderIds ?? []) {
    await api
      .post(`/api/sales/orders/${orderId}/cancel`, { data: { reason: 'Limpieza de prueba E2E' } })
      .catch(() => undefined);
  }
  for (const quotationId of trail.quotationIds ?? []) {
    await api
      .post(`/api/sales/quotations/${quotationId}/cancel`, {
        data: { reason: 'Limpieza de prueba E2E' },
      })
      .catch(() => undefined);
  }
  for (const coilId of trail.coilIds ?? []) {
    await api
      .post(`/api/coils/${coilId}/cancel`, { data: { reason: 'Limpieza de prueba E2E' } })
      .catch(() => undefined);
  }
  for (const purchaseId of trail.purchaseIds ?? []) {
    await api
      .post(`/api/purchases/${purchaseId}/cancel`, { data: { reason: 'Limpieza de prueba E2E' } })
      .catch(() => undefined);
  }
  for (const productId of trail.productIds ?? []) {
    await api
      .patch(`/api/catalog/${productId}`, { data: { isActive: false } })
      .catch(() => undefined);
  }
  if (trail.supplierId) {
    await api
      .patch(`/api/suppliers/${trail.supplierId}`, { data: { isActive: false } })
      .catch(() => undefined);
  }
  if (trail.finishId) {
    await api
      .patch(`/api/finishes/${trail.finishId}`, { data: { isActive: false } })
      .catch(() => undefined);
  }
  // El color va al final: el API se niega a desactivarlo mientras un producto activo o una
  // bobina viva lo use, así que solo funciona después de todo lo anterior.
  if (trail.colorId) {
    await api
      .patch(`/api/colors/${trail.colorId}`, { data: { isActive: false } })
      .catch(() => undefined);
  }
}
