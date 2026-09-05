import { z } from 'zod';
import {
  Decimal,
  decimalStringSchema,
  MAX_VALUE,
  money,
  roundTo,
  toDecimal,
  toFixedString,
  type DecimalInput,
} from '../decimal';
import {
  BUSINESS_LINES,
  INVENTORY_ITEM_TYPES,
  QUOTATION_STATUSES,
  RESERVATION_STATUSES,
  SALES_ORDER_STATUSES,
} from '../enums';
import { reasonSchema } from './coil';
import { piecesMeters, roofingPiecesSchema, roofingPieceSchema } from './roofing';

/**
 * Ciclo comercial de Fase 5a (RF-61, RF-62, RF-65, RF-69; D-064..D-069).
 *
 * Modelo en una línea: se cotiza (simulación de precio, sin efecto en inventario, D-054),
 * se **confirma** —y ahí, en una sola transacción, nacen el pedido y la reserva— y la
 * reserva descuenta disponible hasta que una OP la consume o alguien la libera.
 *
 * Todo el dominio comercial va **en soles** (D-064): no hay selector de moneda ni tipo de
 * cambio en ventas. El USD existe solo en compras (D-042).
 */

// --------------------------------------------------------------------------
// Constantes y aritmética compartida entre web y API
// --------------------------------------------------------------------------

/** IGV en puntos porcentuales. Fijo en ventas (D-068); en compras es un input (D-030). */
export const IGV_RATE_PCT = '18.0000';

/** Vigencia por defecto de una cotización, en días (D-069). El vendedor la puede cambiar. */
export const DEFAULT_QUOTATION_VALIDITY_DAYS = 7;

/** Tope de vigencia. Una cotización a más de un año no es una cotización. */
export const MAX_QUOTATION_VALIDITY_DAYS = 365;

/**
 * Tope de líneas de una cotización o pedido. Cada línea confirmada abre una reserva con
 * su propio lock de saldo dentro de la transacción de confirmación — mismo motivo por el
 * que el partido (RF-15) y la OP (D-060) topan sus hijas.
 */
export const MAX_SALES_ITEMS = 50;

/**
 * Días desde los que una reserva `ACTIVA` se considera vieja y la lista la marca (D-054:
 * sin vencimiento automático, alerta + liberación manual con permiso de ADMINISTRADOR).
 */
export const RESERVATION_STALE_DAYS = 30;

export interface SalesLineInput {
  qty: DecimalInput;
  unitPricePen: DecimalInput;
}

export interface SalesLineTotals {
  subtotal: Decimal;
  igv: Decimal;
  total: Decimal;
}

/**
 * Totales de una línea: precio sin IGV × cantidad, más IGV. Vive acá y no en el API para
 * que la cotización que el vendedor ve mientras tipea sea exactamente la que el API
 * guarda, igual que las constantes del partido (RF-15) y el kilo por pieza (D-059).
 */
export function salesLineTotals(line: SalesLineInput): SalesLineTotals {
  const subtotal = money(toDecimal(line.qty).times(toDecimal(line.unitPricePen)));
  const igv = money(subtotal.times(toDecimal(IGV_RATE_PCT)).div(100));
  return { subtotal, igv, total: subtotal.plus(igv) };
}

/** Suma de líneas ya calculadas. El total es Σ subtotales + Σ IGV, no Σ totales redondeados. */
export function salesTotals(lines: SalesLineInput[]): SalesLineTotals {
  const totals = lines.map(salesLineTotals);
  const subtotal = totals.reduce((acc, t) => acc.plus(t.subtotal), new Decimal(0));
  const igv = totals.reduce((acc, t) => acc.plus(t.igv), new Decimal(0));
  return { subtotal, igv, total: subtotal.plus(igv) };
}

/**
 * Zona horaria del negocio. La empresa opera en Perú y **todas** las fechas de negocio
 * —emisión, vigencia, vencimiento— son días calendario de Lima, no de UTC.
 */
export const BUSINESS_TIME_ZONE = 'America/Lima';

