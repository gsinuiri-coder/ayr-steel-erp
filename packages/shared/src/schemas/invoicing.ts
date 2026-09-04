import { z } from 'zod';
import { decimalStringSchema, MAX_VALUE, toDecimal, type DecimalInput } from '../decimal';
import {
  CREDIT_NOTE_REASONS,
  DISPATCH_STATUSES,
  FULL_CREDIT_NOTE_REASONS,
  DOC_TYPES,
  FISCAL_DOC_TYPES,
  FISCAL_DOCUMENT_STATUSES,
  FiscalDocType,
  FiscalDocumentStatus,
  INVOICE_DOC_TYPES,
  PAYMENT_METHODS,
  PAYMENT_TERMS,
  TRANSFER_MODES,
  TransferMode,
} from '../enums';
import { reasonSchema } from './coil';
import { businessToday } from './sales';

/**
 * Ciclo fiscal y logístico de Fase 5b (RF-70, RF-74..RF-79, RF-86..RF-89; D-070..D-078).
 *
 * Modelo en una línea: el pedido de 5a se **despacha** (sale del almacén, mueve kardex,
 * cierra el pedido), se **factura** (documento electrónico contra el PSE, por un puerto
 * que no conoce al proveedor) y se **cobra** (saldo por comprobante, con su reversa).
 *
 * Los tres relojes corren por separado a propósito (D-074): facturar no despacha,
 * despachar no cobra, y anular un comprobante no devuelve la mercadería.
 *
 * Todo en soles (D-064). IGV 18 % discriminado, con la misma aritmética que ya usa la
 * cotización (`salesLineTotals` en `./sales`): una sola definición de cómo se suma una
 * línea en todo el proyecto.
 */

// --------------------------------------------------------------------------
// Constantes del dominio
// --------------------------------------------------------------------------

/**
 * Tope de líneas de un comprobante. Emitir toma un correlativo y sube el documento
 * entero al PSE en una sola llamada; el mismo criterio de cota que `MAX_SALES_ITEMS`.
 */
export const MAX_INVOICE_ITEMS = 50;

/** Tope de líneas de un despacho: una por línea del pedido, con el mismo margen. */
export const MAX_DISPATCH_ITEMS = 50;

/**
 * Documento del cliente "público en general" (D-077). El maestro lo trae sembrado con
 * `isSystem: true`; ninguna ruta lo edita ni lo da de baja.
 */
export const GENERIC_CUSTOMER_DOC_NUMBER = '00000000';

/**
 * Tope de SUNAT para una boleta sin cliente identificado (D-077). Por encima, la emisión
 * se detiene pidiendo un cliente real; solo ADMINISTRADOR puede forzarla, y forzarla
 * queda registrada en el comprobante y en la auditoría.
 */
export const GENERIC_CUSTOMER_MAX_TOTAL_PEN = '700.0000';

/**
 * Días calendario dentro de los que una **factura** aceptada se puede dar de baja
 * (comunicación de baja). Pasado el plazo, la única salida es la nota de crédito.
 */
export const VOID_WINDOW_DAYS = 7;

/**
 * Qué camino aplica para deshacer un comprobante aceptado, según su tipo y su antigüedad
 * (D-072). Vive en `@ayr/shared` para que el API lo **aplique** y la UI lo **explique**
 * con la misma regla: si divergieran, el botón diría una cosa y el API haría otra.
 *
 * - `VOID` — comunicación de baja. El documento se da por no emitido.
 * - `CREDIT_NOTE` — nota de crédito. Es la reversa fiscal con efecto económico.
 *
 * Las boletas van siempre por nota de crédito: su baja se comunica por resumen diario,
 * que está fuera de alcance en v1.
 */
export function voidPathFor(
  docType: FiscalDocType,
  issueDate: string,
  today: string,
): 'VOID' | 'CREDIT_NOTE' {
  // Una guía de remisión no tiene importes, así que no hay nota de crédito posible: su
  // única corrección es la comunicación de baja, sin plazo de siete días de por medio.
  if (docType === FiscalDocType.GUIA_REMISION_REMITENTE) return 'VOID';
  if (docType !== FiscalDocType.FACTURA) return 'CREDIT_NOTE';
  const issued = Date.parse(`${issueDate}T00:00:00.000Z`);
  const now = Date.parse(`${today}T00:00:00.000Z`);
  if (Number.isNaN(issued) || Number.isNaN(now)) return 'CREDIT_NOTE';
  const days = Math.floor((now - issued) / 86_400_000);
  return days <= VOID_WINDOW_DAYS ? 'VOID' : 'CREDIT_NOTE';
}

