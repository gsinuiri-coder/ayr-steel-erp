import { z } from 'zod';

/**
 * C06 — **Rentabilidad de un comprobante** (punto 9 de correcciones 03, versión por factura).
 *
 * Una fila por línea del comprobante y el total, solo para ADMINISTRADOR (nunca en el PDF ni en
 * lo que va a SUNAT). El costo de cada línea sale de una de dos fuentes, y la fila dice cuál:
 *
 * - `COIL_KG` — **Coberturas Aluzinc y bobina entera de Coberturas Aluzinc**: los kilos de
 *   bobina que consumió su producción (o que salieron en su despacho), con el mismo motor de
 *   «Ventas por material» (D-354..D-358). La suma de estas líneas es exactamente lo que el
 *   comprobante aporta a ese reporte.
 * - `DISPATCH_SALE` — **todo lo demás** (reventa, UPVC, drywall, bobina entera de otra línea):
 *   la salida de kardex (`SALE`) de los despachos **declarados** del comprobante, como «Ventas y
 *   margen» (D-242). Nunca el despacho del pedido: D-205.
 *
 * Lo que no tiene costo se dice, nunca se estima (D-243): sin despacho declarado o sin
 * producción todavía es «sin costo aún»; lo no trazable lleva su motivo.
 */
export const DOCUMENT_PROFIT_COST_BASES = ['COIL_KG', 'DISPATCH_SALE'] as const;
export type DocumentProfitCostBasis = (typeof DOCUMENT_PROFIT_COST_BASES)[number];

export const DOCUMENT_PROFIT_COST_BASIS_LABELS: Record<DocumentProfitCostBasis, string> = {
  COIL_KG: 'Kilos de bobina consumidos',
  DISPATCH_SALE: 'Salida del despacho (costo promedio)',
};

/**
 * - `COMPLETE`: toda la línea tiene costo.
 * - `PARTIAL`: una parte tiene costo y el resto no (con su motivo en `note`).
 * - `NO_COST_YET`: todavía no hay de dónde sacar el costo (sin producción, sin despacho declarado).
 * - `UNTRACEABLE`: no se puede trazar (desde stock, sin línea de pedido, sin metros).
 * - `NO_COST`: no tiene costo propio (un servicio; una línea de nota de crédito que no es de
 *   Coberturas Aluzinc —el costo de lo devuelto vuelve por la reversa del despacho—; lo entregado
 *   antes del inventario inicial, D-278).
 */
export const DOCUMENT_PROFIT_LINE_STATUSES = [
  'COMPLETE',
  'PARTIAL',
  'NO_COST_YET',
  'UNTRACEABLE',
  'NO_COST',
] as const;
export type DocumentProfitLineStatus = (typeof DOCUMENT_PROFIT_LINE_STATUSES)[number];

export const DOCUMENT_PROFIT_LINE_STATUS_LABELS: Record<DocumentProfitLineStatus, string> = {
  COMPLETE: 'Completo',
  PARTIAL: 'Parcial',
  NO_COST_YET: 'Sin costo aún',
  UNTRACEABLE: 'No trazable',
  NO_COST: 'Sin costo propio',
};

/** Las cifras de una fila o de un total. `null` = no aplica o sin divisor («—» en pantalla). */
export const documentProfitFiguresSchema = z.object({
  /** Venta sin IGV con costo (la parte trazada). */
  salesPen: z.string(),
  costPen: z.string(),
  profitPen: z.string(),
  /** Utilidad ÷ venta, en puntos; null con venta ≤ 0 (D-244). */
  marginPct: z.string().nullable(),
  metersSold: z.string().nullable(),
  theoreticalKg: z.string().nullable(),
  realKg: z.string().nullable(),
  pricePerKgPen: z.string().nullable(),
  costPerKgPen: z.string().nullable(),
  marginPerKgPen: z.string().nullable(),
  pricePerMeterPen: z.string().nullable(),
  costPerMeterPen: z.string().nullable(),
  marginPerMeterPen: z.string().nullable(),
  /** Costo ÷ cantidad en la unidad de venta; null con cantidad 0 o unidades mezcladas. */
  costPerUnitPen: z.string().nullable(),
});
export type DocumentProfitFiguresDto = z.infer<typeof documentProfitFiguresSchema>;

export const documentProfitLineSchema = documentProfitFiguresSchema.extend({
  itemId: z.string().uuid(),
  documentId: z.string().uuid(),
  documentNumber: z.string().nullable(),
  lineNumber: z.number().int(),
  sku: z.string().nullable(),
  description: z.string(),
  /** Cantidad con signo (una nota de crédito resta) y su unidad de venta. */
  qty: z.string(),
  unit: z.string().nullable(),
  /** Venta sin IGV de la línea entera, con signo. */
  lineSalesPen: z.string(),
  /** La parte de la venta sin costo (0 si toda tiene). */
  uncostedSalesPen: z.string(),
  costBasis: z.enum(DOCUMENT_PROFIT_COST_BASES).nullable(),
  /** Detalle de la base: las bobinas o los despachos de donde sale el costo. */
  costBasisDetail: z.string().nullable(),
  status: z.enum(DOCUMENT_PROFIT_LINE_STATUSES),
  /** El motivo de lo que no tiene costo. */
  note: z.string().nullable(),
});
export type DocumentProfitLineDto = z.infer<typeof documentProfitLineSchema>;

export const documentProfitabilitySchema = z.object({
  documentId: z.string().uuid(),
  documentNumber: z.string().nullable(),
  docType: z.string(),
  /** `false` si el comprobante no es una venta viva (borrador, anulado, guía, archivado). */
  applies: z.boolean(),
  notApplicableReason: z.string().nullable(),
  /** Las líneas del comprobante. */
  lines: z.array(documentProfitLineSchema),
  /** Total de lo que tiene costo. */
  total: documentProfitFiguresSchema,
  /** Venta sin IGV sin costo (sin costo aún, no trazable o sin costo propio). */
  uncostedSalesPen: z.string(),
  /** Solo las líneas de Coberturas Aluzinc: lo que el comprobante aporta a «Ventas por material». */
  materialTotal: documentProfitFiguresSchema,
  /** Notas de crédito vivas que afectan a este comprobante (null si no hay, o si es una NC). */
  credited: z
    .object({
      notes: z.array(z.object({ id: z.string().uuid(), number: z.string().nullable() })),
      lines: z.array(documentProfitLineSchema),
      total: documentProfitFiguresSchema,
      uncostedSalesPen: z.string(),
    })
    .nullable(),
  /** Comprobante menos lo acreditado (null sin notas de crédito). */
  net: documentProfitFiguresSchema.nullable(),
});
export type DocumentProfitabilityDto = z.infer<typeof documentProfitabilitySchema>;

/**
 * El aviso que acompaña a los dos reportes y a esta sección (C06, texto del dueño): por qué la
 * utilidad de «Ventas y margen» puede no coincidir con la de las otras dos.
 */
export const PROFIT_SOURCES_NOTICE =
  'Ventas por material y la Rentabilidad de cada factura costean con los kilos de bobina ' +
  'consumidos. Ventas y margen costea con el costo promedio del producto en el inventario. Por ' +
  'eso la utilidad puede diferir.';