/**
 * El día de hoy **en Lima**, en `YYYY-MM-DD`.
 *
 * No es un detalle: Lima va cinco horas detrás de UTC, así que entre las 19:00 y la
 * medianoche hora local, `new Date().toISOString()` ya devuelve la fecha del día siguiente.
 * Con eso, una cotización válida "hasta el 10" se rechazaba por vencida durante las últimas
 * cinco horas del día 10, y el pedido nacía fechado el 11. Vive en `@ayr/shared` para que
 * el API, el job de vencimiento y el web usen exactamente la misma noción de "hoy".
 */
export function businessToday(now: Date = new Date()): string {
  // `en-CA` da directamente `YYYY-MM-DD`; `Intl` resuelve el desfase y el horario de verano
  // (que Perú no tiene, pero no hace falta asumirlo).
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** `validUntil` por defecto: `issueDate` + N días, en formato `YYYY-MM-DD`. */
export function defaultValidUntil(
  issueDate: string,
  days: number = DEFAULT_QUOTATION_VALIDITY_DAYS,
): string {
  const d = new Date(`${issueDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD)')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`)), 'Fecha inválida');

const qtySchema = decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG });
const priceSchema = decimalStringSchema('MONEY', { positive: true, max: MAX_VALUE.MONEY });

/**
 * La unidad de un producto es texto libre en el maestro (`products.unit`, VarChar(20)):
 * el catálogo de SUNAT (`Unit`) es la guía, no una restricción, y hay productos cargados
 * por planilla con unidades fuera de él. El DTO la transporta tal cual.
 */
const unitStringSchema = z.string().max(20);

// --------------------------------------------------------------------------
// D-066 — reserva
// --------------------------------------------------------------------------

export const reservationSchema = z.object({
  id: z.string().uuid(),
  salesOrderId: z.string().uuid(),
  salesOrderCode: z.string(),
  salesOrderItemId: z.string().uuid(),
  customerName: z.string(),
  /** Coordenadas del ítem en el kardex: exactamente el par que usa `inventory_balances`. */
  itemType: z.enum(INVENTORY_ITEM_TYPES),
  itemId: z.string().uuid(),
  /** SKU del producto o código de la bobina, según `itemType`. */
  itemLabel: z.string(),
  itemName: z.string(),
  qty: z.string(),
  unit: unitStringSchema,
  status: z.enum(RESERVATION_STATUSES),
  /**
   * Productos que pide el pedido de esta reserva. Es lo que la terminal de planta necesita
   * para ofrecer solo las reservas que la orden a crear puede atender: el API exige que la
   * reserva pertenezca a un pedido que encargó ese mismo producto.
   */
  orderProductIds: z.array(z.string().uuid()),
  /** OP que la consumió, si ya la consumió (D-060: `production_orders.reservation_id`). */
  productionOrderId: z.string().uuid().nullable(),
  productionOrderCode: z.string().nullable(),
  /** `true` cuando lleva `RESERVATION_STALE_DAYS` activa: la alerta de D-054. */
  isStale: z.boolean(),
  createdAt: z.string(),
  consumedAt: z.string().nullable(),
  releasedAt: z.string().nullable(),
});
export type ReservationDto = z.infer<typeof reservationSchema>;

export const reservationQuerySchema = z.object({
  status: z.enum(RESERVATION_STATUSES).optional(),
  itemId: z.string().uuid().optional(),
  salesOrderId: z.string().uuid().optional(),
});
export type ReservationQuery = z.infer<typeof reservationQuerySchema>;

/** Liberación manual de una reserva (D-054): solo ADMINISTRADOR, siempre con motivo. */
export const releaseReservationSchema = z.object({ reason: reasonSchema });
export type ReleaseReservationInput = z.infer<typeof releaseReservationSchema>;

// --------------------------------------------------------------------------
// D-065 — líneas de cotización y de pedido
// --------------------------------------------------------------------------

/**
 * Una línea de cotización o de pedido.
 *
 * `reserveFromCoilId`/`reserveKg` declaran **qué va a reservar** la confirmación cuando
 * el producto se fabrica contra el pedido (coberturas): la reserva cae sobre los kilos de
 * esa bobina, no sobre un producto terminado que todavía no existe. Sin ellos, la reserva
 * es sobre el stock del propio producto, en su unidad de venta (perfiles, trading).
 *
 * Declararlo al cotizar y materializarlo al confirmar es lo que hace que "cotizar no
 * reserva" (D-054) siga siendo cierto sin perder qué material se prometió.
 */