/**
 * Saldo pendiente de un comprobante: total menos lo cobrado vigente menos lo acreditado
 * por notas de crédito aceptadas (D-075). Se **recalcula siempre**, nunca se almacena,
 * exactamente como `purchaseBalance` en compras.
 *
 * Un comprobante anulado no debe nada: la baja lo da por no emitido, así que su saldo es
 * cero aunque tuviera cobros —esos cobros se revierten aparte, y mientras no se hayan
 * revertido siguen siendo dinero recibido, no una deuda del cliente.
 */
export function documentBalance(input: {
  status: FiscalDocumentStatus;
  totalPen: DecimalInput;
  paidPen: DecimalInput;
  creditedPen: DecimalInput;
}): string {
  if (
    input.status === FiscalDocumentStatus.VOIDED ||
    input.status === FiscalDocumentStatus.REJECTED
  ) {
    return '0.0000';
  }
  const balance = toDecimal(input.totalPen)
    .minus(toDecimal(input.paidPen))
    .minus(toDecimal(input.creditedPen));
  return (balance.isNegative() ? toDecimal('0') : balance).toFixed(4);
}

// --------------------------------------------------------------------------
// Schemas de entrada — comprobantes
// --------------------------------------------------------------------------

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD)')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`)), 'Fecha inválida');

/**
 * Días hacia atrás que se admiten como fecha de emisión. SUNAT acepta comunicar un
 * comprobante con algunos días de atraso, pero no meses; y **nunca** uno futuro.
 */
export const MAX_BACKDATED_ISSUE_DAYS = 7;

/**
 * Fecha de emisión válida contra el día de negocio (D-072).
 *
 * Se valida acá y no al enviar por el mismo motivo que el ubigeo: una fecha fuera de
 * ventana vuelve rechazada **con el correlativo ya gastado**, y ese número no se recupera.
 */
function assertIssueDateWindow(issueDate: string, ctx: z.RefinementCtx, path: string[]): void {
  const today = businessToday();
  if (issueDate > today) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: 'La fecha de emisión no puede ser futura',
    });
    return;
  }
  const limit = new Date(`${today}T00:00:00.000Z`);
  limit.setUTCDate(limit.getUTCDate() - MAX_BACKDATED_ISSUE_DAYS);
  if (issueDate < limit.toISOString().slice(0, 10)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `La fecha de emisión no puede tener más de ${MAX_BACKDATED_ISSUE_DAYS} días de atraso`,
    });
  }
}

const qtySchema = decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG });
const moneySchema = decimalStringSchema('MONEY', { positive: true, max: MAX_VALUE.MONEY });
const unitStringSchema = z.string().max(20);

/**
 * Ubigeo INEI: seis dígitos (departamento, provincia, distrito). SUNAT lo exige en la
 * guía de remisión, así que se valida acá y no al emitir: un ubigeo mal escrito que llega
 * al PSE vuelve rechazado con el correlativo ya gastado (D-072).
 */
const ubigeoSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'El ubigeo son seis dígitos (ej: 150101)');

/**
 * Detracción **informativa** (D-075): se captura a mano y viaja al PSE tal cual. El
 * sistema no la calcula ni la valida contra el catálogo 54; capturarla sin calcularla es
 * lo que permite emitir sin inventar un número que después alguien pagaría.
 */
export const detractionSchema = z.object({
  code: z.string().trim().min(1).max(10),
  pct: decimalStringSchema('MM', { positive: true, max: 100 }),
  amountPen: moneySchema,
});
export type DetractionInput = z.infer<typeof detractionSchema>;

/**
 * Línea de un comprobante nuevo.
 *
 * Con `salesOrderItemId` la línea **factura una línea del pedido**: la descripción, la
 * unidad y el precio salen de ahí y solo la cantidad es editable, que es lo que permite
 * facturar parcial. Sin él es una línea libre (un servicio, un flete) y necesita
 * descripción, unidad y precio propios.
 */
