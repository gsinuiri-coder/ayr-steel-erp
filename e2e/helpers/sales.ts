import { expect, type APIRequestContext } from '@playwright/test';
import { createFinish, getJson, postJson, type CreatedFinish, type CreatedSupplier } from './api';
import {
  businessLineId,
  createCuttingSupplier,
  randomLetters,
  today,
  uniqueDocumentNumber,
  type CoilDto,
  type ProductDto,
  type PurchaseDto,
} from './production';

/**
 * Utilidades del ciclo comercial de Fase 5a (D-064..D-069). Viven acá y no dentro del spec
 * para que el escenario de coberturas y el de perfiles se armen igual, y para que la
 * limpieza sea siempre la misma (misma razón que `helpers/production.ts` en Fase 4).
 */

export interface CustomerDto {
  id: string;
  name: string;
  docNumber: string;
  address: string | null;
  isActive: boolean;
}

export interface SalesItemDto {
  id: string;
  lineNumber: number;
  productId: string;
  productSku: string;
  qty: string;
  unit: string;
  listPricePen: string | null;
  unitPricePen: string;
  subtotalPen: string;
  igvPen: string;
  totalPen: string;
  reserveItemType: 'COIL' | 'PRODUCT';
  reserveItemId: string;
  reserveQty: string;
  reserveUnit: string;
}

export interface ReservationDto {
  id: string;
  salesOrderId: string;
  itemType: 'COIL' | 'PRODUCT';
  itemId: string;
  qty: string;
  unit: string;
  status: 'ACTIVE' | 'CONSUMED' | 'RELEASED';
  productionOrderId: string | null;
  isStale: boolean;
  consumedAt: string | null;
  releasedAt: string | null;
}

export interface QuotationDto {
  id: string;
  code: string;
  status: 'DRAFT' | 'EMITTED' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED';
  issueDate: string;
  validUntil: string;
  isExpired: boolean;
  subtotalPen: string;
  igvPen: string;
  totalPen: string;
  salesOrderId: string | null;
  salesOrderCode: string | null;
  pdfKey: string | null;
  items: SalesItemDto[];
}

export interface SalesOrderDto {
  id: string;
  code: string;
  quotationId: string | null;
  status: 'CONFIRMED' | 'IN_PRODUCTION' | 'FULFILLED' | 'CANCELLED';
  subtotalPen: string;
  igvPen: string;
  totalPen: string;
  items: SalesItemDto[];
  reservations: ReservationDto[];
}

export interface DocumentLookupDto {
  found: boolean;
  docType: string;
  docNumber: string;
  name: string | null;
  address: string | null;
  reason: 'OK' | 'NOT_FOUND' | 'UNAVAILABLE' | 'NOT_CONFIGURED';
}

/** Cliente de prueba con RUC único. Prefijo `E2E ` para que la purga lo reconozca. */
export async function createCustomer(api: APIRequestContext): Promise<CustomerDto> {
  return postJson<CustomerDto>(api, '/api/customers', {
    docType: 'RUC',
    docNumber: `20${uniqueDocumentNumber()}`,
    name: `E2E Cliente ${randomLetters(5)}`,
    address: 'Av. Prueba 123, Lima',
    creditDays: 0,
  });
}

/**
 * Producto vendible con precio de lista (D-068). Por defecto en la línea que se le pase;
 * `PURCHASED`/`NIU` porque acá lo único que importa es que se pueda cotizar.
 */
export async function createSellableProduct(
  api: APIRequestContext,
  options: { lineCode: string; listPricePen?: string; unit?: string },
): Promise<ProductDto & { listPricePen: string | null }> {
  const lineId = await businessLineId(api, options.lineCode);
  return postJson<ProductDto & { listPricePen: string | null }>(api, '/api/catalog', {
    businessLineId: lineId,
    sku: `E2E-VTA${randomLetters(5)}`,
    name: `Producto E2E vendible ${randomLetters(3)}`,
    unit: options.unit ?? 'NIU',
    source: 'PURCHASED',
    ...(options.listPricePen === undefined ? {} : { listPricePen: options.listPricePen }),
  });
}

