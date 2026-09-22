import { expect, type APIRequestContext } from '@playwright/test';
import {
  createFinish,
  getItems,
  getJson,
  postJson,
  retryingOnConflict,
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
  // Dos letras al azar separan corridas distintas contra la misma base; el correlativo hace
  // que dos colores del mismo proceso no puedan chocar nunca. Lo que las dos letras **no**
  // cubren es que la corrida de hoy sortee el mismo par que una corrida vieja: es 1 entre 676
  // y el maestro de colores no se vacía entre corridas, así que pasa. `retryingOnConflict`
  // vuelve a sortearlo en vez de tumbar un test que no habla de colores (mismo motivo y misma
  // forma que en `createCuttingSupplier`).
  return retryingOnConflict(
    () => {
      colorSeq += 1;
      const code = `E2E${randomLetters(2)}${letterSeq(colorSeq, 4)}`;
      return { code, name: `E2E Color ${code}`, hexColor: hex };
    },
    (body) => postJson<ColorDto>(api, '/api/colors', body),
  );
}

/**
 * Acabado con densidad fija, para que el kilo teórico sea comprobable a mano.
 *
 * D-203: con `colorId` nace PREPINTADO de ese color; sin él, NATURAL. El color de la bobina
 * sale del acabado, así que un escenario con color necesita un acabado prepintado.
 */
export async function createRoofingFinish(
  api: APIRequestContext,
  options: { colorId?: string | null } = {},
): Promise<CreatedFinish> {
  return createFinish(api, {
    densityFactor: TEST_DENSITY,
    businessLine: ROOFING_LINE,
    ...(options.colorId ? { kind: 'PREPINTADO', colorId: options.colorId } : { kind: 'NATURAL' }),
  });
}

interface FinishIdentityDto {
  id: string;
  code: string;
  name: string;
  densityFactor: string;
  kind: 'NATURAL' | 'PREPINTADO' | 'GALVANIZADO' | null;
  colorId: string | null;
  businessLine: string | null;
}

/**
 * Variantes de acabado creadas por {@link finishForCoil}, por acabado base. La clave interna es
 * `línea|color`. Se guarda la promesa (y no el id) para que dos compras en paralelo con el mismo
 * par no creen dos variantes.
 */
const finishVariants = new Map<string, Map<string, Promise<string>>>();

/**
 * D-203: el acabado con el que de verdad se compra una bobina de `lineCode` y color `colorId`.
 *
 * Antes de D-203 el color viajaba suelto en el ítem de compra y cualquier acabado servía para
 * cualquier color. Ahora el color **es** del acabado, así que muchos specs que compran «el
 * acabado del escenario, pero en otro color» (o sin color) necesitan otro acabado. Si el base ya
 * cumple (misma línea y mismo color) se usa tal cual; si no, se crea una variante con **la misma
 * densidad** —el kilo teórico no cambia— PREPINTADO con ese color, o NATURAL sin color.
 */
export async function finishForCoil(
  api: APIRequestContext,
  baseFinishId: string,
  lineCode: string,
  colorId: string | null,
): Promise<string> {
  const byBase = finishVariants.get(baseFinishId) ?? new Map<string, Promise<string>>();
  finishVariants.set(baseFinishId, byBase);
  const key = `${lineCode}|${colorId ?? ''}`;
  const cached = byBase.get(key);
  if (cached) return cached;
  const pending = (async () => {
    const base = await getJson<FinishIdentityDto>(api, `/api/finishes/${baseFinishId}`);
    if (base.kind !== null && base.businessLine === lineCode && base.colorId === colorId) {
      return base.id;
    }
    const variant = await createFinish(api, {
      densityFactor: base.densityFactor,
      businessLine: lineCode,
      ...(colorId ? { kind: 'PREPINTADO', colorId } : { kind: 'NATURAL' }),
    });
    return variant.id;
  })();
  byBase.set(key, pending);
  // Un fallo no se memoiza: el siguiente intento vuelve a probar.
  pending.catch(() => byBase.delete(key));
  return pending;
}

/** Variantes vivas de un acabado base, para que la purga las desactive con él. */
async function variantsOf(baseFinishId: string): Promise<string[]> {
  const byBase = finishVariants.get(baseFinishId);
  if (!byBase) return [];
  const ids = await Promise.all(
    [...byBase.values()].map((p) => p.catch(() => null as string | null)),
  );
  return ids.filter((id): id is string => id !== null && id !== baseFinishId);
}