export const salesItemInputSchema = z.object({
  productId: z.string({ required_error: 'El producto es obligatorio' }).uuid(),
  qty: qtySchema,
  /**
   * Precio unitario sin IGV, en soles. Opcional: sin él se usa el precio de lista del
   * maestro. Mandarlo es el override del vendedor (D-068), que queda registrado junto al
   * precio de lista vigente al momento de cotizar.
   */
  unitPricePen: priceSchema.optional(),
  description: z.string().trim().max(240).optional(),
  reserveFromCoilId: z.string().uuid().optional(),
  reserveKg: decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG }).optional(),
  /**
   * D-083: los largos de una cobertura **a medida**. Con ellos, `qty` deja de ser un
   * número que el vendedor tipea y pasa a ser `Σ cantidad × largo` en metros: la línea es
   * compuesta y el precio se cotiza por metro lineal. Sin ellos la línea es simple, que es
   * el caso de un perfil, de una plancha de catálogo y de todo lo de trading.
   */
  pieces: roofingPiecesSchema.optional(),
});
export type SalesItemInput = z.infer<typeof salesItemInputSchema>;

const salesItemsSchema = z
  .array(salesItemInputSchema)
  .min(1, 'Al menos una línea')
  .max(MAX_SALES_ITEMS, `Máximo ${MAX_SALES_ITEMS} líneas`)
  .superRefine((items, ctx) => {
    items.forEach((item, i) => {
      // D-083: con subítems, la cantidad de la línea **es** la suma de los largos. Admitir
      // que difieran dejaría dos verdades sobre lo mismo y el kardex seguiría a una de las
      // dos sin decir cuál. Se comprueba acá para que el web lo diga antes de mandar.
      if (item.pieces !== undefined) {
        const expected = piecesMeters(item.pieces);
        if (!expected.equals(toDecimal(item.qty))) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'qty'],
            message: `Los largos suman ${expected.toFixed(3)} m y la línea dice ${toDecimal(item.qty).toFixed(3)}`,
          });
        }
      }
      // Los dos campos de la reserva de materia prima van juntos o no van: con la bobina
      // sin kilos el API no sabría cuánto prometer, y con kilos sin bobina no sabría de
      // dónde. Se valida acá para que el web lo diga antes de mandar.
      if ((item.reserveFromCoilId === undefined) !== (item.reserveKg === undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'reserveKg'],
          message: 'Para reservar materia prima hacen falta la bobina y los kilos',
        });
      }
    });
  });

export const salesItemSchema = z.object({
  id: z.string().uuid(),
  lineNumber: z.number().int(),
  productId: z.string().uuid(),
  productSku: z.string(),
  productName: z.string(),
  description: z.string(),
  qty: z.string(),
  unit: unitStringSchema,
  /** Precio de lista del maestro al momento de cotizar (D-068). Null si no tenía. */
  listPricePen: z.string().nullable(),
  /** Precio efectivamente cotizado. Difiere del de lista cuando el vendedor lo editó. */
  unitPricePen: z.string(),
  subtotalPen: z.string(),
  igvPen: z.string(),
  totalPen: z.string(),
  /** D-083: los largos de una línea compuesta de cobertura a medida. Vacío en una simple. */
  pieces: z.array(roofingPieceSchema),
  /** Qué reservará (o reservó) esta línea. Ver `salesItemInputSchema`. */
  reserveItemType: z.enum(INVENTORY_ITEM_TYPES),
  reserveItemId: z.string().uuid(),
  reserveItemLabel: z.string(),
  reserveQty: z.string(),
  reserveUnit: unitStringSchema,
});
export type SalesItemDto = z.infer<typeof salesItemSchema>;

// --------------------------------------------------------------------------
// RF-61 — cotización
// --------------------------------------------------------------------------