export const invoiceItemInputSchema = z
  .object({
    salesOrderItemId: z.string().uuid().optional(),
    productId: z.string().uuid().optional(),
    description: z.string().trim().max(240).optional(),
    qty: qtySchema,
    unit: unitStringSchema.optional(),
    unitPricePen: moneySchema.optional(),
  })
  .superRefine((item, ctx) => {
    if (item.salesOrderItemId !== undefined) return;
    if (!item.description) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['description'],
        message: 'Una línea que no viene del pedido necesita su descripción',
      });
    }
    if (item.unitPricePen === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unitPricePen'],
        message: 'Una línea que no viene del pedido necesita su precio unitario',
      });
    }
  });
export type InvoiceItemInput = z.infer<typeof invoiceItemInputSchema>;

export const createInvoiceSchema = z
  .object({
    /** Solo factura o boleta. La nota de crédito tiene su propia ruta (nace de otra). */
    docType: z.enum(INVOICE_DOC_TYPES, {
      errorMap: () => ({ message: 'Solo se emite factura o boleta' }),
    }),
    customerId: z.string({ required_error: 'El cliente es obligatorio' }).uuid(),
    /** Pedido de origen. Sin él es una venta directa y las líneas van libres. */
    salesOrderId: z.string().uuid().optional(),
    issueDate: isoDateSchema,
    paymentTerms: z.enum(PAYMENT_TERMS).default('CONTADO'),
    /** Solo en crédito. Sin ella, se deriva de `customers.credit_days` (D-075). */
    dueDate: isoDateSchema.optional(),
    detraction: detractionSchema.optional(),
    notes: z.string().trim().max(500).optional(),
    /**
     * D-077: fuerza la boleta a "público en general" por encima del tope de SUNAT. Solo
     * ADMINISTRADOR; el API lo rechaza para cualquier otro rol y lo deja registrado.
     */
    forceGenericCustomer: z.boolean().default(false),
    items: z
      .array(invoiceItemInputSchema)
      .min(1, 'Al menos una línea')
      .max(MAX_INVOICE_ITEMS, `Máximo ${MAX_INVOICE_ITEMS} líneas`),
  })
  .superRefine((input, ctx) => {
    if (input.paymentTerms === 'CONTADO' && input.dueDate !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dueDate'],
        message: 'Una venta al contado no tiene fecha de vencimiento',
      });
    }
    if (input.dueDate !== undefined && input.dueDate < input.issueDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dueDate'],
        message: 'El vencimiento no puede ser anterior a la emisión',
      });
    }
    const fromOrder = input.items.some((i) => i.salesOrderItemId !== undefined);
    if (fromOrder && input.salesOrderId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['salesOrderId'],
        message: 'Hay líneas de un pedido pero el comprobante no dice de cuál',
      });
    }
    // Dos líneas del comprobante sobre la misma línea de pedido: cada una se compararía
    // por separado contra el pendiente y juntas facturarían el doble en una sola petición.
    const seen = new Set<string>();
    for (const [i, item] of input.items.entries()) {
      if (item.salesOrderItemId === undefined) continue;
      if (seen.has(item.salesOrderItemId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', i, 'salesOrderItemId'],
          message: 'La misma línea del pedido está repetida en el comprobante',
        });
      }
      seen.add(item.salesOrderItemId);
    }
    assertIssueDateWindow(input.issueDate, ctx, ['issueDate']);
  });
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

/**
 * Nota de crédito sobre un comprobante aceptado (RF-76). Sin `items` es **total**: copia
 * todas las líneas del afectado. Con `items` es **parcial** y cada una acredita como
 * mucho lo que su línea original todavía tiene sin acreditar.
 */
export const createCreditNoteSchema = z
  .object({
    reason: z.enum(CREDIT_NOTE_REASONS, {
      errorMap: () => ({ message: 'Motivo de nota de crédito inválido' }),
    }),
    issueDate: isoDateSchema,
    notes: z.string().trim().max(500).optional(),
    items: z
      .array(
        z.object({
          affectedItemId: z.string().uuid(),
          qty: qtySchema,
        }),
      )
      .max(MAX_INVOICE_ITEMS, `Máximo ${MAX_INVOICE_ITEMS} líneas`)
      .optional(),
  })
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    for (const [i, item] of (input.items ?? []).entries()) {
      if (seen.has(item.affectedItemId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', i, 'affectedItemId'],
          message: 'La misma línea del comprobante está repetida en la nota de crédito',
        });
      }
      seen.add(item.affectedItemId);
    }
    // Un motivo que describe un ajuste **parcial** sin decir qué líneas acreditar acabaría
    // emitiendo una nota total, que es lo contrario de lo que se pidió.
    if ((input.items ?? []).length === 0 && !FULL_CREDIT_NOTE_REASONS.includes(input.reason)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message:
          'Este motivo acredita una parte: indica las cantidades por línea, o elige un motivo de anulación o devolución total',
      });
    }
    assertIssueDateWindow(input.issueDate, ctx, ['issueDate']);
  });
