import { expect, type APIRequestContext } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getJson, postJson, type CreatedFinish, type CreatedSupplier } from './api';
import { deactivateTrail, today, type CoilDto, type ProductDto } from './production';
import { createDirectOrder, createSellableProduct, setupCoilStock } from './sales';
import type { CustomerDto, SalesOrderDto } from './sales';

/**
 * Utilidades del ciclo fiscal y logístico de Fase 5b (RF-70, RF-74..RF-79, RF-86..RF-89;
 * D-070..D-078). Mismo criterio que `helpers/sales.ts` en 5a: el andamiaje vive acá para
 * que el spec de flujo y el de bordes armen **el mismo** escenario y limpien igual.
 *
 * El escenario base de la fase es deliberadamente el más simple que ejercita todo el
 * tramo: un pedido directo de drywall (D-065: no exige cotización) cuyo producto se vende
 * **por kilo** contra una bobina. Así la cantidad vendida, la reserva y la salida de
 * kardex están en la misma unidad y el mismo número, y cada aserción sobre el saldo se
 * puede leer sin traducir unidades.
 */

/** Línea que admite pedido directo (D-065): ahorra cotizar, emitir y confirmar. */
export const DISPATCH_LINE = 'drywall';

/** Ubigeos INEI reales de Lima; SUNAT los valida por forma (seis dígitos). */
export const ORIGIN_UBIGEO = '150101';
export const DESTINATION_UBIGEO = '150132';

// ---------------------------------------------------------------------------
// DTOs mínimos que consumen los tests
// ---------------------------------------------------------------------------

export interface FiscalDocumentItemDto {
  id: string;
  lineNumber: number;
  description: string;
  qty: string;
  unit: string;
  unitPricePen: string;
  subtotalPen: string;
  igvPen: string;
  totalPen: string;
  salesOrderItemId: string | null;
  affectedItemId: string | null;
  creditedQty: string;
}

export interface CustomerPaymentDto {
  id: string;
  date: string;
  amountPen: string;
  method: string;
  reference: string | null;
  reversedAt: string | null;
  reversedByName: string | null;
}

export type FiscalDocumentStatus =
  'DRAFT' | 'ISSUED' | 'ACCEPTED' | 'REJECTED' | 'SEND_ERROR' | 'VOID_PENDING' | 'VOIDED';

export interface FiscalDocumentDto {
  id: string;
  docType: 'FACTURA' | 'BOLETA' | 'NOTA_CREDITO' | 'GUIA_REMISION_REMITENTE';
  status: FiscalDocumentStatus;
  number: string | null;
  series: string | null;
  correlative: number | null;
  customerId: string;
  customerName: string;
  customerIsGeneric: boolean;
  salesOrderId: string | null;
  salesOrderCode: string | null;
  dispatchId: string | null;
  dispatchCode: string | null;
  affectedDocumentId: string | null;
  affectedDocumentNumber: string | null;
  replacesDocumentId: string | null;
  replacesDocumentNumber: string | null;
  issueDate: string;
  paymentTerms: 'CONTADO' | 'CREDITO';
  dueDate: string | null;
  subtotalPen: string;
  igvPen: string;
  totalPen: string;
  paidPen: string;
  creditedPen: string;
  balancePen: string;
  isOverdue: boolean;
  genericCustomerOverrideByName: string | null;
  rejectionCode: string | null;
  rejectionMessage: string | null;
  hasPdf: boolean;
  hasXml: boolean;
  hasCdr: boolean;
  sendAttempts: number;
  lastSendError: string | null;
  isStalled: boolean;
  voidPath: 'VOID' | 'CREDIT_NOTE' | 'NONE' | null;
  issuedAt: string | null;
  acceptedAt: string | null;
  voidedAt: string | null;
  items: FiscalDocumentItemDto[];
  payments: CustomerPaymentDto[];
  creditNotes: { id: string; number: string | null; status: string; totalPen: string }[];
}

export interface DispatchItemDto {
  id: string;
  lineNumber: number;
  salesOrderItemId: string;
  productSku: string;
  qty: string;
  unit: string;
  reserveQty: string;
  weightKg: string;
  itemType: 'PRODUCT' | 'COIL';
  itemId: string;
}

export interface DispatchDto {
  id: string;
  code: string;
  salesOrderId: string;
  salesOrderCode: string;
  customerName: string;
  status: 'ISSUED' | 'REVERSED';
  dispatchDate: string;
  transferMode: 'PRIVATE' | 'PUBLIC';
  totalWeightKg: string;
  dispatchNoteId: string | null;
  dispatchNoteNumber: string | null;
  dispatchNoteStatus: FiscalDocumentStatus | null;
  blockingDocumentNumbers: string[];
  reversedAt: string | null;
  items: DispatchItemDto[];
}