export const createQuotationSchema = z.object({
  customerId: z.string({ required_error: 'El cliente es obligatorio' }).uuid(),
  businessLine: z.enum(BUSINESS_LINES, {
    errorMap: () => ({ message: 'Línea de negocio inválida' }),
  }),
  issueDate: isoDateSchema,
  validityDays: z
    .number()
    .int()
    .min(1, 'Al menos un día de vigencia')
    .max(MAX_QUOTATION_VALIDITY_DAYS, `Máximo ${MAX_QUOTATION_VALIDITY_DAYS} días`)
    .default(DEFAULT_QUOTATION_VALIDITY_DAYS),
  notes: z.string().trim().max(500).optional(),
  items: salesItemsSchema,
});
export type CreateQuotationInput = z.infer<typeof createQuotationSchema>;

/** Editar una cotización en `BORRADOR` (RF-66). Reemplaza las líneas completas. */
export const updateQuotationSchema = createQuotationSchema.omit({ businessLine: true });
export type UpdateQuotationInput = z.infer<typeof updateQuotationSchema>;

/** Anular una cotización en cualquier estado no confirmado (RF-65). Motivo obligatorio. */
export const cancelQuotationSchema = z.object({ reason: reasonSchema });
export type CancelQuotationInput = z.infer<typeof cancelQuotationSchema>;

export const quotationSchema = z.object({
  id: z.string().uuid(),
  /** `COT-000123`, derivado del correlativo (D-068). */
  code: z.string(),
  customerId: z.string().uuid(),
  customerName: z.string(),
  customerDocNumber: z.string(),
  businessLine: z.enum(BUSINESS_LINES),
  status: z.enum(QUOTATION_STATUSES),
  issueDate: z.string(),
  validUntil: z.string(),
  /** `true` cuando `validUntil` ya pasó, aunque el job todavía no la haya marcado. */
  isExpired: z.boolean(),
  subtotalPen: z.string(),
  igvPen: z.string(),
  totalPen: z.string(),
  notes: z.string().nullable(),
  /** Pedido que nació de confirmarla (D-065). Null mientras no se confirma. */
  salesOrderId: z.string().uuid().nullable(),
  salesOrderCode: z.string().nullable(),
  /** Key del PDF en R2; el archivo se descarga por `GET /sales/quotations/:id/pdf`. */
  pdfKey: z.string().nullable(),
  items: z.array(salesItemSchema),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  emittedAt: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
});
export type QuotationDto = z.infer<typeof quotationSchema>;

export const quotationListItemSchema = quotationSchema.omit({ items: true }).extend({
  itemCount: z.number().int(),
});
export type QuotationListItemDto = z.infer<typeof quotationListItemSchema>;

export const quotationQuerySchema = z.object({
  status: z.enum(QUOTATION_STATUSES).optional(),
  customerId: z.string().uuid().optional(),
  businessLine: z.enum(BUSINESS_LINES).optional(),
  /** Búsqueda por código de cotización o nombre/documento del cliente (RF-84). */
  search: z.string().trim().max(80).optional(),
});
export type QuotationQuery = z.infer<typeof quotationQuerySchema>;

// --------------------------------------------------------------------------
// RF-62 — confirmación y pedido
// --------------------------------------------------------------------------

/**
 * Pedido directo, sin cotización previa (D-065). Solo se admite en líneas cuya cotización
 * es **opcional**; en las que la exigen (coberturas, RF-31) el API lo rechaza.
 */
export const createSalesOrderSchema = createQuotationSchema
  .omit({ validityDays: true })
  .extend({ promisedDeliveryDate: isoDateSchema.optional() });
export type CreateSalesOrderInput = z.infer<typeof createSalesOrderSchema>;

/**
 * Confirmar una cotización (RF-62). `promisedDeliveryDate` es la única entrada del vendedor:
 * D-096 solo la deja fijar en el acto de crear el pedido — antes no hay dónde guardarla (la
 * cotización no es un pedido) y después es de ADMINISTRADOR (`updatePromisedDeliveryDateSchema`).
 */
export const confirmQuotationSchema = z.object({
  promisedDeliveryDate: isoDateSchema.optional(),
});
export type ConfirmQuotationInput = z.infer<typeof confirmQuotationSchema>;

/** Anular un pedido: libera sus reservas activas (D-066). Motivo obligatorio. */
export const cancelSalesOrderSchema = z.object({ reason: reasonSchema });
export type CancelSalesOrderInput = z.infer<typeof cancelSalesOrderSchema>;

