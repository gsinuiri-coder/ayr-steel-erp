import { z } from 'zod';
import { daysBetween } from '../business-date';
import { FISCAL_DOC_TYPES, PAYMENT_TERMS } from '../enums';

/* ------------------------------------------------------------------------------------- *
 * cc25 — Cuentas por cobrar por antigüedad (D-421..D-423, D-427, D-428, D-432).
 *
 * Por cliente y sin pestañas de línea: un comprobante mezcla líneas y el cobro es por
 * comprobante (D-421). El saldo es el de cobranzas, con la misma lectura
 * (`loadCollectibleDocuments` en la API): el total de este reporte es el de las tarjetas de
 * /cobranzas. Saldo a hoy, sin fecha de corte (D-422). Todo en soles (D-427).
 * ------------------------------------------------------------------------------------- */

/** Los tramos de antigüedad, en el orden en que se muestran (D-422). */
export const AGING_BUCKETS = ['CURRENT', 'D1_30', 'D31_60', 'D61_90', 'OVER_90'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const AGING_BUCKET_LABELS: Record<AgingBucket, string> = {
  CURRENT: 'Por vencer',
  D1_30: '1–30 días',
  D31_60: '31–60 días',
  D61_90: '61–90 días',
  OVER_90: 'Más de 90 días',
};

/**
 * Días vencidos de un comprobante a la fecha `today`: hoy menos el vencimiento. Cero o negativo
 * es «por vencer» (el día del vencimiento todavía no está vencido, como en cobranzas).
 */
export function daysOverdue(dueDate: string, today: string): number {
  return daysBetween(dueDate, today);
}

/** El tramo de D-422 para unos días vencidos. */
export function agingBucket(days: number): AgingBucket {
  if (days <= 0) return 'CURRENT';
  if (days <= 30) return 'D1_30';
  if (days <= 60) return 'D31_60';
  if (days <= 90) return 'D61_90';
  return 'OVER_90';
}

export const receivablesAgingQuerySchema = z.object({
  /** D-423: solo los comprobantes de este vendedor (la regla de `documentOwnerId`, D-432). */
  sellerId: z.string().uuid().optional(),
});
export type ReceivablesAgingQuery = z.infer<typeof receivablesAgingQuerySchema>;

const bucketAmountsSchema = z.object({
  CURRENT: z.string(),
  D1_30: z.string(),
  D31_60: z.string(),
  D61_90: z.string(),
  OVER_90: z.string(),
});
export type AgingBucketAmounts = z.infer<typeof bucketAmountsSchema>;

export const receivablesAgingDocumentSchema = z.object({
  id: z.string().uuid(),
  docType: z.enum(FISCAL_DOC_TYPES),
  number: z.string().nullable(),
  issueDate: z.string(),
  paymentTerms: z.enum(PAYMENT_TERMS),
  /** El vencimiento guardado; `null` al contado (D-075). */
  dueDate: z.string().nullable(),
  /** D-428: el vencimiento con el que se mide la antigüedad: `dueDate` o, al contado, la emisión. */
  agingDate: z.string(),
  daysOverdue: z.number().int(),
  bucket: z.enum(AGING_BUCKETS),
  totalPen: z.string(),
  /** Cobros vigentes (sin los revertidos). */
  paidPen: z.string(),
  /** Notas de crédito vivas que lo afectan. */
  creditedPen: z.string(),
  balancePen: z.string(),
  salesOrderId: z.string().uuid().nullable(),
  salesOrderCode: z.string().nullable(),
  sellerId: z.string().uuid(),
  sellerName: z.string().nullable(),
});
export type ReceivablesAgingDocumentDto = z.infer<typeof receivablesAgingDocumentSchema>;

export const receivablesAgingCustomerSchema = z.object({
  customerId: z.string().uuid(),
  customerName: z.string(),
  customerDocNumber: z.string(),
  documentCount: z.number().int(),
  balancePen: z.string(),
  buckets: bucketAmountsSchema,
  /** Del más vencido al que vence más tarde. */
  documents: z.array(receivablesAgingDocumentSchema),
});
export type ReceivablesAgingCustomerDto = z.infer<typeof receivablesAgingCustomerSchema>;

export const receivablesAgingSchema = z.object({
  /** El día de negocio (Lima) contra el que se miden los días vencidos. */
  asOf: z.string(),
  /** El vendedor filtrado; `null` sin filtro. */
  sellerId: z.string().uuid().nullable(),
  /** Los vendedores con algún comprobante con saldo, sin filtrar: las opciones del filtro. */
  sellers: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
  /** De mayor a menor saldo. */
  customers: z.array(receivablesAgingCustomerSchema),
  totals: z.object({
    balancePen: z.string(),
    buckets: bucketAmountsSchema,
    documentCount: z.number().int(),
    customerCount: z.number().int(),
  }),
});
export type ReceivablesAgingDto = z.infer<typeof receivablesAgingSchema>;
