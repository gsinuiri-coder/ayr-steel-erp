import { expect, type APIRequestContext } from '@playwright/test';
import { inflateSync } from 'node:zlib';
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
  /** D-083: los largos de una línea compuesta de cobertura. Vacío en una línea simple. */
  pieces?: { lineNumber: number; lengthMm: string; qty: number }[];
  description?: string;
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
  status: 'CONFIRMED' | 'IN_PRODUCTION' | 'PARTIALLY_FULFILLED' | 'FULFILLED' | 'CANCELLED';
  subtotalPen: string;
  igvPen: string;
  totalPen: string;
  items: SalesItemDto[];
  reservations: ReservationDto[];
  /** Fase 7 (D-092..D-096): entrada del vendedor al confirmar, editable después por ADMINISTRADOR. */
  promisedDeliveryDate: string | null;
  /** Prioridad manual excepcional de la cola (D-094). */
  priority: boolean;
  priorityReason: string | null;
  priorityByName: string | null;
  /** `null` cuando el pedido no tiene nada que fabricar contra el pedido, o ya salió de la cola. */
  queueStatus: 'EN_COLA' | 'EN_PRODUCCION' | null;
}

/** Una fila de la cola de producción (RF-37, D-092..D-096): `GET /sales/orders/queue`. */
export interface ProductionQueueEntryDto {
  salesOrderId: string;
  salesOrderCode: string;
  salesOrderItemId: string;
  reservationId: string;
  customerName: string;
  productId: string;
  productSku: string;
  productName: string;
  pieces: { lineNumber: number; lengthMm: string; qty: number }[];
  theoreticalKg: string | null;
  promisedDeliveryDate: string | null;
  semaphore: 'VENCIDO' | 'PROXIMO' | 'A_TIEMPO' | 'SIN_FECHA';
  createdAt: string;
  priority: boolean;
  priorityAt: string | null;
  priorityByName: string | null;
  priorityReason: string | null;
}

/** La cola de producción (RF-37): pedidos con reserva de bobina activa y sin OP viva. */
export async function queueOf(api: APIRequestContext): Promise<ProductionQueueEntryDto[]> {
  return getJson<ProductionQueueEntryDto[]>(api, '/api/sales/orders/queue');
}

/** Prioridad manual excepcional de la cola (D-094): motivo obligatorio en los dos sentidos. */
export async function setPriority(
  api: APIRequestContext,
  orderId: string,
  input: { priority: boolean; reason: string },
): Promise<SalesOrderDto> {
  const res = await api.patch(`/api/sales/orders/${orderId}/priority`, { data: input });
  if (!res.ok()) {
    throw new Error(`PATCH orders/${orderId}/priority falló: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as SalesOrderDto;
}

/** Fecha prometida después de creado el pedido (D-096): solo ADMINISTRADOR. `null` la borra. */
export async function setPromisedDeliveryDate(
  api: APIRequestContext,
  orderId: string,
  promisedDeliveryDate: string | null,
): Promise<SalesOrderDto> {
  const res = await api.patch(`/api/sales/orders/${orderId}/promised-delivery-date`, {
    data: { promisedDeliveryDate },
  });
  if (!res.ok()) {
    throw new Error(
      `PATCH orders/${orderId}/promised-delivery-date falló: ${res.status()} ${await res.text()}`,
    );
  }
  return (await res.json()) as SalesOrderDto;
}

/** Igual que `postExpectingError`, pero para los `PATCH` de la cola. */
export async function patchExpectingError(
  api: APIRequestContext,
  path: string,
  data: unknown,
): Promise<{ status: number; message: string }> {
  const res = await api.patch(path, { data });
  expect(res.ok(), `PATCH ${path} debía fallar y devolvió ${res.status()}`).toBe(false);
  const body = (await res.json()) as { message?: string | string[] };
  const message = Array.isArray(body.message) ? body.message.join(', ') : (body.message ?? '');
  return { status: res.status(), message };
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

export interface CoilBatchScenario {
  supplier: CreatedSupplier;
  finish: CreatedFinish;
  purchaseId: string;
  coils: CoilDto[];
}

/**
 * Varias bobinas de la misma línea en **una sola compra**, para las cotizaciones de más de
 * una línea que reservan de rollos distintos. Una compra con N ítems en vez de N compras:
 * el escenario cuesta un tercio contra Neon y la limpieza es una sola anulación.
 *
 * Los pesos llegan en orden y el resultado sale ordenado igual, para que el test pueda
 * decir "de la primera 700 y de la segunda 900" sin adivinar.
 */
export async function setupCoilBatch(
  api: APIRequestContext,
  options: { lineCode: string; weightsKg: string[]; unitPrice?: string },
): Promise<CoilBatchScenario> {
  const supplier = await createCuttingSupplier(api);
  const finish = await createFinish(api);

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
    items: options.weightsKg.map((weightKg, i) => ({
      description: `Bobina E2E Fase 5a #${i + 1} para reservar`,
      qty: weightKg,
      unit: 'KGM',
      unitPrice: options.unitPrice ?? '5',
      finishId: finish.id,
      widthMm: '1200',
      thicknessMm: '0.50',
    })),
  });
  await postJson<PurchaseDto>(api, `/api/purchases/${purchase.id}/receive`);
  const received = await getJson<CoilDto[]>(api, `/api/coils?supplierId=${supplier.id}`);
  expect(received).toHaveLength(options.weightsKg.length);

  // El API no promete un orden concreto: se emparejan por peso, que es lo que el test usa.
  const taken = new Set<string>();
  const coils = options.weightsKg.map((weightKg) => {
    const wanted = `${Number(weightKg).toFixed(0)}.000`;
    const coil = received.find((c) => c.availableKg === wanted && !taken.has(c.id));
    expect(coil, `No se recibió una bobina de ${wanted} kg`).toBeDefined();
    taken.add(coil!.id);
    return coil!;
  });

  return { supplier, finish, purchaseId: purchase.id, coils };
}

