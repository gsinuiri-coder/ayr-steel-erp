import { z } from 'zod';
import { decimalStringSchema } from '../decimal';
import {
  BUSINESS_LINES,
  CURRENCIES,
  EXCHANGE_RATE_SOURCES,
  LANDED_COST_SERVICE_KINDS,
  PAYMENT_METHODS,
  PAYMENT_TERMS,
  PURCHASE_DOC_TYPES,
  PURCHASE_STATUSES,
  PURCHASE_TYPES,
  PurchaseType,
  SERVICE_KINDS,
  UNITS,
} from '../enums';

/** Fecha en formato ISO corto (YYYY-MM-DD), que es como viajan las fechas de negocio. */
export const isoDateSchema = z
  .string({ required_error: 'La fecha es obligatoria' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD)');

export const seriesSchema = z
  .string({ required_error: 'La serie es obligatoria' })
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{1,10}$/, 'Serie inválida (ej: F001)');

export const documentNumberSchema = z
  .string({ required_error: 'El número es obligatorio' })
  .trim()
  .regex(/^[0-9]{1,20}$/, 'El número solo admite dígitos');

// --------------------------------------------------------------------------
// DTOs
// --------------------------------------------------------------------------

export const purchaseItemSchema = z.object({
  id: z.string().uuid(),
  lineNumber: z.number().int(),
  productId: z.string().uuid().nullable(),
  productSku: z.string().nullable(),
  description: z.string(),
  qty: z.string(),
  unit: z.string(),
  unitPrice: z.string(),
  subtotal: z.string(),
  igv: z.string(),
  total: z.string(),
  finishId: z.string().uuid().nullable(),
  finishCode: z.string().nullable(),
  widthMm: z.string().nullable(),
  thicknessMm: z.string().nullable(),
  /** Código de la bobina que esta línea creó al recibirse (null si aún no se recibió). */
  coilCode: z.string().nullable(),
});
export type PurchaseItemDto = z.infer<typeof purchaseItemSchema>;

export const supplierPaymentSchema = z.object({
  id: z.string().uuid(),
  purchaseId: z.string().uuid(),
  date: z.string(),
  amount: z.string(),
  currency: z.enum(CURRENCIES),
  exchangeRate: z.string(),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().nullable(),
  createdAt: z.string(),
});
export type SupplierPaymentDto = z.infer<typeof supplierPaymentSchema>;

export const purchaseSchema = z.object({
  id: z.string().uuid(),
  supplierId: z.string().uuid(),
  supplierName: z.string(),
  supplierCode: z.string(),
  businessLine: z.enum(BUSINESS_LINES),
  type: z.enum(PURCHASE_TYPES),
  docType: z.enum(PURCHASE_DOC_TYPES),
  series: z.string(),
  number: z.string(),
  /** `F001-123`, listo para mostrar. */
  documentLabel: z.string(),
  issueDate: z.string(),
  currency: z.enum(CURRENCIES),
  exchangeRate: z.string(),
  exchangeRateSource: z.enum(EXCHANGE_RATE_SOURCES),
  subtotal: z.string(),
  igv: z.string(),
  total: z.string(),
  totalPen: z.string(),
  paymentTerms: z.enum(PAYMENT_TERMS),
  creditDays: z.number().int().nullable(),
  dueDate: z.string().nullable(),
  status: z.enum(PURCHASE_STATUSES),
  serviceKind: z.enum(SERVICE_KINDS).nullable(),
  /** Landed cost (D-043): compra `COIL` a la que se imputa esta compra de servicio. */
  relatedPurchaseId: z.string().uuid().nullable(),
  relatedPurchaseLabel: z.string().nullable(),
  /** Costo de corte (RF-41): orden de corte a la que se imputa esta compra de servicio. */
  relatedCuttingOrderId: z.string().uuid().nullable(),
  relatedCuttingOrderLabel: z.string().nullable(),
  /** Servicios (flete, aduanas, seguro) ya imputados a esta compra de bobinas. */
  landedCostServices: z.array(
    z.object({
      purchaseId: z.string().uuid(),
      documentLabel: z.string(),
      serviceKind: z.enum(SERVICE_KINDS),
      status: z.enum(PURCHASE_STATUSES),
      /** Monto imputado al kardex, sin IGV y en soles (D-038, D-042). */
      amountPen: z.string(),
    }),
  ),
  sourceXmlKey: z.string().nullable(),
  notes: z.string().nullable(),
  /** Suma de pagos aplicados y saldo pendiente (D-039); calculados, no almacenados. */
  paidAmount: z.string(),
  balance: z.string(),
  receivedAt: z.string().nullable(),
  createdAt: z.string(),
  items: z.array(purchaseItemSchema),
  payments: z.array(supplierPaymentSchema),
});
export type PurchaseDto = z.infer<typeof purchaseSchema>;

