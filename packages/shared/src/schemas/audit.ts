import { z } from 'zod';

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

export const auditQuerySchema = z
  .object({
    entityType: z.enum(AUDIT_ENTITY_TYPES).optional(),
    entityId: z.string().trim().min(1).max(80).optional(),
    actorId: z.string().uuid().optional(),
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'from debe ser YYYY-MM-DD')
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'to debe ser YYYY-MM-DD')
      .optional(),
    /** Opaco: `${occurredAt ISO}|${source}|${id}` del último elemento de la página anterior. */
    cursor: z.string().optional(),
    pageSize: z.coerce.number().int().min(1).max(AUDIT_MAX_PAGE_SIZE).default(AUDIT_PAGE_SIZE),
  })
  .refine((q) => q.entityId === undefined || q.entityType !== undefined, {
    message: 'entityId exige entityType',
    path: ['entityId'],
  });
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const auditPageSchema = z.object({
  items: z.array(auditEventSchema),
  nextCursor: z.string().nullable(),
});
export type AuditPageDto = z.infer<typeof auditPageSchema>;