export type CreateCreditNoteInput = z.infer<typeof createCreditNoteSchema>;

/** Comunicación de baja de un comprobante aceptado (RF-75). Siempre con motivo. */
export const voidDocumentSchema = z.object({ reason: reasonSchema });
export type VoidDocumentInput = z.infer<typeof voidDocumentSchema>;

/** D-073: interruptor de contingencia y umbral de alerta. Solo ADMINISTRADOR. */
export const updateInvoicingSettingsSchema = z.object({
  providerOffline: z.boolean().optional(),
  alertAfterHours: z.number().int().min(1).max(168).optional(),
});
export type UpdateInvoicingSettingsInput = z.infer<typeof updateInvoicingSettingsSchema>;

/**
 * Serie del punto de emisión (D-072).
 *
 * Existe como maestro administrable y no como constante de la migración porque **las series
 * las autoriza el PSE para cada emisor**: la que sirve en una cuenta no sirve en otra, y
 * descubrirlo cuesta un correlativo rechazado por cada intento. Poder alinearlas sin una
 * migración es lo que separa "configurar el sistema" de "desplegar de nuevo".
 */
export const fiscalSeriesSchema = z.object({
  id: z.string().uuid(),
  docType: z.enum(FISCAL_DOC_TYPES),
  series: z.string(),
  /** Solo en series de nota de crédito: el tipo del comprobante que afecta. */
  affectedDocType: z.enum(FISCAL_DOC_TYPES).nullable(),
  /** Último correlativo entregado. `0` = todavía no se emitió ninguno de esta serie. */
  correlative: z.number().int(),
  isActive: z.boolean(),
});
export type FiscalSeriesDto = z.infer<typeof fiscalSeriesSchema>;

export const createFiscalSeriesSchema = z
  .object({
    docType: z.enum(FISCAL_DOC_TYPES, {
      errorMap: () => ({ message: 'Tipo de documento inválido' }),
    }),
    /** Cuatro caracteres, formato SUNAT: letra del tipo + tres alfanuméricos. */
    series: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z][A-Z0-9]{3}$/, 'La serie son cuatro caracteres (ej: F001)'),
    affectedDocType: z.enum(FISCAL_DOC_TYPES).optional(),
    /**
     * Último correlativo ya emitido en esa serie **fuera del sistema**. Se admite al crear
     * para poder continuar una numeración existente sin repetir números; después no se
     * toca, porque bajarlo emitiría dos veces el mismo comprobante.
     */
    correlative: z.number().int().min(0).max(99_999_999).default(0),
  })
  .superRefine((input, ctx) => {
    const isCreditNote = input.docType === 'NOTA_CREDITO';
    if (isCreditNote && input.affectedDocType === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['affectedDocType'],
        message: 'Una serie de nota de crédito tiene que decir a qué tipo de comprobante afecta',
      });
    }
    if (!isCreditNote && input.affectedDocType !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['affectedDocType'],
        message: 'Solo una serie de nota de crédito afecta a otro tipo de comprobante',
      });
    }
  });
export type CreateFiscalSeriesInput = z.infer<typeof createFiscalSeriesSchema>;

/** Activar o desactivar una serie. El correlativo no se edita nunca (ver arriba). */
export const updateFiscalSeriesSchema = z.object({ isActive: z.boolean() });
export type UpdateFiscalSeriesInput = z.infer<typeof updateFiscalSeriesSchema>;

export const invoicingSettingsSchema = z.object({
  providerOffline: z.boolean(),
  alertAfterHours: z.number().int(),
  /** `true` cuando hay credenciales del PSE configuradas; `false` con el proveedor nulo. */
  providerConfigured: z.boolean(),
  providerName: z.string(),
  updatedAt: z.string(),
});
export type InvoicingSettingsDto = z.infer<typeof invoicingSettingsSchema>;