/** Fila de la lista central de compras: sin ítems ni pagos, con el saldo ya calculado. */
export const purchaseListItemSchema = purchaseSchema.omit({ items: true, payments: true });
export type PurchaseListItemDto = z.infer<typeof purchaseListItemSchema>;

/** Estado de cuenta de un proveedor (D-039). */
export const supplierStatementSchema = z.object({
  supplierId: z.string().uuid(),
  supplierName: z.string(),
  supplierCode: z.string(),
  /** Total adeudado en soles, sumando el saldo de cada compra a su propio TC. */
  totalBalancePen: z.string(),
  purchases: z.array(
    purchaseListItemSchema.extend({
      balancePen: z.string(),
      /** Días desde el vencimiento; negativo si aún no vence, null si es al contado. */
      overdueDays: z.number().int().nullable(),
    }),
  ),
});
export type SupplierStatementDto = z.infer<typeof supplierStatementSchema>;

// --------------------------------------------------------------------------
// Entradas
// --------------------------------------------------------------------------

const purchaseItemInputSchema = z.object({
  productId: z.string().uuid().optional(),
  description: z
    .string({ required_error: 'La descripción es obligatoria' })
    .trim()
    .min(1, 'La descripción es obligatoria')
    .max(240, 'Máximo 240 caracteres'),
  qty: decimalStringSchema('KG', { positive: true }),
  unit: z.enum(UNITS, { errorMap: () => ({ message: 'Unidad inválida' }) }),
  unitPrice: decimalStringSchema('MONEY', { positive: true }),
  finishId: z.string().uuid().optional(),
  widthMm: decimalStringSchema('MM', { positive: true }).optional(),
  thicknessMm: decimalStringSchema('MM', { positive: true }).optional(),
});
export type PurchaseItemInput = z.infer<typeof purchaseItemInputSchema>;