export interface InvoicingSettingsDto {
  providerOffline: boolean;
  alertAfterHours: number;
  providerConfigured: boolean;
  providerName: string;
  updatedAt: string;
}

export interface SalesOrderProgressDto {
  salesOrderId: string;
  salesOrderCode: string;
  status: string;
  customerId: string;
  customerName: string;
  lines: {
    salesOrderItemId: string;
    lineNumber: number;
    qty: string;
    unit: string;
    dispatchedQty: string;
    pendingDispatchQty: string;
    invoicedQty: string;
    pendingInvoiceQty: string;
    itemType: 'PRODUCT' | 'COIL';
    itemId: string;
  }[];
}

// ---------------------------------------------------------------------------
// Clientes facturables
// ---------------------------------------------------------------------------

/**
 * RUC del receptor de los comprobantes de prueba. **Sale de configuración, nunca de
 * código** (`E2E_CUSTOMER_RUC`; en local vive en `apps/api/.env`, igual que las
 * credenciales del admin en `adminCredentials`, y no se imprime nunca).
 *
 * Tiene que ser un RUC **que exista en SUNAT**: uno inventado con dígito verificador
 * correcto vuelve rechazado con `1083 El numero de RUC del receptor no existe` y **gasta un
 * correlativo por intento**. Sin la variable, los escenarios que necesitan una aceptación
 * se saltan en vez de quemar numeración a ciegas.
 */