// --------------------------------------------------------------------------
// DTOs — comprobantes
// --------------------------------------------------------------------------

export const fiscalDocumentItemSchema = z.object({
  id: z.string().uuid(),
  lineNumber: z.number().int(),
  productId: z.string().uuid().nullable(),
  productSku: z.string().nullable(),
  description: z.string(),
  qty: z.string(),
  unit: unitStringSchema,
  unitPricePen: z.string(),
  subtotalPen: z.string(),
  igvPen: z.string(),
  totalPen: z.string(),
  salesOrderItemId: z.string().uuid().nullable(),
  affectedItemId: z.string().uuid().nullable(),
  /** Cantidad de esta línea ya acreditada por notas de crédito vigentes. */
  creditedQty: z.string(),
});
export type FiscalDocumentItemDto = z.infer<typeof fiscalDocumentItemSchema>;

export const customerPaymentSchema = z.object({
  id: z.string().uuid(),
  date: z.string(),
  amountPen: z.string(),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  reversedAt: z.string().nullable(),
  reversedByName: z.string().nullable(),
});
export type CustomerPaymentDto = z.infer<typeof customerPaymentSchema>;

export const fiscalDocumentSchema = z.object({
  id: z.string().uuid(),
  docType: z.enum(FISCAL_DOC_TYPES),
  status: z.enum(FISCAL_DOCUMENT_STATUSES),
  /** `F001-00000123`, o null mientras el documento es borrador (D-072). */
  number: z.string().nullable(),
  series: z.string().nullable(),
  correlative: z.number().int().nullable(),
  customerId: z.string().uuid(),
  customerName: z.string(),
  customerDocType: z.enum(DOC_TYPES),
  customerDocNumber: z.string(),
  /** D-077: el cliente es el genérico sembrado. */
  customerIsGeneric: z.boolean(),
  salesOrderId: z.string().uuid().nullable(),
  salesOrderCode: z.string().nullable(),
  dispatchId: z.string().uuid().nullable(),
  dispatchCode: z.string().nullable(),
  affectedDocumentId: z.string().uuid().nullable(),
  affectedDocumentNumber: z.string().nullable(),
  creditNoteReason: z.enum(CREDIT_NOTE_REASONS).nullable(),
  /** El rechazado que este documento corrige (D-072). */
  replacesDocumentId: z.string().uuid().nullable(),
  replacesDocumentNumber: z.string().nullable(),
  /**
   * El documento que corrige a este, si es un rechazado que ya se corrigió.
   *
   * Existe porque sin él un rechazado era un callejón sin salida en la pantalla: el botón
   * de corregir seguía ahí y lo único que producía era un 409 nombrando un documento al
   * que no se podía navegar.
   */
  replacedByDocumentId: z.string().uuid().nullable(),
  replacedByDocumentNumber: z.string().nullable(),
  issueDate: z.string(),
  paymentTerms: z.enum(PAYMENT_TERMS),
  dueDate: z.string().nullable(),
  subtotalPen: z.string(),
  igvPen: z.string(),
  totalPen: z.string(),
  /** Lo cobrado vigente y lo acreditado por NC aceptadas; el saldo sale de los dos. */
  paidPen: z.string(),
  creditedPen: z.string(),
  balancePen: z.string(),
  /** `true` cuando hay saldo y la fecha de vencimiento ya pasó (RF-88). */
  isOverdue: z.boolean(),
  detractionCode: z.string().nullable(),
  detractionPct: z.string().nullable(),
  detractionAmountPen: z.string().nullable(),
  /** D-077: quién forzó la boleta genérica por encima del tope, si alguien lo hizo. */
  genericCustomerOverrideByName: z.string().nullable(),
  notes: z.string().nullable(),
  sunatHash: z.string().nullable(),
  rejectionCode: z.string().nullable(),
  rejectionMessage: z.string().nullable(),
  hasPdf: z.boolean(),
  hasXml: z.boolean(),
  hasCdr: z.boolean(),
  sendAttempts: z.number().int(),
  lastSendError: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  /** D-073: lleva más de `alertAfterHours` emitido sin que el PSE lo acepte. */
  isStalled: z.boolean(),
  /** Camino que corresponde para deshacerlo hoy (D-072). Null si no aplica ninguno. */
  voidPath: z.enum(['VOID', 'CREDIT_NOTE']).nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  issuedAt: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  voidedAt: z.string().nullable(),
  items: z.array(fiscalDocumentItemSchema),
  payments: z.array(customerPaymentSchema),
  /** Notas de crédito emitidas contra este comprobante. */
  creditNotes: z.array(
    z.object({
      id: z.string().uuid(),
      number: z.string().nullable(),
      status: z.enum(FISCAL_DOCUMENT_STATUSES),
      issueDate: z.string(),
      totalPen: z.string(),
    }),
  ),
});
export type FiscalDocumentDto = z.infer<typeof fiscalDocumentSchema>;

