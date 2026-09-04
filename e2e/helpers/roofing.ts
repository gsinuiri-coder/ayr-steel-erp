import { expect, type APIRequestContext } from '@playwright/test';
import { createFinish, getJson, postJson, type CreatedFinish, type CreatedSupplier } from './api';
import {
  businessLineId,
  createCuttingSupplier,
  putJson,
  randomLetters,
  today,
  uniqueDocumentNumber,
  type CoilDto,
  type ProductBomDto,
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
 * de 1 000 mm × 0.50 mm con un acabado de densidad 8.0 consume exactamente 4 kg por metro
 * (`1000 × 0.5 × 1000 × 8 / 1e6`), así que una plancha de 4 m son 16 kg y otra de 6 m, 24.
 */

export const ROOFING_LINE = 'metallic-roofing';
export const UPVC_LINE = 'roofing';

/** Densidad del acabado de prueba: deja el kilo por metro en un número redondo. */
export const TEST_DENSITY = '8.0000';
/** Espesor nominal del producto y de la bobina que sí sirve. */
export const NOMINAL_THICKNESS = '0.50';
/** Ancho de la bobina de prueba: con la densidad de arriba, 4 kg por metro lineal. */
export const COIL_WIDTH = '1000';

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
  itemType: 'COIL' | 'PRODUCT';
  itemId: string;
  qty: string;
  unit: string;
  status: string;
}

/** Un color nuevo del maestro (D-085). El prefijo `E2E` es la marca de la purga. */
export async function createColor(api: APIRequestContext, hex = '#c8102e'): Promise<ColorDto> {
  return postJson<ColorDto>(api, '/api/colors', {
    code: `E2E${randomLetters(4)}`,
    name: `E2E Color ${randomLetters(4)}`,
    hexColor: hex,
  });
}

/** Acabado con densidad fija, para que el kilo teórico sea comprobable a mano. */
export async function createRoofingFinish(api: APIRequestContext): Promise<CreatedFinish> {
  return createFinish(api, { densityFactor: TEST_DENSITY });
}

/**
 * Producto de cobertura **a medida**: unidad `MTR`, fabricado, con color y con receta de
 * cobertura (sin largo: el largo lo trae el pedido, D-083).
 */
export async function createRoofingProduct(
  api: APIRequestContext,
  options: {
    finishId: string;
    colorId?: string | null;
    thicknessMm?: string;
    /** Con largo, es una plancha de catálogo (`NIU`); sin él, una cobertura a medida (`MTR`). */
    pieceLengthMm?: string;
    listPricePen?: string;
  },
): Promise<{ product: ProductDto; bom: ProductBomDto }> {
  const lineId = await businessLineId(api, ROOFING_LINE);
  const madeToMeasure = options.pieceLengthMm === undefined;
  const product = await postJson<ProductDto>(api, '/api/catalog', {
    businessLineId: lineId,
    sku: `E2E-COB${randomLetters(5)}`,
    name: `Cobertura E2E ${randomLetters(3)}`,
    unit: madeToMeasure ? 'MTR' : 'NIU',
    source: 'MANUFACTURED',
    listPricePen: options.listPricePen ?? '30',
    ...(options.colorId ? { colorId: options.colorId } : {}),
  });
  const bom = await putJson<ProductBomDto>(api, `/api/production/boms/${product.id}`, {
    kind: 'ROOFING',
    finishId: options.finishId,
    inputThicknessMm: options.thicknessMm ?? NOMINAL_THICKNESS,
    ...(madeToMeasure ? {} : { pieceLengthMm: options.pieceLengthMm }),
  });
  return { product, bom };
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
    issueDate: today(),
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
      },
    ],
  });
  await postJson<PurchaseDto>(api, `/api/purchases/${purchase.id}/receive`);
  // Se filtra por `purchaseId` y no por "la primera del proveedor": varios tests compran
  // dos o tres bobinas al mismo proveedor y quedarse con la primera devolvía la del test
  // anterior, con un fallo que no se parecía en nada a su causa.
  const coils = await getJson<(CoilDto & { purchaseId: string | null })[]>(
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
  bom: ProductBomDto;
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
  const { product, bom } = await createRoofingProduct(api, {
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
  return { supplier, finish, color, product, bom, coil, purchaseId };
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
 */
export async function quoteAndOrder(
  api: APIRequestContext,
  input: {
    customerId: string;
    productId: string;
    coilId: string;
    reserveKg: string;
    rows: { lengthMm: string; qty: number }[];
    unitPricePen?: string;
  },
): Promise<{ quotation: QuotationDto; order: SalesOrderDto }> {
  const quotation = await postJson<QuotationDto>(api, '/api/sales/quotations', {
    customerId: input.customerId,
    businessLine: ROOFING_LINE,
    issueDate: today(),
    items: [
      {
        productId: input.productId,
        qty: metersOf(input.rows),
        unitPricePen: input.unitPricePen ?? '30',
        pieces: input.rows,
        reserveFromCoilId: input.coilId,
        reserveKg: input.reserveKg,
      },
    ],
  });
  await postJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}/emit`);
  const order = await postJson<SalesOrderDto>(api, `/api/sales/quotations/${quotation.id}/confirm`);
  return { quotation, order };
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