export function invoiceableRucFromEnv(): string | null {
  const fromEnv = process.env.E2E_CUSTOMER_RUC?.trim();
  if (fromEnv) return fromEnv;
  const envPath = resolve(__dirname, '../../apps/api/.env');
  if (!existsSync(envPath)) return null;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^E2E_CUSTOMER_RUC=(.*)$/);
    if (match) {
      const value = match[1]!.trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/**
 * RUC peruano con **dígito verificador correcto** (módulo 11, pesos 5-4-3-2-7-6-5-4-3-2).
 *
 * Ya **no** se usa para emitir: solo como base de `invalidRuc`, que necesita un número bien
 * formado para después romperle el dígito. Para emitir de verdad está `E2E_CUSTOMER_RUC`.
 */
export function validRuc(prefix = '20'): string {
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const body = `${prefix}${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 100)
    .toString()
    .padStart(2, '0')}`.slice(0, 10);
  const sum = weights.reduce((acc, w, i) => acc + w * Number(body[i]), 0);
  const rest = 11 - (sum % 11);
  const check = rest === 10 ? 0 : rest === 11 ? 1 : rest;
  return `${body}${check}`;
}

/** El mismo RUC pero con el dígito verificador **mal**: el PSE lo rechaza siempre (RF-74). */
export function invalidRuc(): string {
  const valid = validRuc();
  const wrong = (Number(valid[10]) + 1) % 10;
  return `${valid.slice(0, 10)}${wrong}`;
}

/**
 * Cliente de prueba al que se le pueden emitir comprobantes que SUNAT acepta.
 *
 * **Reutiliza el que ya exista con ese RUC**: el maestro tiene `@@unique(docType,
 * docNumber)`, así que a partir de la segunda corrida crear otro sería un 409. El nombre
 * lleva el prefijo `E2E ` para que la purga lo reconozca.
 */
export async function createInvoiceableCustomer(
  api: APIRequestContext,
  overrides: { docNumber?: string; creditDays?: number } = {},
): Promise<CustomerDto> {
  // Sin la variable se cae a un RUC bien formado pero inexistente: sirve para todo lo que
  // no depende de una aceptación —que es la mayor parte de la fase y lo único que corre en
  // un entorno sin PSE (D-080)—, y los escenarios de aceptación ya están saltados por
  // `probePse`, así que ese RUC no llega a gastar correlativos buscando un imposible.
  const docNumber = overrides.docNumber ?? invoiceableRucFromEnv() ?? validRuc();
  const existing = (await getJson<CustomerDto[]>(api, '/api/customers')).find(
    (c) => c.docNumber === docNumber,
  );
  if (existing) return existing;
  return postJson<CustomerDto>(api, '/api/customers', {
    docType: 'RUC',
    docNumber,
    name: `E2E Cliente ${String(Date.now()).slice(-6)}`,
    address: 'Av. Prueba 123, Lima',
    creditDays: overrides.creditDays ?? 0,
  });
}

// ---------------------------------------------------------------------------
// Escenario base: bobina recibida + producto por kilo + pedido con reserva
// ---------------------------------------------------------------------------

export interface OrderScenario {
  customer: CustomerDto;
  supplier: CreatedSupplier;
  finish: CreatedFinish;
  purchaseId: string;
  coil: CoilDto;
  product: ProductDto & { listPricePen: string | null };
  order: SalesOrderDto;
  /** La única línea del pedido, que es la que despachan y facturan los tests. */
  item: SalesOrderDto['items'][number];
}

/**
 * Deja un pedido confirmado con reserva viva sobre una bobina, listo para despachar.
 *
 * El producto se vende en **KGM** y la línea reserva exactamente los kilos que vende: es
 * lo que hace que `qty`, `reserveQty` y la salida de kardex sean el mismo número, y que
 * una aserción sobre el saldo de la bobina no dependa de ninguna conversión.
 */
export async function setupOrderScenario(
  api: APIRequestContext,
  options: { coilKg?: string; qty?: string; unitPricePen?: string } = {},
): Promise<OrderScenario> {
  const customer = await createInvoiceableCustomer(api);
  const stock = await setupCoilStock(api, {
    lineCode: DISPATCH_LINE,
    weightKg: options.coilKg ?? '1000',
  });
  const product = await createSellableProduct(api, {
    lineCode: DISPATCH_LINE,
    unit: 'KGM',
    listPricePen: options.unitPricePen ?? '8.0000',
  });
  const qty = options.qty ?? '100';
  const order = await createDirectOrder(api, {
    customerId: customer.id,
    businessLine: DISPATCH_LINE,
    items: [
      {
        productId: product.id,
        qty,
        description: 'E2E plancha vendida por kilo',
        reserveFromCoilId: stock.coil.id,
        reserveKg: qty,
      },
    ],
  });
  expect(order.status).toBe('CONFIRMED');
  expect(order.reservations[0]).toMatchObject({ status: 'ACTIVE', itemId: stock.coil.id });

  return {
    customer,
    supplier: stock.supplier,
    finish: stock.finish,
    purchaseId: stock.purchaseId,
    coil: stock.coil,
    product,
    order,
    item: order.items[0]!,
  };
}

// ---------------------------------------------------------------------------
// Despacho (RF-77..RF-79, D-078)
// ---------------------------------------------------------------------------

/**
 * Cuerpo de `POST /dispatches` con los datos de transporte que exige la modalidad
 * (D-078). Los valores son fijos y marcados: el autocompletado de sugerencias los va a
 * mostrar, y así se reconocen como de prueba.
 */
export function dispatchBody(input: {
  salesOrderId: string;
  items: { salesOrderItemId: string; qty: string; weightKg?: string }[];
  totalWeightKg: string;
  dispatchDate?: string;
  transferMode?: 'PRIVATE' | 'PUBLIC';
  notes?: string;
}): Record<string, unknown> {
  const mode = input.transferMode ?? 'PRIVATE';
  return {
    salesOrderId: input.salesOrderId,
    dispatchDate: input.dispatchDate ?? today(),
    originAddress: 'Av. Almacén 100, Lima',
    destinationAddress: 'Av. Cliente 200, Lima',
    originUbigeo: ORIGIN_UBIGEO,
    destinationUbigeo: DESTINATION_UBIGEO,
    transferMode: mode,
    totalWeightKg: input.totalWeightKg,
    packageCount: 1,
    ...(mode === 'PRIVATE'
      ? {
          vehiclePlate: 'AEE-123',
          // Nombres y apellidos **separados** (D-078): SUNAT los pide así y el PSE
          // rechazaba la guía por apellidos en blanco cuando viajaban en un solo campo.
          driverGivenNames: 'Juan Carlos',
          driverFamilyNames: 'Pérez de Prueba',
          driverDocType: 'DNI',
          driverDocNumber: '44556677',
          driverLicense: 'Q44556677',
        }
      : {
          carrierDocNumber: '20100000001',
          carrierName: 'E2E Transportes',
        }),
    notes: input.notes ?? 'Despacho de prueba E2E',
    items: input.items,
  };
}

/** Despacha las cantidades indicadas del pedido. El peso total es la suma de las líneas. */
export async function dispatchOrder(
  api: APIRequestContext,
  input: {
    salesOrderId: string;
    items: { salesOrderItemId: string; qty: string; weightKg?: string }[];
    transferMode?: 'PRIVATE' | 'PUBLIC';
    dispatchDate?: string;
  },
): Promise<DispatchDto> {
  const totalWeightKg = input.items
    .reduce((acc, i) => acc + Number(i.weightKg ?? i.qty), 0)
    .toFixed(3);
  return postJson<DispatchDto>(api, '/api/dispatches', dispatchBody({ ...input, totalWeightKg }));
}

export async function getDispatch(api: APIRequestContext, id: string): Promise<DispatchDto> {
  return getJson<DispatchDto>(api, `/api/dispatches/${id}`);
}

export async function issueDispatchNote(
  api: APIRequestContext,
  dispatchId: string,
): Promise<FiscalDocumentDto> {
  return postJson<FiscalDocumentDto>(api, `/api/dispatches/${dispatchId}/dispatch-note`);
}

export async function orderProgress(
  api: APIRequestContext,
  salesOrderId: string,
): Promise<SalesOrderProgressDto> {
  return getJson<SalesOrderProgressDto>(api, `/api/invoicing/orders/${salesOrderId}/progress`);
}

// ---------------------------------------------------------------------------
// Comprobantes (RF-70, RF-74..RF-76)
// ---------------------------------------------------------------------------

export interface InvoiceLineInput {
  salesOrderItemId?: string;
  productId?: string;
  description?: string;
  qty: string;
  unit?: string;
  unitPricePen?: string;
}

/** Borrador de comprobante. No toma correlativo ni habla con el PSE (D-072). */
export async function createInvoice(
  api: APIRequestContext,
  input: {
    docType: 'FACTURA' | 'BOLETA';
    customerId: string;
    salesOrderId?: string;
    items: InvoiceLineInput[];
    issueDate?: string;
    paymentTerms?: 'CONTADO' | 'CREDITO';
    dueDate?: string;
    forceGenericCustomer?: boolean;
    notes?: string;
  },
): Promise<FiscalDocumentDto> {
  return postJson<FiscalDocumentDto>(api, '/api/invoicing/documents', invoiceBody(input));
}

/** El mismo cuerpo que manda el web; suelto, para los casos que esperan un error. */
export function invoiceBody(input: {
  docType: 'FACTURA' | 'BOLETA';
  customerId: string;
  salesOrderId?: string;
  items: InvoiceLineInput[];
  issueDate?: string;
  paymentTerms?: 'CONTADO' | 'CREDITO';
  dueDate?: string;
  forceGenericCustomer?: boolean;
  notes?: string;
}): Record<string, unknown> {
  return {
    docType: input.docType,
    customerId: input.customerId,
    ...(input.salesOrderId === undefined ? {} : { salesOrderId: input.salesOrderId }),
    issueDate: input.issueDate ?? today(),
    paymentTerms: input.paymentTerms ?? 'CONTADO',
    ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
    ...(input.forceGenericCustomer === undefined
      ? {}
      : { forceGenericCustomer: input.forceGenericCustomer }),
    // Marca de prueba en observaciones: es lo único por lo que la purga reconoce un
    // comprobante que no sale a nombre de un cliente de prueba (la boleta al genérico, o
    // un cliente del maestro reutilizado entre corridas).
    notes: input.notes ?? 'E2E comprobante de prueba',
    items: input.items,
  };
}

/** Línea libre de venta directa, ya marcada como dato de prueba. */
export function freeLine(qty: string, unitPricePen: string, label = 'servicio'): InvoiceLineInput {
  return {
    description: `E2E ${label}`,
    qty,
    unit: 'NIU',
    unitPricePen,
  };
}

export async function sendDocument(api: APIRequestContext, id: string): Promise<FiscalDocumentDto> {
  return postJson<FiscalDocumentDto>(api, `/api/invoicing/documents/${id}/send`);
}

export async function getDocument(api: APIRequestContext, id: string): Promise<FiscalDocumentDto> {
  return getJson<FiscalDocumentDto>(api, `/api/invoicing/documents/${id}`);
}

/** Emite el borrador y devuelve el documento ya enviado (aceptado, rechazado o con error). */
export async function createAndSend(
  api: APIRequestContext,
  input: Parameters<typeof createInvoice>[1],
): Promise<FiscalDocumentDto> {
  const draft = await createInvoice(api, input);
  expect(draft.status).toBe('DRAFT');
  expect(draft.number, 'un borrador no toma correlativo (D-072)').toBeNull();
  return sendDocument(api, draft.id);
}

/**
 * Espera a que el documento llegue a alguno de los estados pedidos. El PSE contesta en la
 * misma llamada en el caso feliz; esto solo cubre el rezago de una consulta con ticket.
 */
export async function waitForStatus(
  api: APIRequestContext,
  id: string,
  wanted: FiscalDocumentStatus[],
  options: { attempts?: number; kick?: () => Promise<unknown> } = {},
): Promise<FiscalDocumentDto> {
  let document = await getDocument(api, id);
  const attempts = options.attempts ?? 4;
  for (let i = 0; i < attempts && !wanted.includes(document.status); i += 1) {
    if (options.kick) await options.kick();
    else await api.post(`/api/invoicing/documents/${id}/refresh`).catch(() => undefined);
    document = await getDocument(api, id);
  }
  return document;
}

/**
 * Consulta al PSE hasta que el documento deje de estar esperando a SUNAT.
 *
 * Boletas, guías y bajas van por el camino **asíncrono** de SUNAT: el PSE las recibe y
 * contesta sin veredicto, así que el documento se queda `ISSUED` y hay que preguntar
 * después. Que siga pendiente tras varios intentos **no es un fallo** —SUNAT puede tardar—;
 * lo que sí sería un fallo es que volviera `REJECTED` sin motivo, que era el defecto.
 */
export async function settleWithPse(
  api: APIRequestContext,
  id: string,
  options: { attempts?: number } = {},
): Promise<FiscalDocumentDto> {
  let document = await getDocument(api, id);
  const attempts = options.attempts ?? 3;
  for (
    let i = 0;
    i < attempts && (document.status === 'ISSUED' || document.status === 'SEND_ERROR');
    i += 1
  ) {
    await api.post(`/api/invoicing/documents/${id}/refresh`).catch(() => undefined);
    document = await getDocument(api, id);
  }
  return document;
}

/**
 * Un documento que salió al PSE no puede estar rechazado sin motivo. Con veredicto queda
 * aceptado; sin veredicto, esperando. Las dos cosas son válidas; "rechazado" a secas no.
 */
export function expectNotRejected(document: FiscalDocumentDto, label: string): void {
  expect(
    document.status,
    `${label} volvió rechazado: ${document.rejectionCode ?? 'sin código'} — ${document.rejectionMessage ?? 'sin motivo'}`,
  ).not.toBe('REJECTED');
  expect(['ISSUED', 'ACCEPTED'], `${label} quedó en ${document.status}`).toContain(document.status);
}

/**
 * Comunica la baja de un comprobante aceptado (RF-75), con **un reintento**.
 *
 * **El reintento no es una tirita: es cómo funciona la comunicación de baja.** SUNAT las
 * presenta en un **archivo por día** (el resumen `RA-…`), así que la segunda baja de la
 * misma jornada choca con la primera y el PSE contesta, literal:
 *
 * > `El archivo de comunicacion de baja ya fue presentado anteriormente | El doc ya fue
 * > presentado anteriormente`
 *
 * Al segundo intento entra, porque el PSE presenta un archivo nuevo. Quien venga a
 * "simplificar" esto dejando un solo intento va a ver fallar la baja un día sí y otro
 * también, sin entender por qué. Se devuelve el detalle de los intentos para que el test
 * pueda informar cuál funcionó.
 */
export async function voidDocument(
  api: APIRequestContext,
  id: string,
  reason = 'Baja de prueba E2E',
): Promise<{ ok: boolean; attempts: number; lastError: string }> {
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const res = await api.post(`/api/invoicing/documents/${id}/void`, { data: { reason } });
    if (res.ok()) return { ok: true, attempts: attempt, lastError: '' };
    lastError = await res.text();
  }
  return { ok: false, attempts: 2, lastError };
}