export const fiscalDocumentListItemSchema = fiscalDocumentSchema
  .omit({ items: true, payments: true, creditNotes: true })
  .extend({ itemCount: z.number().int() });
export type FiscalDocumentListItemDto = z.infer<typeof fiscalDocumentListItemSchema>;

export const fiscalDocumentQuerySchema = z.object({
  status: z.enum(FISCAL_DOCUMENT_STATUSES).optional(),
  docType: z.enum(FISCAL_DOC_TYPES).optional(),
  customerId: z.string().uuid().optional(),
  salesOrderId: z.string().uuid().optional(),
  /** Solo los que tienen saldo pendiente: la vista de cuentas por cobrar (RF-88). */
  pendingOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === true || v === 'true'),
  search: z.string().trim().max(80).optional(),
});
export type FiscalDocumentQuery = z.infer<typeof fiscalDocumentQuerySchema>;

// --------------------------------------------------------------------------
// Despacho (RF-77..RF-79, D-074, D-078)
// --------------------------------------------------------------------------

export const dispatchItemInputSchema = z.object({
  salesOrderItemId: z.string().uuid(),
  qty: qtySchema,
  /** Peso de la línea para la guía. Sin él, se deriva de la reserva de la línea. */
  weightKg: decimalStringSchema('KG', { max: MAX_VALUE.KG }).optional(),
});
export type DispatchItemInput = z.infer<typeof dispatchItemInputSchema>;