// --------------------------------------------------------------------------
// Fase 7 — cola de producción (RF-37, RF-38; D-092..D-096)
// --------------------------------------------------------------------------

/** Prioridad manual excepcional de la cola (D-094): motivo obligatorio en los dos sentidos. */
export const setSalesOrderPrioritySchema = z.object({
  priority: z.boolean(),
  reason: reasonSchema,
});
export type SetSalesOrderPriorityInput = z.infer<typeof setSalesOrderPrioritySchema>;

/** Solo ADMINISTRADOR, y solo después de que el pedido existe (D-096). `null` la borra. */
export const updatePromisedDeliveryDateSchema = z.object({
  promisedDeliveryDate: isoDateSchema.nullable(),
});
export type UpdatePromisedDeliveryDateInput = z.infer<typeof updatePromisedDeliveryDateSchema>;

export const QUEUE_SEMAPHORES = ['VENCIDO', 'PROXIMO', 'A_TIEMPO', 'SIN_FECHA'] as const;
export type QueueSemaphore = (typeof QUEUE_SEMAPHORES)[number];

/**
 * Semáforo de `fechaEntregaPrometida` (D-096). `PROXIMO` es hoy o mañana: la fecha es una
 * columna `DATE` sin hora, así que "menos de 48 h" solo se puede aproximar por calendario.
 * Siempre contra `businessToday()` (D-069) — nunca contra UTC.
 */
