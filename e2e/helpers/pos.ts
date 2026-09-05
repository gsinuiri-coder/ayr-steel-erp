import { expect, type APIRequestContext } from '@playwright/test';
import { createSupplier, getJson, postJson, type CreatedSupplier } from './api';
import { today, uniqueDocumentNumber, type ProductDto } from './production';
import { createSellableProduct } from './sales';

/**
 * Punto de venta de mostrador (RF-60; D-098..D-104).
 *
 * El escenario del POS es más corto que el del resto del ciclo comercial y esa brevedad es
 * el punto: el mostrador vende **stock del propio producto** (D-098), así que basta una
 * compra de producto terminado (D-030, `FINISHED_GOOD`) para tener qué vender — no hace
 * falta bobina, ni receta, ni orden de producción.
 */

export const POS_LINE = 'roofing'; // UPVC: compra-venta pura (D-091), sin cotización obligatoria.

export interface PosProductDto {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  businessLine: string;
  businessLineName: string;
  listPricePen: string | null;
  availableQty: string;
}

export interface CashMethodTotalDto {
  method: string;
  saleCount: number;
  totalPen: string;
}

export interface CashSessionDto {
  id: string;
  code: string;
  status: 'OPEN' | 'CLOSED';
  userId: string;
  userName: string;
  openingAmountPen: string;
  openedAt: string;
  openingNotes: string | null;
  expectedCashPen: string;
  countedCashPen: string | null;
  differencePen: string | null;
  closingNotes: string | null;
  closedAt: string | null;
  closedByName: string | null;
  totals: CashMethodTotalDto[];
  saleCount: number;
  voidedCount: number;
  totalPen: string;
}

export interface PosContextDto {
  session: CashSessionDto | null;
  genericCustomerId: string;
  genericCustomerName: string;
  genericMaxTotalPen: string;
  providerConfigured: boolean;
  providerOffline: boolean;
}

export interface PosSaleDto {
  id: string;
  code: string;
  status: 'ACTIVE' | 'VOIDING' | 'VOIDED';
  cashSessionId: string;
  customerName: string;
  customerDocNumber: string;
  method: string;
  totalPen: string;
  salesOrderId: string;
  salesOrderCode: string;
  dispatchId: string;
  dispatchCode: string;
  fiscalDocumentId: string;
  fiscalDocumentNumber: string | null;
  fiscalDocumentStatus: string;
  fiscalPending: boolean;
  createdAt: string;
  createdByName: string | null;
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
}

export interface PosStock {
  supplier: CreatedSupplier;
  product: ProductDto & { listPricePen: string | null };
  purchaseId: string;
  qty: string;
}

/**
 * Un producto de mostrador con saldo propio en el kardex.
 *
 * Compra de producto terminado y recepción: el mismo camino de D-091 para UPVC, que es
 * exactamente lo que el mostrador vende — algo que ya está en el almacén y no se fabrica.
 */
export async function setupPosStock(
  api: APIRequestContext,
  options: { qty?: string; unitPrice?: string; listPricePen?: string } = {},
): Promise<PosStock> {
  const supplier = await createSupplier(api, { name: 'E2E Proveedor mostrador' });
  const product = await createSellableProduct(api, {
    lineCode: POS_LINE,
    unit: 'NIU',
    listPricePen: options.listPricePen ?? '50.0000',
  });
  const qty = options.qty ?? '40';

  const purchase = await postJson<{ id: string }>(api, '/api/purchases', {
    supplierId: supplier.id,
    businessLine: POS_LINE,
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
        productId: product.id,
        description: 'Producto E2E de mostrador',
        qty,
        unit: 'NIU',
        unitPrice: options.unitPrice ?? '20',
      },
    ],
  });
  await postJson(api, `/api/purchases/${purchase.id}/receive`);

  return { supplier, product, purchaseId: purchase.id, qty };
}

/**
 * Un producto **a medida** con saldo propio: la contraparte de `setupPosStock`.
 *
 * Se mide en `MTR`, que es la marca de una cobertura a medida (D-083), y por eso el
 * mostrador no lo vende (D-098). Existe con saldo a propósito: sin un producto así en la
 * base, comprobar que el buscador no lo lista es una aserción que pasa por vacío.
 */
export async function setupMeasuredStock(api: APIRequestContext): Promise<PosStock> {
  const supplier = await createSupplier(api, { name: 'E2E Proveedor a medida' });
  const product = await createSellableProduct(api, {
    lineCode: POS_LINE,
    unit: 'MTR',
    listPricePen: '30.0000',
  });
  const purchase = await postJson<{ id: string }>(api, '/api/purchases', {
    supplierId: supplier.id,
    businessLine: POS_LINE,
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
        productId: product.id,
        description: 'Producto E2E a medida (no se vende en mostrador)',
        qty: '12',
        unit: 'MTR',
        unitPrice: '15',
      },
    ],
  });
  await postJson(api, `/api/purchases/${purchase.id}/receive`);
  return { supplier, product, purchaseId: purchase.id, qty: '12' };
}

