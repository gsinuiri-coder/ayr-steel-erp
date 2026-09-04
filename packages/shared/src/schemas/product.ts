import { z } from 'zod';
import { decimalStringSchema, MAX_VALUE } from '../decimal';
import { BUSINESS_LINES, PRODUCT_SOURCES } from '../enums';

/** Catálogo de productos por línea (RF-50). SKU único dentro de su línea, no global. */
export const productSchema = z.object({
  id: z.string().uuid(),
  businessLineId: z.string().uuid(),
  businessLineCode: z.enum(BUSINESS_LINES),
  sku: z.string(),
  name: z.string(),
  unit: z.string(),
  /** D-068: precio de lista de venta, sin IGV y en soles (D-064). Null si no se fijó. */
  listPricePen: z.string().nullable(),
  isActive: z.boolean(),
  source: z.enum(PRODUCT_SOURCES),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProductDto = z.infer<typeof productSchema>;

const skuSchema = z
  .string({ required_error: 'El SKU es obligatorio' })
  .trim()
  .toUpperCase()
  .min(1, 'Mínimo 1 carácter')
  .max(40, 'Máximo 40 caracteres')
  .regex(/^[A-Z0-9-]+$/, 'Solo letras, números y guiones');
const nameSchema = z
  .string()
  .trim()
  .min(2, 'Mínimo 2 caracteres')
  .max(160, 'Máximo 160 caracteres');
const unitSchema = z
  .string()
  .trim()
  .min(1, 'La unidad es obligatoria')
  .max(20, 'Máximo 20 caracteres');
/**
 * Precio de lista (D-068). Cadena vacía = "sin precio de lista" y se guarda como `null`:
 * un producto puede venderse solo con precio escrito a mano en la cotización.
 */
const listPriceSchema = z
  .union([z.literal(''), decimalStringSchema('MONEY', { positive: true, max: MAX_VALUE.MONEY })])
  .optional()
  .transform((v) => (v === '' || v === undefined ? null : v));

export const createProductSchema = z.object({
  businessLineId: z.string().uuid('Selecciona una línea de negocio'),
  sku: skuSchema,
  name: nameSchema,
  unit: unitSchema,
  source: z.enum(PRODUCT_SOURCES, { errorMap: () => ({ message: 'Origen inválido' }) }),
  listPricePen: listPriceSchema,
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = z
  .object({
    name: nameSchema,
    unit: unitSchema,
    source: z.enum(PRODUCT_SOURCES),
    listPricePen: listPriceSchema,
    isActive: z.boolean(),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: 'Nada que actualizar' });
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
