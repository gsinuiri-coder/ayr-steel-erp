import { z } from 'zod';

/**
 * Maestro de colores (RF-54, D-085).
 *
 * El color es un **id**, no una cadena: el filtro de bobina de la OP de coberturas compara
 * `colorId` contra `colorId`, nunca dos textos que alguien tipeó con un acento distinto, y
 * nunca leyendo el SKU. El `code` existe para el SKU y las planillas de importación; el
 * `hexColor` para que el selector muestre la muestra real, que es como se elige un rollo en
 * planta.
 */
export const colorSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  hexColor: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ColorDto = z.infer<typeof colorSchema>;

const codeSchema = z
  .string({ required_error: 'El código es obligatorio' })
  .trim()
  .toUpperCase()
  .min(1, 'Mínimo 1 carácter')
  .max(20, 'Máximo 20 caracteres')
  .regex(/^[A-Z0-9-]+$/, 'Solo letras, números y guiones');

const nameSchema = z.string().trim().min(2, 'Mínimo 2 caracteres').max(80, 'Máximo 80 caracteres');

/**
 * `#RRGGBB` en minúsculas. Se normaliza acá y no en la UI para que dos altas del mismo
 * color no queden como `#FF0000` y `#ff0000`, que a simple vista son el mismo dato y en una
 * comparación de texto no lo son.
 */
const hexColorSchema = z
  .string({ required_error: 'El color es obligatorio' })
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/, 'Color inválido: usa el formato #rrggbb');

export const createColorSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  hexColor: hexColorSchema,
});
export type CreateColorInput = z.infer<typeof createColorSchema>;

export const updateColorSchema = z
  .object({
    name: nameSchema,
    hexColor: hexColorSchema,
    isActive: z.boolean(),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: 'Nada que actualizar' });
export type UpdateColorInput = z.infer<typeof updateColorSchema>;