export function posContext(api: APIRequestContext): Promise<PosContextDto> {
  return getJson<PosContextDto>(api, '/api/pos/context');
}

export function posProducts(api: APIRequestContext, search?: string): Promise<PosProductDto[]> {
  const query = search ? `?search=${encodeURIComponent(search)}` : '';
  return getJson<PosProductDto[]>(api, `/api/pos/products${query}`);
}

export function openCashSession(
  api: APIRequestContext,
  openingAmountPen = '100.00',
): Promise<CashSessionDto> {
  return postJson<CashSessionDto>(api, '/api/pos/cash-sessions', { openingAmountPen });
}

export function closeCashSession(
  api: APIRequestContext,
  id: string,
  countedCashPen: string,
  notes?: string,
): Promise<CashSessionDto> {
  return postJson<CashSessionDto>(api, `/api/pos/cash-sessions/${id}/close`, {
    countedCashPen,
    ...(notes === undefined ? {} : { notes }),
  });
}

export function cashSession(api: APIRequestContext, id: string): Promise<CashSessionDto> {
  return getJson<CashSessionDto>(api, `/api/pos/cash-sessions/${id}`);
}

export function cashSessionSales(api: APIRequestContext, id: string): Promise<PosSaleDto[]> {
  return getJson<PosSaleDto[]>(api, `/api/pos/cash-sessions/${id}/sales`);
}

export interface PosSaleInput {
  items: { productId: string; qty: string; unitPricePen?: string }[];
  method?: string;
  customerId?: string;
  reference?: string;
  forceGenericCustomer?: boolean;
  notes?: string;
}

export function posSell(api: APIRequestContext, input: PosSaleInput): Promise<PosSaleDto> {
  return postJson<PosSaleDto>(api, '/api/pos/sales', {
    method: input.method ?? 'CASH',
    notes: input.notes ?? 'E2E venta de mostrador',
    ...(input.customerId === undefined ? {} : { customerId: input.customerId }),
    ...(input.reference === undefined ? {} : { reference: input.reference }),
    ...(input.forceGenericCustomer === undefined
      ? {}
      : { forceGenericCustomer: input.forceGenericCustomer }),
    items: input.items,
  });
}

/** Igual que `posSell` pero devolviendo el error: los escenarios que deben fallar lo leen. */
export async function posSellExpectingError(
  api: APIRequestContext,
  input: PosSaleInput,
): Promise<{ status: number; message: string }> {
  const res = await api.post('/api/pos/sales', {
    data: {
      method: input.method ?? 'CASH',
      ...(input.customerId === undefined ? {} : { customerId: input.customerId }),
      ...(input.forceGenericCustomer === undefined
        ? {}
        : { forceGenericCustomer: input.forceGenericCustomer }),
      items: input.items,
    },
  });
  expect(res.ok(), 'la venta debía fallar y salió bien').toBe(false);
  const body = (await res.json().catch(() => ({}))) as { message?: string | string[] };
  return {
    status: res.status(),
    message: Array.isArray(body.message) ? body.message.join(', ') : (body.message ?? ''),
  };
}

export function voidPosSale(
  api: APIRequestContext,
  id: string,
  reason = 'Anulación de prueba E2E',
): Promise<PosSaleDto> {
  return postJson<PosSaleDto>(api, `/api/pos/sales/${id}/void`, { reason });
}

export async function voidPosSaleExpectingError(
  api: APIRequestContext,
  id: string,
  reason = 'Anulación de prueba E2E',
): Promise<{ status: number; message: string }> {
  const res = await api.post(`/api/pos/sales/${id}/void`, { data: { reason } });
  expect(res.ok(), 'la anulación debía fallar y salió bien').toBe(false);
  const body = (await res.json().catch(() => ({}))) as { message?: string | string[] };
  return {
    status: res.status(),
    message: Array.isArray(body.message) ? body.message.join(', ') : (body.message ?? ''),
  };
}

/**
 * Cierra el turno que el test dejó abierto. Nunca lanza: es limpieza de `finally`.
 *
 * Se cierra **contra el esperado** para que el arqueo cuadre y no quede una diferencia de
 * prueba en producción; si el esperado no se puede leer, se intenta cerrar en cero con
 * motivo, que es lo único que el API acepta sin rol de administrador.
 */
export async function closeSessionQuietly(
  api: APIRequestContext,
  id: string | undefined,
): Promise<void> {
  if (!id) return;
  const session = await cashSession(api, id).catch(() => null);
  if (session === null || session.status === 'CLOSED') return;
  await closeCashSession(api, id, session.expectedCashPen, 'Cierre de limpieza E2E').catch(
    () => undefined,
  );
}
