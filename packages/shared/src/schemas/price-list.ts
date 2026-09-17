import { z } from 'zod';
import { decimalStringSchema, MAX_VALUE } from '../decimal';
import { idempotencyKeySchema } from './idempotency';

/**
 * Precio de lista de catálogo (D-068, D-217/RF-S1/M1): el historial de cambios, el aviso de
 * piso al editar y la carga masiva por xlsx. `products.list_price_pen` en sí sigue viviendo
 * en `schemas/product.ts` — esto es todo lo que se construyó **alrededor** de ese campo.
 */

// ---------------------------------------------------------------------------
// Historial (changelog)
// ---------------------------------------------------------------------------

export const PRICE_LIST_CHANGE_ORIGINS = ['INLINE', 'IMPORT'] as const;
export type PriceListChangeOrigin = (typeof PRICE_LIST_CHANGE_ORIGINS)[number];

export const productListPriceChangeSchema = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  sku: z.string(),
  productName: z.string(),
  /** Sin IGV (D-068). `null` cuando el producto no tenía precio de lista antes. */
  beforeValuePen: z.string().nullable(),
  /** `null` cuando el cambio quita el precio de lista (vuelve a "sin precio"). */
  afterValuePen: z.string().nullable(),
  changedById: z.string().uuid(),
  changedByName: z.string(),
  changedAt: z.string(),
  origin: z.enum(PRICE_LIST_CHANGE_ORIGINS),
  /** Solo con `origin: 'IMPORT'`. */
  batchId: z.string().uuid().nullable(),
  /** Cuando esta fila es la reversa de un lote: qué lote deshizo. */
  revertsBatchId: z.string().uuid().nullable(),
});
export type ProductListPriceChangeDto = z.infer<typeof productListPriceChangeSchema>;

// ---------------------------------------------------------------------------
// Piso (D-163), para el aviso al editar en línea
// ---------------------------------------------------------------------------

export const priceListFloorSchema = z.object({
  /** Con IGV, en la unidad de venta del SKU. `null` sin costo en el kardex (D-163: sin
   *  costo no hay piso) o sin margen mínimo configurado para la línea. */
  minPricePen: z.string().nullable(),
  priceUnitLabel: z.string().nullable(),
});
export type PriceListFloorDto = z.infer<typeof priceListFloorSchema>;

// ---------------------------------------------------------------------------
// Resumen agregado (RF-S3/M4, sacrificable): tarjeta del Panel «SKUs con lista bajo piso»
// ---------------------------------------------------------------------------

export const priceListFloorSummaryItemSchema = z.object({
  productId: z.string().uuid(),
  sku: z.string(),
  name: z.string(),
  /** Con IGV, en la unidad de venta del SKU — como se lee en el catálogo (D-162). */
  listPricePen: z.string(),
  minPricePen: z.string(),
  priceUnitLabel: z.string(),
});
export type PriceListFloorSummaryItemDto = z.infer<typeof priceListFloorSummaryItemSchema>;

export const priceListFloorSummarySchema = z.object({
  /** SKU activos con precio de lista cargado — el universo sobre el que se calculó. */
  totalWithListPrice: z.number().int(),
  /** Sin costo en el kardex o sin margen mínimo configurado (D-163: sin piso, no es infractor). */
  withoutFloor: z.number().int(),
  /** De más lejos del piso a menos, igual que `check:price-floor` (D-224). */
  belowFloor: z.array(priceListFloorSummaryItemSchema),
});
export type PriceListFloorSummaryDto = z.infer<typeof priceListFloorSummarySchema>;

// ---------------------------------------------------------------------------
// Carga masiva — preview (M1c)
// ---------------------------------------------------------------------------

export const PRICE_LIST_IMPORT_ROW_STATUSES = [
  'NEW',
  'CHANGED',
  'UNCHANGED',
  'WARNING',
  'ERROR',
] as const;
export type PriceListImportRowStatus = (typeof PRICE_LIST_IMPORT_ROW_STATUSES)[number];

export const priceListImportRowSchema = z.object({
  rowNumber: z.number().int(),
  /** Tal como vino en el archivo, para poder mostrar la fila aunque el SKU no exista. */
  sku: z.string(),
  /** Tal como vino en el archivo (texto libre): puede no ser un número. */
  priceWithIgvPen: z.string(),
  productId: z.string().uuid().nullable(),
  productName: z.string().nullable(),
  /** Sin IGV, lo que hay hoy en `products.list_price_pen`. */
  beforeValuePen: z.string().nullable(),
  /** Sin IGV, derivado de `priceWithIgvPen`. `null` si la fila es `ERROR`. */
  afterValuePen: z.string().nullable(),
  status: z.enum(PRICE_LIST_IMPORT_ROW_STATUSES),
  message: z.string().nullable(),
});
export type PriceListImportRowDto = z.infer<typeof priceListImportRowSchema>;

export const priceListImportPreviewSchema = z.object({
  rows: z.array(priceListImportRowSchema),
  summary: z.object({
    new: z.number().int(),
    changed: z.number().int(),
    unchanged: z.number().int(),
    warnings: z.number().int(),
    errors: z.number().int(),
  }),
});
export type PriceListImportPreviewDto = z.infer<typeof priceListImportPreviewSchema>;

// ---------------------------------------------------------------------------
// Carga masiva — confirmar (M1c)
// ---------------------------------------------------------------------------

/**
 * Lo que el navegador manda a confirmar es lo que el usuario ya revisó en el preview
 * (mismo criterio que D-152, el importador de cotizaciones): sin lote ni archivo que
 * releer del lado del servidor, cada fila trae su producto y su valor ya derivados.
 */
export const confirmPriceListImportSchema = z.object({
  rows: z
    .array(
      z.object({
        productId: z.string().uuid(),
        afterValuePen: decimalStringSchema('MONEY', { positive: true, max: MAX_VALUE.MONEY }),
      }),
    )
    .min(1, 'No hay filas para confirmar')
    // Mismo tope que `parseSpreadsheet` (`apps/api/src/imports/parse-spreadsheet.ts`) le
    // aplica al archivo: acá el límite de negocio no puede depender solo del que el body
    // parser de Express imponga por tamaño de payload.
    .max(2000, 'Máximo 2000 filas por confirmación'),
  idempotencyKey: idempotencyKeySchema.optional(),
});
export type ConfirmPriceListImportInput = z.infer<typeof confirmPriceListImportSchema>;

export const priceListImportResultSchema = z.object({
  batchId: z.string().uuid(),
  changed: z.number().int(),
});
export type PriceListImportResultDto = z.infer<typeof priceListImportResultSchema>;

// ---------------------------------------------------------------------------
// Revertir un lote (M1c)
// ---------------------------------------------------------------------------

export const revertPriceListImportSchema = z.object({
  idempotencyKey: idempotencyKeySchema.optional(),
});
export type RevertPriceListImportInput = z.infer<typeof revertPriceListImportSchema>;

export const priceListRevertResultSchema = z.object({
  /** El lote **nuevo** que crea la reversa (origin IMPORT, revertsBatchId = el revertido). */
  batchId: z.string().uuid(),
  reverted: z.number().int(),
});
export type PriceListRevertResultDto = z.infer<typeof priceListRevertResultSchema>;