export const createPurchaseSchema = z
  .object({
    supplierId: z.string({ required_error: 'El proveedor es obligatorio' }).uuid(),
    businessLine: z.enum(BUSINESS_LINES, {
      errorMap: () => ({ message: 'Línea de negocio inválida' }),
    }),
    type: z.enum(PURCHASE_TYPES, { errorMap: () => ({ message: 'Tipo de compra inválido' }) }),
    docType: z.enum(PURCHASE_DOC_TYPES, {
      errorMap: () => ({ message: 'Tipo de comprobante inválido' }),
    }),
    series: seriesSchema,
    number: documentNumberSchema,
    issueDate: isoDateSchema,
    currency: z.enum(CURRENCIES, { errorMap: () => ({ message: 'Moneda inválida' }) }),
    /** Opcional: si no viene, el API resuelve el TC SUNAT del día (D-029). */
    exchangeRate: decimalStringSchema('RATE', { positive: true }).optional(),
    /** Puntos porcentuales de IGV aplicados a todas las líneas (18 estándar, 0 exonerado). */
    igvRate: decimalStringSchema('RATE')
      .refine((v) => Number.parseFloat(v) >= 0 && Number.parseFloat(v) <= 100, {
        message: 'El IGV debe estar entre 0 y 100',
      })
      .default('18.0000'),
    paymentTerms: z.enum(PAYMENT_TERMS, {
      errorMap: () => ({ message: 'Condición de pago inválida' }),
    }),
    creditDays: z.number().int().min(0).max(365).optional(),
    serviceKind: z.enum(SERVICE_KINDS).optional(),
    /**
     * Landed cost (D-043): compra `COIL` a la que se imputa esta compra de servicio.
     * Solo con `serviceKind` FREIGHT/CUSTOMS/INSURANCE; el API valida además que la
     * compra apuntada exista, sea de tipo `COIL` y no esté anulada.
     */
    relatedPurchaseId: z.string().uuid().optional(),
    /**
     * Costo de corte tercerizado (RF-41): orden de corte a la que se imputa esta compra
     * de servicio. Solo con `serviceKind = CUTTING`; el API valida además que la orden
     * exista y no esté totalmente anulada.
     */
    relatedCuttingOrderId: z.string().uuid().optional(),
    /** Solo una key emitida por `POST /purchases/xml/preview`, nunca una ruta arbitraria de R2. */
    sourceXmlKey: z
      .string()
      .trim()
      .regex(/^purchases\/xml\/[0-9a-f-]{36}-[A-Za-z0-9._-]{1,150}$/, 'Referencia de XML inválida')
      .optional(),
    notes: z.string().trim().max(500).optional(),
    items: z
      .array(purchaseItemInputSchema)
      .min(1, 'La compra necesita al menos una línea')
      // La recepción itera línea por línea creando bobinas dentro de una transacción con
      // locks: una compra desmedida alargaría esa transacción y bloquearía el kardex.
      .max(200, 'Una compra admite hasta 200 líneas'),
  })
  .superRefine((d, ctx) => {
    if (d.paymentTerms === 'CREDITO' && (d.creditDays === undefined || d.creditDays <= 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['creditDays'],
        message: 'Una compra al crédito necesita días de crédito',
      });
    }
    if (d.type === PurchaseType.SERVICE && !d.serviceKind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['serviceKind'],
        message: 'Indica qué clase de servicio es',
      });
    }
    if (d.relatedPurchaseId) {
      if (d.type !== PurchaseType.SERVICE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['relatedPurchaseId'],
          message: 'Solo una compra de servicio se imputa al costo de otra compra',
        });
      } else if (!d.serviceKind || !LANDED_COST_SERVICE_KINDS.includes(d.serviceKind)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['relatedPurchaseId'],
          message: 'Solo flete, aduanas o seguro se imputan al costo de las bobinas (D-043)',
        });
      }
      if (d.relatedCuttingOrderId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['relatedCuttingOrderId'],
          message:
            'Un servicio se imputa a una compra de bobinas o a una orden de corte, no a las dos',
        });
      }
    }
    if (d.relatedCuttingOrderId) {
      if (d.type !== PurchaseType.SERVICE || d.serviceKind !== 'CUTTING') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['relatedCuttingOrderId'],
          message: 'Solo un servicio de corte tercerizado se imputa a una orden de corte (RF-41)',
        });
      }
    }
    d.items.forEach((item, index) => {
      if (d.type === PurchaseType.COIL) {
        if (!item.finishId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['items', index, 'finishId'],
            message: 'Cada bobina necesita su acabado',
          });
        }
        if (!item.widthMm) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['items', index, 'widthMm'],
            message: 'Cada bobina necesita su ancho en mm',
          });
        }
        if (!item.thicknessMm) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['items', index, 'thicknessMm'],
            message: 'Cada bobina necesita su espesor en mm',
          });
        }
        if (item.unit !== 'KGM') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['items', index, 'unit'],
            message: 'Las bobinas se compran por kilo (KGM)',
          });
        }
      }
      if (d.type === PurchaseType.FINISHED_GOOD && !item.productId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'productId'],
          message: 'Elige el producto del catálogo que entra a inventario',
        });
      }
    });
  });