/**
 * Producto de cobertura **a medida**: unidad `MTR`, fabricado, con color y con el acabado
 * en el propio SKU (D-122: una cobertura ya no lleva receta; su acabado, su espesor, su
 * ancho y su color viven en `products`, y de ahí sale la densidad, RF-25).
 *
 * F8-S5/M0 (D-203): el catálogo exige que `colorId` sea el del acabado (D-086 monta una
 * bobina solo si su color, que sale del acabado desde D-203/M2, coincide con el del
 * producto). Igual que {@link buyRoofingCoil}, este helper no asume que quien llama ya hizo
 * ese acabado a medida: si `options.finishId` no es del color pedido, usa (o crea) la
 * variante de {@link finishForCoil} — la misma que usaría comprar una bobina con ese mismo
 * par (acabado base, color), así que un producto y una bobina montados con los mismos
 * argumentos siguen encontrándose.
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
  const finishId = await finishForCoil(
    api,
    options.finishId,
    ROOFING_LINE,
    options.colorId ?? null,
  );
  const product = await postJson<ProductDto>(api, '/api/catalog', {
    businessLineId: lineId,
    sku: `E2E-COB${randomLetters(5)}`,
    name: `Cobertura E2E ${randomLetters(3)}`,
    unit: madeToMeasure ? 'MTR' : 'NIU',
    source: 'MANUFACTURED',
    listPricePen: options.listPricePen ?? '30',
    // D-118 (Fase 7e): Metallic Roofing exige espesor y ancho del SKU desde el alta.
    // D-122: y desde entonces también el acabado, que es de donde sale la densidad.
    finishId,
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
  /**
   * Acabado base. D-203: si su color o su línea no son los de esta compra, la bobina se compra
   * con una variante de él (ver {@link finishForCoil}) y `coil.finishId` es el de la variante.
   */
  finishId: string;
  /** Color que tiene que tener la bobina; `null`/ausente = sin color. Ya no viaja en el ítem. */
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
  const lineCode = options.lineCode ?? ROOFING_LINE;
  const finishId = await finishForCoil(api, options.finishId, lineCode, options.colorId ?? null);
  const purchase = await postJson<PurchaseDto>(api, '/api/purchases', {
    supplierId: options.supplierId,
    businessLine: lineCode,
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
        // D-203: sin `colorId` — el color de la bobina sale del acabado.
        finishId,
        widthMm: options.widthMm ?? COIL_WIDTH,
        thicknessMm: options.thicknessMm ?? NOMINAL_THICKNESS,
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
  // Los tres maestros de arriba **no dependen entre sí**: son tres altas contra tres tablas
  // distintas. En fila cuestan tres viajes; juntas, uno. Lo que sigue sí depende de ellos
  // —el producto necesita el acabado y el color, la compra necesita el proveedor— y se queda
  // secuencial, que es lo que este `Promise.all` tiene que respetar para no volverse una
  // carrera. Este escenario lo montan 51 casos, así que el viaje ahorrado se paga 51 veces.
  // D-203: el acabado ya no es independiente del color (es PREPINTADO de ese color), así que
  // espera al color; el proveedor sigue en paralelo.
  const colorCreated = createColor(api);
  const [supplier, color, finish] = await Promise.all([
    createCuttingSupplier(api),
    colorCreated,
    colorCreated.then((c) => createRoofingFinish(api, { colorId: c.id })),
  ]);
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
    issueDate: today(),
    items: input.lines.map((line) => ({
      productId: line.productId,
      qty: metersOf(line.rows),
      unitPricePen: line.unitPricePen ?? '30',
      pieces: line.rows,
    })),
  });
  // D-184: la cotización nace emitida; no hay paso de emitir.
  // `confirmQuotationSchema` (Fase 7) valida un objeto; `ZodValidationPipe` trata un body
  // ausente como `{}`, así que esto funciona con o sin `promisedDeliveryDate`.
  const order = await postJson<SalesOrderDto>(
    api,
    `/api/sales/quotations/${quotation.id}/confirm`,
    { promisedDeliveryDate: input.promisedDeliveryDate },
  );
  return { quotation, order };
}