/** Nota de crédito (RF-76). Sin `items` es total; con `items`, parcial. */
export async function createCreditNote(
  api: APIRequestContext,
  affectedId: string,
  input: {
    reason: string;
    items?: { affectedItemId: string; qty: string }[];
    issueDate?: string;
    notes?: string;
  },
): Promise<FiscalDocumentDto> {
  return postJson<FiscalDocumentDto>(api, `/api/invoicing/documents/${affectedId}/credit-note`, {
    reason: input.reason,
    issueDate: input.issueDate ?? today(),
    ...(input.items === undefined ? {} : { items: input.items }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  });
}

// ---------------------------------------------------------------------------
// Cobranza (RF-86..RF-88)
// ---------------------------------------------------------------------------

export async function addPayment(
  api: APIRequestContext,
  documentId: string,
  input: { amountPen: string; method?: string; reference?: string; date?: string },
): Promise<FiscalDocumentDto> {
  return postJson<FiscalDocumentDto>(api, `/api/invoicing/documents/${documentId}/payments`, {
    date: input.date ?? today(),
    amountPen: input.amountPen,
    method: input.method ?? 'TRANSFER',
    reference: input.reference ?? 'E2E-COBRO',
  });
}

export async function reversePayment(
  api: APIRequestContext,
  documentId: string,
  paymentId: string,
  reason = 'Reversa de prueba E2E',
): Promise<FiscalDocumentDto> {
  return postJson<FiscalDocumentDto>(
    api,
    `/api/invoicing/documents/${documentId}/payments/${paymentId}/reverse`,
    { reason },
  );
}

// ---------------------------------------------------------------------------
// Configuración y contingencia (D-073)
// ---------------------------------------------------------------------------

export async function invoicingSettings(api: APIRequestContext): Promise<InvoicingSettingsDto> {
  return getJson<InvoicingSettingsDto>(api, '/api/invoicing/settings');
}

/** Interruptor de contingencia manual (D-073). Devuelve la configuración resultante. */
export async function setProviderOffline(
  api: APIRequestContext,
  providerOffline: boolean,
): Promise<InvoicingSettingsDto> {
  const res = await api.patch('/api/invoicing/settings', { data: { providerOffline } });
  if (!res.ok()) {
    throw new Error(`PATCH /invoicing/settings falló: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as InvoicingSettingsDto;
}

export async function sendPending(api: APIRequestContext): Promise<{ sent: number }> {
  return postJson<{ sent: number }>(api, '/api/invoicing/send-pending');
}

// ---------------------------------------------------------------------------
// Series del punto de emisión (D-072)
// ---------------------------------------------------------------------------

export interface FiscalSeriesDto {
  id: string;
  docType: 'FACTURA' | 'BOLETA' | 'NOTA_CREDITO' | 'GUIA_REMISION_REMITENTE';
  series: string;
  affectedDocType: string | null;
  correlative: number;
  isActive: boolean;
}

export async function listSeries(api: APIRequestContext): Promise<FiscalSeriesDto[]> {
  return getJson<FiscalSeriesDto[]>(api, '/api/invoicing/series');
}

export async function createSeries(
  api: APIRequestContext,
  input: {
    docType: FiscalSeriesDto['docType'];
    series: string;
    affectedDocType?: string;
    correlative?: number;
  },
): Promise<FiscalSeriesDto> {
  return postJson<FiscalSeriesDto>(api, '/api/invoicing/series', input);
}

export async function setSeriesActive(
  api: APIRequestContext,
  id: string,
  isActive: boolean,
): Promise<FiscalSeriesDto> {
  const res = await api.patch(`/api/invoicing/series/${id}`, { data: { isActive } });
  if (!res.ok()) {
    throw new Error(`PATCH /invoicing/series/${id} falló: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as FiscalSeriesDto;
}

/**
 * Código de serie de prueba, único por milisegundo: `Z` + tres alfanuméricos, que es el
 * formato de SUNAT. Empieza por `Z` a propósito —ningún tipo de comprobante real usa esa
 * letra— para que una serie de prueba se reconozca de un vistazo en el maestro.
 *
 * **Nunca se emite contra ella**: cada intento fallido contra el PSE quema un correlativo.
 */
export function testSeriesCode(): string {
  return `Z${Date.now().toString(36).slice(-3).toUpperCase()}`;
}

/** El cliente sembrado por la migración (D-077). Nunca se crea ni se edita desde el test. */
export async function genericCustomer(api: APIRequestContext): Promise<CustomerDto> {
  const customers = await getJson<CustomerDto[]>(api, '/api/customers');
  const generic = customers.find((c) => c.docNumber === '00000000');
  expect(
    generic,
    'la migración de 5b siembra el cliente "público en general" (D-077)',
  ).toBeDefined();
  expect(generic!.name).toBe('PÚBLICO EN GENERAL');
  return generic!;
}

// ---------------------------------------------------------------------------
// ¿Se puede gastar numeración fiscal en este entorno?
// ---------------------------------------------------------------------------

/**
 * Permiso para **emitir**, que no es lo mismo que permiso para escribir.
 *
 * El correlativo lo asigna `fiscal_series`, **no el PSE** (D-072): cada emisión de prueba
 * se lleva un número de la serie real y, en un entorno sin PSE, el documento queda en
 * `SEND_ERROR` sin ningún estado terminal al que llevarlo —la baja exige `ACCEPTED`—. Eso
 * son huecos permanentes en la numeración fiscal de la empresa, que es justo lo que D-072
 * existe para evitar. Lo mismo vale para el maestro de series: una corrida que se cae entre
 * el alta y la restauración deja la serie activa apuntando a una de prueba.
 *
 * Mismo criterio que `E2E_ALLOW_WRITES`: **permitido en local y en CI** —bases propias, con
 * su propia numeración— y **apagado contra una URL externa** salvo que alguien lo encienda
 * a mano. Así `pnpm e2e` sigue corriendo la suite entera y `pnpm e2e:prod` no gasta
 * numeración sin tocar ningún script.
 */
export function fiscalEmissionAllowed(): boolean {
  return process.env.E2E_FISCAL_EMISSION === '1' || !process.env.E2E_BASE_URL;
}

/** Motivo del salto, escrito para que el informe diga por qué y no solo que se saltó. */
export const FISCAL_EMISSION_REASON =
  'Emisión fiscal deshabilitada en este entorno: cada comprobante se lleva un correlativo ' +
  'de la serie real y sin PSE no hay forma de darlo de baja (quedaría un hueco permanente ' +
  'en la numeración, D-072). Exporta E2E_FISCAL_EMISSION=1 para habilitarla.';

// ---------------------------------------------------------------------------
// ¿Este entorno puede llegar a un comprobante ACEPTADO?
// ---------------------------------------------------------------------------

export interface PseProbe {
  accepts: boolean;
  reason: string;
}

/**
 * ¿Puede este entorno llegar a un comprobante aceptado?
 *
 * Media Fase 5b —cobrar, acreditar, dar de baja, bloquear la reversa de un despacho— solo
 * ocurre sobre un `ACCEPTED`, y para eso hacen falta **dos cosas independientes**:
 *
 * 1. **Un PSE atado.** Lo dice el propio API en `GET /invoicing/settings`
 *    (`providerConfigured`). Producción corre a propósito **sin credenciales** (D-080): ahí
 *    toda emisión cae en contingencia y ningún documento llega a aceptado, por diseño.
 * 2. **Un receptor que exista en SUNAT** (`E2E_CUSTOMER_RUC`): sin él el PSE responde
 *    `1083 El numero de RUC del receptor no existe` y cada intento gasta un correlativo.
 *
 * La respuesta **no se averigua emitiendo**: una sonda costaba un correlativo por corrida
 * —dos cuando el worker se reiniciaba tras un fallo—. Con esto la misma suite corre en
 * local (con PSE demo), en CI (sin credenciales) y contra producción, y en los tres da el
 * resultado correcto sin fallar por algo que no es un defecto.
 */
export async function probePse(api: APIRequestContext): Promise<PseProbe> {
  const settings = await invoicingSettings(api);
  if (!settings.providerConfigured) {
    return {
      accepts: false,
      reason:
        `Este entorno no tiene PSE configurado (proveedor: ${settings.providerName}): toda ` +
        'emisión cae en contingencia y ningún comprobante llega a aceptado. Los escenarios ' +
        'que dependen de una aceptación no se ejecutan; el resto sí.',
    };
  }
  if (!invoiceableRucFromEnv()) {
    return {
      accepts: false,
      reason:
        'Falta E2E_CUSTOMER_RUC. SUNAT rechaza el comprobante si el RUC del receptor no existe ' +
        '(código 1083) y cada intento gasta un correlativo, así que los escenarios que ' +
        'necesitan una aceptación no se ejecutan.',
    };
  }
  return { accepts: true, reason: '' };
}

// ---------------------------------------------------------------------------
// Limpieza
// ---------------------------------------------------------------------------

export interface InvoicingTrail {
  documentIds?: string[];
  dispatchIds?: string[];
  orderIds?: string[];
  coilIds?: string[];
  purchaseId?: string;
  supplierId?: string;
  finish?: CreatedFinish;
  productIds?: string[];
}

/**
 * Deshace lo que el test dejó vivo, en el **mismo orden que `pnpm prod:purge-e2e`**:
 * cobros → pendientes de envío → notas de crédito → comprobantes → guías → despachos →
 * pedido → bobina → compra.
 * Nunca lanza: es limpieza de `finally`.
 *
 * Un comprobante aceptado no se borra, se da de baja: es un hecho fiscal. Los que no
 * admiten baja (una boleta, o una factura fuera de plazo) se acreditan con una nota total.
 */
export async function purgeInvoicingTrail(
  api: APIRequestContext,
  trail: InvoicingTrail,
): Promise<void> {
  const reason = 'Limpieza de prueba E2E';

  // 1. Cobros vigentes: un comprobante con cobros no se da de baja.
  for (const documentId of trail.documentIds ?? []) {
    const document = await api
      .get(`/api/invoicing/documents/${documentId}`)
      .then((r) => (r.ok() ? (r.json() as Promise<FiscalDocumentDto>) : null))
      .catch(() => null);
    for (const payment of (document?.payments ?? []).filter((p) => p.reversedAt === null)) {
      await reversePayment(api, documentId, payment.id, reason).catch(() => undefined);
    }
  }

  // 2. Los pendientes de envío, **antes** de intentar la baja: un `SEND_ERROR` no se puede
  //    dar de baja (la baja exige un aceptado) y, mientras siga pendiente, también bloquea
  //    la reversa del despacho. Un reintento lo deja en un estado terminal —aceptado o
  //    rechazado— y recién ahí se sabe qué corresponde hacer con él.
  for (const documentId of trail.documentIds ?? []) {
    const document = await api
      .get(`/api/invoicing/documents/${documentId}`)
      .then((r) => (r.ok() ? (r.json() as Promise<FiscalDocumentDto>) : null))
      .catch(() => null);
    if (document?.status !== 'SEND_ERROR' && document?.status !== 'ISSUED') continue;
    await api.post(`/api/invoicing/documents/${documentId}/retry`).catch(() => undefined);
  }

  // 3. Los documentos, notas de crédito primero (el afectado no se da de baja con una viva).
  const documents: FiscalDocumentDto[] = [];
  for (const documentId of trail.documentIds ?? []) {
    const document = await api
      .get(`/api/invoicing/documents/${documentId}`)
      .then((r) => (r.ok() ? (r.json() as Promise<FiscalDocumentDto>) : null))
      .catch(() => null);
    if (document) documents.push(document);
  }
  const rank = (d: FiscalDocumentDto): number =>
    d.docType === 'NOTA_CREDITO' ? 0 : d.docType === 'GUIA_REMISION_REMITENTE' ? 2 : 1;
  for (const document of [...documents].sort((a, b) => rank(a) - rank(b))) {
    if (document.status === 'DRAFT' || document.status === 'VOIDED') continue;
    if (document.status === 'REJECTED') continue;
    // Dos intentos de baja, no uno: contra SUNAT la comunicación de baja **no es
    // instantánea**, así que la primera llamada puede volver sin confirmación aunque la
    // baja haya entrado. El segundo intento la reconoce ("ya fue anulado") y deja el
    // documento anulado. Sin esto la limpieza dejaba comprobantes aceptados vivos.
    let voided = await api
      .post(`/api/invoicing/documents/${document.id}/void`, { data: { reason } })
      .catch(() => undefined);
    if (!voided?.ok()) {
      voided = await api
        .post(`/api/invoicing/documents/${document.id}/void`, { data: { reason } })
        .catch(() => undefined);
    }
    if (voided?.ok()) continue;
    // Sin camino de baja (boleta, o factura fuera de plazo): nota de crédito total.
    if (document.docType === 'FACTURA' || document.docType === 'BOLETA') {
      const note = await api
        .post(`/api/invoicing/documents/${document.id}/credit-note`, {
          data: { reason: 'ANULACION_OPERACION', issueDate: today(), notes: reason },
        })
        .catch(() => undefined);
      if (note?.ok()) {
        const created = (await note.json()) as FiscalDocumentDto;
        await api.post(`/api/invoicing/documents/${created.id}/send`).catch(() => undefined);
      }
    }
  }

  // 4. Despachos: devuelven el stock y bajan el pedido de "atendido".
  for (const dispatchId of trail.dispatchIds ?? []) {
    await api
      .post(`/api/dispatches/${dispatchId}/reverse`, { data: { reason } })
      .catch(() => undefined);
  }

  // 5. Pedidos: anular libera las reservas y desbloquea la bobina.
  for (const orderId of trail.orderIds ?? []) {
    await api
      .post(`/api/sales/orders/${orderId}/cancel`, { data: { reason } })
      .catch(() => undefined);
  }

  // 6. Bobinas, compra y maestros, igual que en las fases anteriores.
  for (const coilId of trail.coilIds ?? []) {
    await api.post(`/api/coils/${coilId}/cancel`, { data: { reason } }).catch(() => undefined);
  }
  await deactivateTrail(api, {
    purchaseId: trail.purchaseId,
    supplierId: trail.supplierId,
    finish: trail.finish,
    productIds: trail.productIds,
  });
}