/** Una línea de cotización o de pedido, tal como la manda el web. */
export interface SalesLineInput {
  productId: string;
  qty: string;
  unitPricePen?: string;
  description?: string;
  reserveFromCoilId?: string;
  reserveKg?: string;
}

function toLinePayload(line: SalesLineInput): Record<string, unknown> {
  return {
    productId: line.productId,
    qty: line.qty,
    ...(line.unitPricePen === undefined ? {} : { unitPricePen: line.unitPricePen }),
    ...(line.description === undefined ? {} : { description: line.description }),
    ...(line.reserveFromCoilId === undefined
      ? {}
      : { reserveFromCoilId: line.reserveFromCoilId, reserveKg: line.reserveKg }),
  };
}

/** Cotización en borrador con las líneas que se le pasen (D-068: varias líneas). */
export async function createQuotationWithLines(
  api: APIRequestContext,
  input: {
    customerId: string;
    businessLine: string;
    items: SalesLineInput[];
    issueDate?: string;
    validityDays?: number;
  },
): Promise<QuotationDto> {
  return postJson<QuotationDto>(api, '/api/sales/quotations', {
    customerId: input.customerId,
    businessLine: input.businessLine,
    issueDate: input.issueDate ?? today(),
    ...(input.validityDays === undefined ? {} : { validityDays: input.validityDays }),
    items: input.items.map(toLinePayload),
  });
}

/** Cuerpo de un `PUT /sales/quotations/:id` (RF-66: reemplaza las líneas completas). */
export function updateQuotationBody(input: {
  customerId: string;
  items: SalesLineInput[];
  issueDate?: string;
  validityDays?: number;
}): Record<string, unknown> {
  return {
    customerId: input.customerId,
    issueDate: input.issueDate ?? today(),
    ...(input.validityDays === undefined ? {} : { validityDays: input.validityDays }),
    items: input.items.map(toLinePayload),
  };
}

/** Pedido directo con varias líneas (D-065). */
export async function createDirectOrder(
  api: APIRequestContext,
  input: { customerId: string; businessLine: string; items: SalesLineInput[]; issueDate?: string },
): Promise<SalesOrderDto> {
  return postJson<SalesOrderDto>(api, '/api/sales/orders', {
    customerId: input.customerId,
    businessLine: input.businessLine,
    issueDate: input.issueDate ?? today(),
    items: input.items.map(toLinePayload),
  });
}

/** Pedidos vivos de un cliente. Sirve para probar que una confirmación fallida no dejó nada. */
export async function ordersOfCustomer(
  api: APIRequestContext,
  customerId: string,
): Promise<{ id: string; code: string; status: string }[]> {
  return getJson<{ id: string; code: string; status: string }[]>(
    api,
    `/api/sales/orders?customerId=${customerId}`,
  );
}