/**
 * D-148: la OP de cada línea del pedido.
 *
 * D-186: confirmar ya las crea, así que para un pedido recién confirmado esto devuelve **las
 * que la confirmación dejó en cola** (en `created`, en el orden de las líneas). Solo llama al
 * endpoint de D-148 si a alguna línea le falta su orden —por ejemplo, porque un test anuló una
 * OP—, que es el único caso en que ese botón todavía tiene trabajo.
 */
export async function roofingOrdersFromSalesOrder(
  api: APIRequestContext,
  salesOrderId: string,
): Promise<{ created: { orderId: string; code: string }[]; alreadyQueued: number }> {
  const live = (await reservationsOf(api, salesOrderId)).filter(
    (r) => r.itemType === 'RAW_MATERIAL' && r.status === 'ACTIVE',
  );
  if (live.length > 0 && live.every((r) => r.productionOrderId !== null)) {
    return {
      created: live.map((r) => ({ orderId: r.productionOrderId!, code: r.productionOrderCode! })),
      alreadyQueued: 0,
    };
  }
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

/**
 * La OP de una reserva de materia prima.
 *
 * D-186: confirmar la crea en la misma transacción que el pedido, así que lo normal es que ya
 * exista y se devuelve esa. Solo se crea si la reserva no tiene orden viva (una OP anulada), que
 * es el camino que `POST /production/roofing` sigue cubriendo.
 */
export async function roofingOrder(
  api: APIRequestContext,
  reservationId: string,
): Promise<ProductionOrderDto> {
  const reservations = await getJson<{ id: string; productionOrderId: string | null }[]>(
    api,
    '/api/sales/reservations?status=ACTIVE',
  );
  const existing = reservations.find((r) => r.id === reservationId)?.productionOrderId;
  if (existing) return getJson<ProductionOrderDto>(api, `/api/production/${existing}`);
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
/**
 * Anula las OP vivas que confirmar creó solas (D-186) y devuelve cuántas anuló.
 *
 * **No es la puerta de la cola**: desde D-189 la cola son justamente esas órdenes no
 * iniciadas, y los specs de cola trabajan sobre ellas sin anular nada. Esto queda para los
 * casos que necesitan la reserva **sin** orden: liberarla a mano, volver a abrir la orden por
 * `POST /production/roofing` con otra fecha, o probar «líneas sin orden».
 */
export async function cancelAutoCreatedOrders(
  api: APIRequestContext,
  salesOrderId: string,
): Promise<number> {
  const reservations = await reservationsOf(api, salesOrderId);
  let cancelled = 0;
  for (const r of reservations) {
    if (r.status !== 'ACTIVE' || r.productionOrderId === null) continue;
    await postJson<ProductionOrderDto>(
      api,
      `/api/production/roofing/${r.productionOrderId}/cancel`,
      {
        reason: 'E2E: dejar la reserva sin orden',
      },
    );
    cancelled += 1;
  }
  return cancelled;
}

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
  // D-186: confirmar ya deja las OPs en cola, así que un pedido puede traer órdenes que el test
  // nunca anotó. Sin anularlas primero, la anulación del pedido se rechaza (hay una OP viva) y
  // la reserva queda prometiendo material para los casos siguientes de la misma corrida.
  for (const orderId of trail.orderIds ?? []) {
    const reservations = await reservationsOf(api, orderId).catch(() => []);
    for (const r of reservations) {
      if (r.productionOrderId) {
        await purgeRoofingOrder(api, r.productionOrderId).catch(() => undefined);
      }
    }
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
    // D-203: con él, las variantes de color que `buyRoofingCoil` le creó. Un acabado activo con
    // un color impide desactivar ese color, y el paso de abajo lo necesita.
    const variants = await variantsOf(trail.finishId);
    for (const id of [trail.finishId, ...variants]) {
      await api.patch(`/api/finishes/${id}`, { data: { isActive: false } }).catch(() => undefined);
    }
    finishVariants.delete(trail.finishId);
  }
  // El color va al final: el API se niega a desactivarlo mientras un producto activo o una
  // bobina viva lo use, así que solo funciona después de todo lo anterior.
  if (trail.colorId) {
    await api
      .patch(`/api/colors/${trail.colorId}`, { data: { isActive: false } })
      .catch(() => undefined);
  }
}