export function queueSemaphore(
  promisedDeliveryDate: string | null,
  today: string = businessToday(),
): QueueSemaphore {
  if (promisedDeliveryDate === null) return 'SIN_FECHA';
  if (promisedDeliveryDate < today) return 'VENCIDO';
  const tomorrow = new Date(`${today}T00:00:00.000Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return promisedDeliveryDate <= tomorrow.toISOString().slice(0, 10) ? 'PROXIMO' : 'A_TIEMPO';
}

export const QUEUE_STATUSES = ['EN_COLA', 'EN_PRODUCCION'] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

/**
 * Una fila de la cola (D-093): pedido confirmado, con reserva de bobina activa sobre un
 * producto que se fabrica contra el pedido, y sin OP viva todavía. No es una tabla — se
 * recalcula en cada lectura a partir de `Reservation` + `ProductionOrder`.
 */
export const productionQueueEntrySchema = z.object({
  salesOrderId: z.string().uuid(),
  salesOrderCode: z.string(),
  salesOrderItemId: z.string().uuid(),
  reservationId: z.string().uuid(),
  customerName: z.string(),
  productId: z.string().uuid(),
  productSku: z.string(),
  productName: z.string(),
  /** Subítems (cantidad × largo), copiados o derivados igual que `create()` de la OP (D-084). */
  pieces: z.array(roofingPieceSchema),
  /** Kilos teóricos con la geometría de la bobina reservada al cotizar. `null` si esa bobina ya no existe. */
  theoreticalKg: z.string().nullable(),
  promisedDeliveryDate: z.string().nullable(),
  semaphore: z.enum(QUEUE_SEMAPHORES),
  createdAt: z.string(),
  priority: z.boolean(),
  priorityAt: z.string().nullable(),
  priorityByName: z.string().nullable(),
  priorityReason: z.string().nullable(),
});
export type ProductionQueueEntryDto = z.infer<typeof productionQueueEntrySchema>;

export const salesOrderSchema = z.object({
  id: z.string().uuid(),
  /** `PED-000123`, derivado del correlativo (D-068). */
  code: z.string(),
  quotationId: z.string().uuid().nullable(),
  quotationCode: z.string().nullable(),
  customerId: z.string().uuid(),
  customerName: z.string(),
  customerDocNumber: z.string(),
  businessLine: z.enum(BUSINESS_LINES),
  status: z.enum(SALES_ORDER_STATUSES),
  issueDate: z.string(),
  subtotalPen: z.string(),
  igvPen: z.string(),
  totalPen: z.string(),
  notes: z.string().nullable(),
  items: z.array(salesItemSchema),
  reservations: z.array(reservationSchema),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  promisedDeliveryDate: z.string().nullable(),
  priority: z.boolean(),
  priorityReason: z.string().nullable(),
  priorityByName: z.string().nullable(),
  /** `null` cuando el pedido no tiene nada que fabricar, o ya dejó la cola (D-093). */
  queueStatus: z.enum(QUEUE_STATUSES).nullable(),
});
export type SalesOrderDto = z.infer<typeof salesOrderSchema>;

export const salesOrderListItemSchema = salesOrderSchema
  // `queueStatus` exige leer reservas + su OP viva por pedido (D-093); el listado solo
  // cuenta reservas activas (`activeReservations`) para no pagar ese costo por fila. La
  // cola en sí (`GET /sales/orders/queue`) es la vista barata para eso.
  .omit({ items: true, reservations: true, queueStatus: true })
  .extend({
    itemCount: z.number().int(),
    activeReservations: z.number().int(),
  });
export type SalesOrderListItemDto = z.infer<typeof salesOrderListItemSchema>;

export const salesOrderQuerySchema = z.object({
  status: z.enum(SALES_ORDER_STATUSES).optional(),
  customerId: z.string().uuid().optional(),
  businessLine: z.enum(BUSINESS_LINES).optional(),
  search: z.string().trim().max(80).optional(),
});
export type SalesOrderQuery = z.infer<typeof salesOrderQuerySchema>;

// --------------------------------------------------------------------------
// Material reservable (D-066)
// --------------------------------------------------------------------------

/**
 * Una bobina candidata a respaldar una línea de cotización, con su disponible ya
 * descontado de lo reservado.
 *
 * Existe como ruta propia de `sales` y no como un filtro de `/coils` porque **VENDEDOR no
 * tiene acceso a `/coils`**: esa ruta expone `unitCostPerKg`, `totalCost` y el proveedor,
 * que es justo lo que §3.4 le oculta al vendedor. Acá no viaja ni un campo de costo — solo
 * lo que hace falta para elegir de qué rollo sale el material que se promete.
 */
export const reservableCoilSchema = z.object({
  coilId: z.string().uuid(),
  code: z.string(),
  /** Acabado + espesor (RF-14): con qué material se está comprometiendo la venta. */
  typeKey: z.string(),
  finishCode: z.string(),
  widthMm: z.string(),
  thicknessMm: z.string(),
  /** Saldo físico del kardex. */
  qty: z.string(),
  reservedQty: z.string(),
  availableQty: z.string(),
});
export type ReservableCoilDto = z.infer<typeof reservableCoilSchema>;

export const reservableCoilQuerySchema = z.object({
  businessLine: z.enum(BUSINESS_LINES),
});
export type ReservableCoilQuery = z.infer<typeof reservableCoilQuerySchema>;

// --------------------------------------------------------------------------
// D-067 — consulta de RUC/DNI contra apis.net.pe
// --------------------------------------------------------------------------

/**
 * Resultado de la búsqueda por documento. `found: false` **no es un error**: la captura
 * manual sigue disponible y el formulario no se bloquea (mismo criterio que el fallback
 * del tipo de cambio, D-029). `reason` explica por qué no hubo datos, para que la UI
 * distinga "no existe ese RUC" de "el servicio no respondió".
 */
export const documentLookupSchema = z.object({
  found: z.boolean(),
  docType: z.string(),
  docNumber: z.string(),
  name: z.string().nullable(),
  address: z.string().nullable(),
  reason: z.enum(['OK', 'NOT_FOUND', 'UNAVAILABLE', 'NOT_CONFIGURED']),
});
export type DocumentLookupDto = z.infer<typeof documentLookupSchema>;

/** Serialización de un total de línea a los strings del DTO (D-003). */
export function serializeSalesTotals(totals: SalesLineTotals): {
  subtotalPen: string;
  igvPen: string;
  totalPen: string;
} {
  return {
    subtotalPen: toFixedString(totals.subtotal, 'MONEY'),
    igvPen: toFixedString(totals.igv, 'MONEY'),
    totalPen: toFixedString(totals.total, 'MONEY'),
  };
}

/** Redondeo a kilos de una cantidad de reserva; centraliza la escala (D-003). */
export const reserveQty = (v: DecimalInput): Decimal => roundTo(v, 'KG');
