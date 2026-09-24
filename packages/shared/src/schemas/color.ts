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
  /** Código RAL (D-203). Opcional. */
  ralCode: z.string().nullable(),
  hexColor: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ColorDto = z.infer<typeof colorSchema>;

/**
 * D-273: el candado del maestro. Un color del maestro **es** el color comercial (D-270): ROJO,
 * no ROJO-3020. Dos RAL del mismo color comparten el color y se distinguen en el acabado
 * (`ALZ-ROJO-3002`, `ALZ-ROJO-3020`); por eso la producción puede montar cualquiera de los dos
 * emparejando por `colorId`. Un color con RAL partiría ese grupo en dos y volvería a exigir el
 * RAL exacto sin que nadie lo decidiera.
 *
 * Tampoco puede llamarse como un tipo de acabado: `NATURAL` y `GALVANIZADO` son la llave de las
 * bobinas sin color (D-252), y un color con ese nombre se confunde con ellas en el SKU de venta.
 */
const DIACRITICS = new RegExp(`[̀-ͯ]`, 'g');
const KIND_WORDS: ReadonlySet<string> = new Set([
  'NATURAL',
  'GALV',
  'GALVANIZADO',
  'GALVANIZADA',
  'PREPINTADO',
  'PREPINTADA',
]);

export function commercialColorIssue(value: string): string | null {
  if (/\d{3}/.test(value) || /\bRAL\b/i.test(value)) {
    return 'Un color es el color comercial, sin número: el RAL va en el acabado (D-273)';
  }
  const token = value
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (KIND_WORDS.has(token)) {
    return `«${value}» es un tipo de acabado, no un color: las bobinas sin color se eligen por su tipo (D-273)`;
  }
  return null;
}

function withCommercialColorLock(schema: z.ZodType<string, z.ZodTypeDef, string>) {
  return schema.superRefine((value, ctx) => {
    const issue = commercialColorIssue(value);
    if (issue !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
  });
}

const codeSchema = withCommercialColorLock(
  z
    .string({ required_error: 'El código es obligatorio' })
    .trim()
    .toUpperCase()
    .min(1, 'Mínimo 1 carácter')
    .max(20, 'Máximo 20 caracteres')
    .regex(/^[A-Z0-9-]+$/, 'Solo letras, números y guiones'),
);

const nameSchema = withCommercialColorLock(
  z.string().trim().min(2, 'Mínimo 2 caracteres').max(80, 'Máximo 80 caracteres'),
);

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

/**
 * D-273: el RAL ya no se carga en el color —va en el acabado—, así que el campo solo admite
 * vacío. Sigue en el modelo y en el DTO por los colores que ya lo tienen (la semilla de
 * desarrollo), que se muestran igual; lo que se cierra es escribir uno nuevo.
 */
const ralCodeSchema = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v))
  .pipe(z.null({ invalid_type_error: 'El RAL va en el acabado, no en el color (D-273)' }));

export const createColorSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  ralCode: ralCodeSchema.nullable().optional(),
  hexColor: hexColorSchema,
});
export type CreateColorInput = z.infer<typeof createColorSchema>;

export const updateColorSchema = z
  .object({
    name: nameSchema,
    ralCode: ralCodeSchema.nullable(),
    hexColor: hexColorSchema,
    isActive: z.boolean(),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: 'Nada que actualizar' });
export type UpdateColorInput = z.infer<typeof updateColorSchema>;