/** Anula bobinas (limpieza). Nunca lanza: va en `finally`. */
export async function cancelCoils(api: APIRequestContext, coilIds: string[]): Promise<void> {
  for (const coilId of coilIds) {
    await api
      .post(`/api/coils/${coilId}/cancel`, { data: { reason: 'Limpieza de prueba E2E' } })
      .catch(() => undefined);
  }
}

/** `<436f74>` → `Cot`. Los espacios dentro del literal hexadecimal no cuentan. */
function fromHexString(hex: string): string {
  const clean = hex.replace(/\s+/g, '');
  let out = '';
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out += String.fromCharCode(Number.parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

/** `\(` → `(`, `\251` → `©`. Suficiente para los literales que escribe pdfkit. */
function fromLiteralString(literal: string): string {
  return literal.replace(/\\(\d{1,3}|.)/g, (_all, escaped: string) =>
    /^\d{1,3}$/.test(escaped) ? String.fromCharCode(Number.parseInt(escaped, 8)) : escaped,
  );
}

/** Cada cadena dibujada por un operador de texto, en orden. */
function textOperands(content: string): string[] {
  const out: string[] = [];
  const operators =
    /\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^)\\]|\\.)*)\)\s*Tj|<([0-9A-Fa-f\s]*)>\s*Tj/g;
  let match: RegExpExecArray | null;
  while ((match = operators.exec(content)) !== null) {
    if (match[1] !== undefined) {
      // Array con kerning: `[<436f> 40 <54> 0] TJ`. Los números son avances, no texto.
      const parts = /<([0-9A-Fa-f\s]*)>|\(((?:[^)\\]|\\.)*)\)/g;
      let piece: RegExpExecArray | null;
      let joined = '';
      while ((piece = parts.exec(match[1])) !== null) {
        joined +=
          piece[1] !== undefined ? fromHexString(piece[1]) : fromLiteralString(piece[2] ?? '');
      }
      out.push(joined);
    } else if (match[2] !== undefined) {
      out.push(fromLiteralString(match[2]));
    } else {
      out.push(fromHexString(match[3] ?? ''));
    }
  }
  return out;
}

/**
 * Texto dibujado dentro de un PDF de pdfkit.
 *
 * Hacen falta dos pasos y ninguno es opcional: los content streams van **comprimidos** con
 * Flate (buscar la cadena en el buffer crudo no encuentra nada) y, una vez inflados, el
 * texto sale como arrays hexadecimales con kerning —`[<436f> 40 <54> 0] TJ`— así que
 * tampoco aparece literal. Se usa para comprobar el **rótulo de estado** del PDF (D-068):
 * que una cotización anulada o vencida salga marcada y no se pueda reenviar al cliente como
 * si valiera.
 *
 * Cada operador de texto va en su propia línea, para que un `toContain` no pueda casar a
 * caballo entre dos cadenas que en el papel están en sitios distintos.
 */
export function pdfText(buffer: Buffer): string {
  const openTag = Buffer.from('stream');
  const closeTag = Buffer.from('endstream');
  const lines: string[] = [];
  let idx = 0;
  for (;;) {
    const found = buffer.indexOf(openTag, idx);
    if (found === -1) break;
    let start = found + openTag.length;
    if (buffer[start] === 0x0d) start += 1;
    if (buffer[start] === 0x0a) start += 1;
    const end = buffer.indexOf(closeTag, start);
    if (end === -1) break;
    const raw = buffer.subarray(start, end);
    let content: string;
    try {
      content = inflateSync(raw).toString('latin1');
    } catch {
      content = raw.toString('latin1');
    }
    lines.push(...textOperands(content));
    idx = end + closeTag.length;
  }
  return lines.join('\n');
}

/**
 * Fecha ISO desplazada N días respecto de hoy (negativo = pasado), contando desde el día
 * **de Lima** y no de UTC — mismo motivo que `today()`: entre las 19:00 y la medianoche
 * hora local, partir de UTC adelanta un día y una vigencia "hasta mañana" se convierte en
 * "hasta pasado".
 */
export function isoDaysFromToday(days: number): string {
  const d = new Date(`${today()}T00:00:00.000Z`);
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