export type CreatePurchaseInput = z.infer<typeof createPurchaseSchema>;

/** Filtros de la lista central de compras (D-030). */
export const purchaseQuerySchema = z.object({
  businessLine: z.enum(BUSINESS_LINES).optional(),
  type: z.enum(PURCHASE_TYPES).optional(),
  status: z.enum(PURCHASE_STATUSES).optional(),
  supplierId: z.string().uuid().optional(),
  /** Solo compras con saldo pendiente (D-039). */
  onlyWithBalance: z.coerce.boolean().optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  search: z.string().trim().max(80).optional(),
});
export type PurchaseQuery = z.infer<typeof purchaseQuerySchema>;

/**
 * Preview de una factura de proveedor leída de su XML UBL 2.1 (RF-11). No crea nada:
 * es lo que el usuario revisa y corrige antes de mandar un `createPurchaseSchema`.
 * Rutas y catálogos en `docs/referencias/ubl21-factura.md`.
 */
export const parsedInvoiceLineSchema = z.object({
  lineNumber: z.number().int(),
  description: z.string(),
  sellerItemCode: z.string().nullable(),
  qty: z.string(),
  unit: z.string(),
  unitPrice: z.string(),
  subtotal: z.string(),
  igv: z.string(),
});
export type ParsedInvoiceLineDto = z.infer<typeof parsedInvoiceLineSchema>;

export const invoiceXmlPreviewSchema = z.object({
  /** Key del XML ya guardado en R2; se manda de vuelta al crear la compra. */
  sourceXmlKey: z.string(),
  supplierDocNumber: z.string(),
  supplierName: z.string(),
  /** Proveedor encontrado por RUC, o null si hay que elegirlo/darlo de alta a mano. */
  supplierId: z.string().uuid().nullable(),
  supplierCode: z.string().nullable(),
  docType: z.enum(PURCHASE_DOC_TYPES),
  series: z.string(),
  number: z.string(),
  issueDate: z.string(),
  dueDate: z.string().nullable(),
  currency: z.enum(CURRENCIES),
  paymentTerms: z.enum(PAYMENT_TERMS),
  creditDays: z.number().int().nullable(),
  igvRate: z.string(),
  subtotal: z.string(),
  igv: z.string(),
  total: z.string(),
  lines: z.array(parsedInvoiceLineSchema),
  /** Avisos a mostrar sobre el formulario antes de confirmar. */
  warnings: z.array(z.string()),
});
export type InvoiceXmlPreviewDto = z.infer<typeof invoiceXmlPreviewSchema>;

/**
 * Anular una compra. Si ya fue recibida, el API revierte sus movimientos de kardex
 * (Fase 2b) y exige que ninguna bobina ni producto de la compra tenga movimientos
 * posteriores; el motivo queda en el kardex y en la auditoría.
 */
export const cancelPurchaseSchema = z.object({
  reason: z
    .string({ required_error: 'El motivo es obligatorio' })
    .trim()
    .min(3, 'Explica el motivo en al menos 3 caracteres')
    .max(240, 'Máximo 240 caracteres'),
});
export type CancelPurchaseInput = z.infer<typeof cancelPurchaseSchema>;

/** Pago parcial o total de una compra (D-039). */
export const createSupplierPaymentSchema = z.object({
  date: isoDateSchema,
  amount: decimalStringSchema('MONEY', { positive: true }),
  currency: z.enum(CURRENCIES, { errorMap: () => ({ message: 'Moneda inválida' }) }),
  exchangeRate: decimalStringSchema('RATE', { positive: true }).optional(),
  method: z.enum(PAYMENT_METHODS, { errorMap: () => ({ message: 'Medio de pago inválido' }) }),
  reference: z.string().trim().max(80).optional(),
});
export type CreateSupplierPaymentInput = z.infer<typeof createSupplierPaymentSchema>;