export interface CoilScenario {
  supplier: CreatedSupplier;
  finish: CreatedFinish;
  purchaseId: string;
  coil: CoilDto;
}

/**
 * Una bobina comprada y recibida en la línea que se indique, para tener materia prima
 * reservable. Es el escenario mínimo de una cotización de coberturas: el producto se
 * fabrica contra el pedido, así que lo que se promete son kilos de esta bobina.
 */
export async function setupCoilStock(
  api: APIRequestContext,
  options: { lineCode: string; weightKg?: string; unitPrice?: string },
): Promise<CoilScenario> {
  const supplier = await createCuttingSupplier(api);
  const finish = await createFinish(api);
  const weightKg = options.weightKg ?? '5000';

  const purchase = await postJson<PurchaseDto>(api, '/api/purchases', {
    supplierId: supplier.id,
    businessLine: options.lineCode,
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
        description: 'Bobina E2E Fase 5a para reservar',
        qty: weightKg,
        unit: 'KGM',
        unitPrice: options.unitPrice ?? '5',
        finishId: finish.id,
        widthMm: '1200',
        thicknessMm: '0.50',
      },
    ],
  });
  await postJson<PurchaseDto>(api, `/api/purchases/${purchase.id}/receive`);
  const coils = await getJson<CoilDto[]>(api, `/api/coils?supplierId=${supplier.id}`);
  const coil = coils[0]!;
  expect(coil.availableKg).toBe(`${Number(weightKg).toFixed(0)}.000`);

  return { supplier, finish, purchaseId: purchase.id, coil };
}

/** Físico, reservado y disponible de un ítem, tal como los muestra `/inventario`. */
export async function availabilityOf(
  api: APIRequestContext,
  itemType: 'COIL' | 'PRODUCT',
  itemId: string,
): Promise<{ qty: string; reservedQty: string; availableQty: string }> {
  const balances = await getJson<{ qty: string; reservedQty: string; availableQty: string }[]>(
    api,
    `/api/inventory/balances?itemType=${itemType}&itemId=${itemId}`,
  );
  const balance = balances[0];
  expect(balance, `${itemType} ${itemId} no tiene saldo de kardex`).toBeDefined();
  return balance!;
}

/** Cotización en borrador con una sola línea. */
export async function createQuotation(
  api: APIRequestContext,
  input: {
    customerId: string;
    businessLine: string;
    productId: string;
    qty: string;
    unitPricePen?: string;
    reserveFromCoilId?: string;
    reserveKg?: string;
    issueDate?: string;
    validityDays?: number;
  },
): Promise<QuotationDto> {
  return postJson<QuotationDto>(api, '/api/sales/quotations', {
    customerId: input.customerId,
    businessLine: input.businessLine,
    issueDate: input.issueDate ?? today(),
    ...(input.validityDays === undefined ? {} : { validityDays: input.validityDays }),
    items: [
      {
        productId: input.productId,
        qty: input.qty,
        ...(input.unitPricePen === undefined ? {} : { unitPricePen: input.unitPricePen }),
        ...(input.reserveFromCoilId === undefined
          ? {}
          : { reserveFromCoilId: input.reserveFromCoilId, reserveKg: input.reserveKg }),
      },
    ],
  });
}

/** Fecha ISO desplazada N días respecto de hoy (negativo = pasado). */
export function isoDaysFromToday(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Deja inertes las entidades comerciales que creó un test. Nunca lanza: es limpieza de
 * `finally`. El orden importa —anular el pedido libera las reservas, y solo con las
 * reservas fuera se pueden anular la bobina y su compra— y es el mismo que sigue
 * `pnpm prod:purge-e2e`.
 */
export async function purgeSalesTrail(
  api: APIRequestContext,
  trail: { orderIds?: string[]; quotationIds?: string[] },
): Promise<void> {
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
}
