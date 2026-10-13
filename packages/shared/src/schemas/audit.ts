import { z } from 'zod';
import { daysBetween } from '../business-date';

/**
 * Visor de auditoría (D-218/RF-S2/M3). Une `audit_log` (RF-95, la fuente general) con los
 * changelogs dedicados que ya existen (`SalesPriceChange` D-187, `ProductListPriceChange`
 * D-217, `FiscalDocumentIssueDateChange` D-211) en una sola forma normalizada — cada fila
 * dice de qué `source` salió, así que una misma corrección de precio que aparezca en
 * `audit_log` (a nivel del documento) y en su changelog dedicado (a nivel de línea) se ve
 * dos veces a propósito, con detalle distinto, nunca como un duplicado oculto.
 */

export const AUDIT_SOURCES = [
  'audit_log',
  'sales_price_change',
  'product_list_price_change',
  'fiscal_document_issue_date_change',
] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

export const AUDIT_SOURCE_LABELS: Record<AuditSource, string> = {
  audit_log: 'Auditoría general',
  sales_price_change: 'Precio de cotización/pedido',
  product_list_price_change: 'Precio de lista',
  fiscal_document_issue_date_change: 'Fecha de comprobante manual',
};

/** Los `entity` que ya se usan en `audit_log` hoy (D-050: lista cerrada, ver ARQUITECTURA). */
export const AUDIT_ENTITY_TYPES = [
  'cash_sessions',
  'coil_splits',
  'coils',
  'colors',
  'customer_payments',
  'customers',
  'cutting_orders',
  'dispatches',
  'exchange_rates',
  'finishes',
  'fiscal_documents',
  'fiscal_series',
  'invoicing_settings',
  'pos_sales',
  'pricing_settings',
  'product_boms',
  'production_orders',
  'products',
  // cc50 (D-638): el resumen de un lote del importador de compras (su id es el del lote).
  'purchase_import_batches',
  'purchases',
  'quotations',
  'reservations',
  'sales_orders',
  'sales_settings',
  'sessions',
  'suppliers',
  'users',
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export const auditEventSchema = z.object({
  /** Único dentro de una `source`, no global — el cursor combina `source` + `id`. */
  id: z.string(),
  source: z.enum(AUDIT_SOURCES),
  occurredAt: z.string(),
  actorId: z.string().uuid().nullable(),
  actorName: z.string().nullable(),
  actorKind: z.enum(['USER', 'SYSTEM']),
  /** Legible («Cancelar pedido», no `sales.order.cancel`) — ver `AUDIT_ACTION_LABELS`. */
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  /**
   * cc48 (D-633): el código legible de la entidad (PED-…, COT-…, el número del comprobante, el
   * código de la bobina, el SKU, el nombre del cliente o del usuario), resuelto al leer. Si la
   * entidad ya no existe, el que el registro guardó en su detalle o «Eliminado · <8 del id>».
   */
  entityCode: z.string().nullable(),
  /** cc48 (D-633): la página de detalle de la entidad, cuando existe y la entidad también. */
  entityHref: z.string().nullable(),
  /** cc48 (D-633): la entidad ya no está en la base. */
  entityDeleted: z.boolean(),
  /** Solo los campos que cambiaron; el visor arma el diff campo por campo desde acá. */
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().nullable(),
});
export type AuditEventDto = z.infer<typeof auditEventSchema>;

/** Rango por defecto: 31 días. Máximo: 12 meses (D-218/M3, el dueño lo pidió acotado). */
export const AUDIT_DEFAULT_RANGE_DAYS = 31;
export const AUDIT_MAX_RANGE_MONTHS = 12;
export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_MAX_PAGE_SIZE = 200;

/**
 * cc48 (D-634, regla del dueño): el buscar por el **texto del detalle** recorre `audit_log` sin
 * índice, y con rangos largos se medía varias veces más lento que la página sin buscar. Se aplica
 * solo con un periodo de hasta 31 días; con uno más largo, el buscar encuentra solo por código
 * legible (que va por el índice de la entidad) y la pantalla lo avisa. Sin fechas, el rango es
 * el de siempre (31 días) salvo el «Historial» de un documento (`widest`, 12 meses, D-635).
 */
export function auditTextSearchApplies(
  from: string | undefined,
  to: string | undefined,
  today: string,
  widest = false,
): boolean {
  if (from === undefined || from === '') return !widest;
  return daysBetween(from, to === undefined || to === '' ? today : to) <= AUDIT_DEFAULT_RANGE_DAYS;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Los `entityType` cuyo adaptador de changelog filtra `entityId` contra una columna
 * `@db.Uuid` (`salesOrderId`/`quotationId`/`productId`/`documentId` en
 * `AuditQueryService`). Un `entityId` que no tiene forma de UUID ahí revienta Postgres con un
 * error de sintaxis, no un 400 de negocio — se valida acá antes de llegar a la consulta.
 */
const AUDIT_UUID_ENTITY_TYPES = ['sales_orders', 'quotations', 'products', 'fiscal_documents'];

/** cc48 (D-634): un texto de la URL vacío o de espacios es «sin filtro». */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v));

/** Los filtros del visor, sin la página: la lista y su Excel (D-634) reciben los mismos. */
const auditFiltersObject = z.object({
  entityType: z.enum(AUDIT_ENTITY_TYPES).optional(),
  entityId: z.string().trim().min(1).max(80).optional(),
  actorId: z.string().uuid().optional(),
  /** cc48 (D-634): la acción exacta (`audit_log.action` o el nombre del changelog). */
  action: optionalText(80),
  /**
   * cc48 (D-634): buscar por el código legible de la entidad (se resuelve a su id por tipo) o por
   * el texto del detalle y del motivo.
   */
  search: optionalText(80),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'from debe ser YYYY-MM-DD')
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'to debe ser YYYY-MM-DD')
    .optional(),
});

/** Las dos reglas del id de entidad, las mismas para la lista y para su Excel. */
function checkAuditEntity(
  q: { entityId?: string; entityType?: string },
  ctx: z.RefinementCtx,
): void {
  if (q.entityId === undefined) return;
  if (q.entityType === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'entityId exige entityType',
      path: ['entityId'],
    });
    return;
  }
  if (AUDIT_UUID_ENTITY_TYPES.includes(q.entityType) && !UUID_RE.test(q.entityId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'entityId debe ser un UUID para este tipo de entidad',
      path: ['entityId'],
    });
  }
}

/** cc48 (D-634): el Excel del visor, con el buscar y los filtros de la pantalla, sin página. */
export const auditExportQuerySchema = auditFiltersObject.superRefine(checkAuditEntity);
export type AuditExportQuery = z.infer<typeof auditExportQuerySchema>;

export const auditQuerySchema = auditFiltersObject
  .extend({
    /** Opaco: `${occurredAt ISO}|${source}|${id}` del último elemento de la página anterior. */
    cursor: z.string().optional(),
    pageSize: z.coerce.number().int().min(1).max(AUDIT_MAX_PAGE_SIZE).default(AUDIT_PAGE_SIZE),
  })
  .superRefine(checkAuditEntity);
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const auditPageSchema = z.object({
  items: z.array(auditEventSchema),
  nextCursor: z.string().nullable(),
  /**
   * cc48 (D-634): el buscar coincidió con más códigos de los que se buscan por tipo: la lista
   * puede quedar corta y la pantalla pide acotar el buscar.
   */
  searchCapped: z.boolean(),
});
export type AuditPageDto = z.infer<typeof auditPageSchema>;