export const createDispatchSchema = z
  .object({
    salesOrderId: z.string({ required_error: 'El pedido es obligatorio' }).uuid(),
    dispatchDate: isoDateSchema,
    originAddress: z.string().trim().min(1, 'La dirección de partida es obligatoria').max(240),
    destinationAddress: z.string().trim().min(1, 'La dirección de llegada es obligatoria').max(240),
    originUbigeo: ubigeoSchema,
    destinationUbigeo: ubigeoSchema,
    transferMode: z.enum(TRANSFER_MODES, {
      errorMap: () => ({ message: 'Modalidad de traslado inválida' }),
    }),
    totalWeightKg: decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG }),
    packageCount: z.number().int().positive().max(9999).optional(),
    vehiclePlate: z.string().trim().max(10).optional(),
    /** Separados porque SUNAT los pide así (D-078): el PSE rechaza la guía sin apellidos. */
    driverGivenNames: z.string().trim().max(80).optional(),
    driverFamilyNames: z.string().trim().max(80).optional(),
    driverDocType: z.enum(DOC_TYPES).optional(),
    driverDocNumber: z.string().trim().max(20).optional(),
    driverLicense: z.string().trim().max(20).optional(),
    carrierDocNumber: z.string().trim().max(20).optional(),
    carrierName: z.string().trim().max(160).optional(),
    notes: z.string().trim().max(500).optional(),
    items: z
      .array(dispatchItemInputSchema)
      .min(1, 'Al menos una línea')
      .max(MAX_DISPATCH_ITEMS, `Máximo ${MAX_DISPATCH_ITEMS} líneas`),
  })
  .superRefine((input, ctx) => {
    // D-078: la modalidad decide qué datos son obligatorios. Se valida acá además de en
    // la base (`dispatches_transport_ck`) para que el formulario lo diga antes de mandar,
    // y para que un `CHECK` violado no salga al usuario como un 500 de Postgres.
    const require = (field: keyof typeof input, message: string): void => {
      if (!input[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
    };
    const forbid = (field: keyof typeof input, message: string): void => {
      if (input[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
    };
    if (input.transferMode === TransferMode.PRIVATE) {
      require('vehiclePlate', 'El traslado privado necesita la placa del vehículo');
      require('driverGivenNames', 'El traslado privado necesita los nombres del conductor');
      require('driverFamilyNames', 'El traslado privado necesita los apellidos del conductor');
      require('driverDocType', 'El traslado privado necesita el documento del conductor');
      require('driverDocNumber', 'El traslado privado necesita el documento del conductor');
      require('driverLicense', 'El traslado privado necesita la licencia del conductor');
      forbid('carrierDocNumber', 'Un traslado privado no lleva transportista');
      forbid('carrierName', 'Un traslado privado no lleva transportista');
    } else {
      require('carrierDocNumber', 'El traslado público necesita el RUC del transportista');
      require('carrierName', 'El traslado público necesita la razón social del transportista');
      forbid('vehiclePlate', 'Un traslado público no lleva vehículo propio');
      forbid('driverGivenNames', 'Un traslado público no lleva conductor propio');
      forbid('driverFamilyNames', 'Un traslado público no lleva conductor propio');
      forbid('driverDocType', 'Un traslado público no lleva conductor propio');
      forbid('driverDocNumber', 'Un traslado público no lleva conductor propio');
      forbid('driverLicense', 'Un traslado público no lleva conductor propio');
    }
    const seen = new Set<string>();
    for (const [i, item] of input.items.entries()) {
      if (seen.has(item.salesOrderItemId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', i, 'salesOrderItemId'],
          message: 'La misma línea del pedido está repetida en el despacho',
        });
      }
      seen.add(item.salesOrderItemId);
    }
  });
export type CreateDispatchInput = z.infer<typeof createDispatchSchema>;

/** Revertir un despacho (RF-79): devuelve stock y estado del pedido. Siempre con motivo. */
export const reverseDispatchSchema = z.object({ reason: reasonSchema });
export type ReverseDispatchInput = z.infer<typeof reverseDispatchSchema>;

export const dispatchItemSchema = z.object({
  id: z.string().uuid(),
  lineNumber: z.number().int(),
  salesOrderItemId: z.string().uuid(),
  productId: z.string().uuid(),
  productSku: z.string(),
  description: z.string(),
  qty: z.string(),
  unit: unitStringSchema,
  /** Cantidad en la unidad del ítem de kardex: lo que realmente salió del almacén. */
  reserveQty: z.string(),
  weightKg: z.string(),
  itemType: z.enum(['PRODUCT', 'COIL']),
  itemId: z.string().uuid(),
});
export type DispatchItemDto = z.infer<typeof dispatchItemSchema>;

export const dispatchSchema = z.object({
  id: z.string().uuid(),
  /** `DES-000123`. Correlativo interno; el fiscal es el de la guía. */
  code: z.string(),
  salesOrderId: z.string().uuid(),
  salesOrderCode: z.string(),
  customerName: z.string(),
  status: z.enum(DISPATCH_STATUSES),
  dispatchDate: z.string(),
  originAddress: z.string(),
  destinationAddress: z.string(),
  originUbigeo: z.string(),
  destinationUbigeo: z.string(),
  transferMode: z.enum(TRANSFER_MODES),
  totalWeightKg: z.string(),
  packageCount: z.number().int().nullable(),
  vehiclePlate: z.string().nullable(),
  driverGivenNames: z.string().nullable(),
  driverFamilyNames: z.string().nullable(),
  driverDocType: z.enum(DOC_TYPES).nullable(),
  driverDocNumber: z.string().nullable(),
  driverLicense: z.string().nullable(),
  carrierDocNumber: z.string().nullable(),
  carrierName: z.string().nullable(),
  notes: z.string().nullable(),
  /** Guía de remisión vigente del despacho (la última no rechazada), si ya se emitió. */
  dispatchNoteId: z.string().uuid().nullable(),
  dispatchNoteNumber: z.string().nullable(),
  dispatchNoteStatus: z.enum(FISCAL_DOCUMENT_STATUSES).nullable(),
  /**
   * Comprobantes aceptados que facturan líneas de este despacho. Mientras haya uno, la
   * reversa está bloqueada (D-074): deshacer una salida que una factura vigente declara
   * dejaría al kardex y a SUNAT contando cosas distintas.
   */
  blockingDocumentNumbers: z.array(z.string()),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  reversedAt: z.string().nullable(),
  reversedByName: z.string().nullable(),
  items: z.array(dispatchItemSchema),
});
export type DispatchDto = z.infer<typeof dispatchSchema>;

export const dispatchListItemSchema = dispatchSchema
  .omit({ items: true, blockingDocumentNumbers: true })
  .extend({ itemCount: z.number().int() });
export type DispatchListItemDto = z.infer<typeof dispatchListItemSchema>;

export const dispatchQuerySchema = z.object({
  status: z.enum(DISPATCH_STATUSES).optional(),
  salesOrderId: z.string().uuid().optional(),
  search: z.string().trim().max(80).optional(),
});
export type DispatchQuery = z.infer<typeof dispatchQuerySchema>;

/**
 * D-078: valores de transporte usados en despachos anteriores. Reemplaza al catálogo de
 * vehículos y conductores, que queda diferido: la sugerencia sale de los datos reales ya
 * cargados y no cuesta una tabla ni un ABM.
 */
export const transportSuggestionsSchema = z.object({
  vehicles: z.array(z.object({ plate: z.string() })),
  drivers: z.array(
    z.object({
      givenNames: z.string(),
      familyNames: z.string(),
      docType: z.enum(DOC_TYPES),
      docNumber: z.string(),
      license: z.string(),
    }),
  ),
  carriers: z.array(z.object({ docNumber: z.string(), name: z.string() })),
  /** Partida más usada: casi siempre el almacén, con su ubigeo. */
  origins: z.array(z.object({ address: z.string(), ubigeo: z.string() })),
});
export type TransportSuggestionsDto = z.infer<typeof transportSuggestionsSchema>;

/**
 * Lo que queda por despachar y por facturar de cada línea de un pedido. Es lo que los
 * dos formularios necesitan para no ofrecer más de lo que hay (D-074).
 */
export const salesOrderProgressSchema = z.object({
  salesOrderId: z.string().uuid(),
  salesOrderCode: z.string(),
  status: z.string(),
  /**
   * El cliente del pedido. Viaja acá para que los formularios no tengan que buscarlo en
   * la lista de pedidos, que está paginada: con un pedido fuera de esa página quedaban
   * sin cliente y sin explicar por qué.
   */
  customerId: z.string().uuid(),
  customerName: z.string(),
  lines: z.array(
    z.object({
      salesOrderItemId: z.string().uuid(),
      lineNumber: z.number().int(),
      productId: z.string().uuid(),
      productSku: z.string(),
      description: z.string(),
      qty: z.string(),
      unit: unitStringSchema,
      unitPricePen: z.string(),
      dispatchedQty: z.string(),
      pendingDispatchQty: z.string(),
      invoicedQty: z.string(),
      pendingInvoiceQty: z.string(),
      /** Par de kardex del que sale el material de esta línea (D-066). */
      itemType: z.enum(['PRODUCT', 'COIL']),
      itemId: z.string().uuid(),
      itemLabel: z.string(),
      reserveQty: z.string(),
      reserveUnit: unitStringSchema,
    }),
  ),
});
export type SalesOrderProgressDto = z.infer<typeof salesOrderProgressSchema>;

// --------------------------------------------------------------------------
// Cobranza (RF-86..RF-88, D-075)
// --------------------------------------------------------------------------

export const createCustomerPaymentSchema = z.object({
  date: isoDateSchema,
  amountPen: moneySchema,
  method: z.enum(PAYMENT_METHODS, {
    errorMap: () => ({ message: 'Medio de pago inválido' }),
  }),
  reference: z.string().trim().max(120).optional(),
});
export type CreateCustomerPaymentInput = z.infer<typeof createCustomerPaymentSchema>;

/** Reversa de un cobro (RF-87). Mismo contrato que la reversa de pago a proveedor. */
export const reverseCustomerPaymentSchema = z.object({ reason: reasonSchema });
export type ReverseCustomerPaymentInput = z.infer<typeof reverseCustomerPaymentSchema>;

/** Cuentas por cobrar agregadas por cliente (RF-88). */
export const receivableSummarySchema = z.object({
  customerId: z.string().uuid(),
  customerName: z.string(),
  customerDocNumber: z.string(),
  documentCount: z.number().int(),
  balancePen: z.string(),
  overduePen: z.string(),
  /** Vencimiento más próximo con saldo; null si todo es al contado sin vencer. */
  nextDueDate: z.string().nullable(),
});
export type ReceivableSummaryDto = z.infer<typeof receivableSummarySchema>;
