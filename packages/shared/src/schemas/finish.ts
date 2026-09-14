import { z } from 'zod';
import { decimalStringSchema } from '../decimal';
import { COIL_BUSINESS_LINES, type BusinessLine } from '../enums';

/**
 * Tipo de acabado (D-203). Decide el color: `PREPINTADO` lo exige, `NATURAL` y `GALVANIZADO`
 * no lo admiten. La base lo sostiene con el CHECK `finishes_color_by_kind`.
 */
export const FinishKind = {
  NATURAL: 'NATURAL',
  PREPINTADO: 'PREPINTADO',
  GALVANIZADO: 'GALVANIZADO',
} as const;
export type FinishKind = (typeof FinishKind)[keyof typeof FinishKind];

export const FINISH_KIND_LABELS: Record<FinishKind, string> = {
  NATURAL: 'Natural',
  PREPINTADO: 'Prepintado',
  GALVANIZADO: 'Galvanizado',
};

/** ¿Este tipo de acabado lleva color? La única respuesta a esa pregunta (D-203). */
export function finishKindHasColor(kind: FinishKind): boolean {
  return kind === FinishKind.PREPINTADO;
}

const finishKindSchema = z.enum(
  [FinishKind.NATURAL, FinishKind.PREPINTADO, FinishKind.GALVANIZADO],
  {
    errorMap: () => ({ message: 'Elige el tipo de acabado' }),
  },
);

/**
 * Líneas a las que puede pertenecer un acabado: las que compran y registran bobinas (D-116).
 * Un acabado pertenece a **una** línea (D-203).
 */
const finishBusinessLineSchema = z
  .string({ required_error: 'Elige la línea del acabado' })
  .refine((v): v is BusinessLine => (COIL_BUSINESS_LINES as readonly string[]).includes(v), {
    message: 'Un acabado pertenece a una línea que maneja bobinas',
  });

/**
 * Acabados de bobina (RF-25), con su factor de densidad (Decimal 10,4 — D-003).
 *
 * D-203: tipo + color + línea. `kind` y `businessLine` son `null` solo en un acabado anterior a
 * D-203 que todavía no se mapeó; la pantalla lo marca para completarlo.
 */
export const finishSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  densityFactor: z.string(),
  kind: finishKindSchema.nullable(),
  colorId: z.string().uuid().nullable(),
  colorName: z.string().nullable(),
  colorHex: z.string().nullable(),
  colorRal: z.string().nullable(),
  businessLine: z.string().nullable(),
  /**
   * Tiene bobinas o ítems de compra. Con uso, tipo, color y línea ya no se cambian (D-203); la
   * pantalla los bloquea en vez de dejar descubrirlo con un 400.
   */
  inUse: z.boolean(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FinishDto = z.infer<typeof finishSchema>;

const codeSchema = z
  .string({ required_error: 'El código es obligatorio' })
  .trim()
  .toUpperCase()
  .min(1, 'Mínimo 1 carácter')
  .max(20, 'Máximo 20 caracteres')
  .regex(/^[A-Z0-9-]+$/, 'Solo letras, números y guiones');
const nameSchema = z
  .string()
  .trim()
  .min(2, 'Mínimo 2 caracteres')
  .max(120, 'Máximo 120 caracteres');

/** Mensajes de la regla de color por tipo, compartidos por el alta, la edición y el API. */
export const FINISH_COLOR_REQUIRED = 'Un acabado prepintado lleva color: elígelo del catálogo';
export const FINISH_COLOR_FORBIDDEN = 'Solo un acabado prepintado lleva color';

/** La regla de D-203 sobre un par ya resuelto (tipo, color). `null` si se cumple. */
export function finishColorError(kind: FinishKind, colorId: string | null): string | null {
  if (finishKindHasColor(kind)) return colorId ? null : FINISH_COLOR_REQUIRED;
  return colorId ? FINISH_COLOR_FORBIDDEN : null;
}

export const createFinishSchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    densityFactor: decimalStringSchema('RATE', { positive: true }),
    kind: finishKindSchema,
    colorId: z.string().uuid('Elige un color del catálogo').nullable().optional(),
    businessLine: finishBusinessLineSchema,
  })
  .superRefine((d, ctx) => {
    const error = finishColorError(d.kind, d.colorId ?? null);
    if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['colorId'], message: error });
  });
export type CreateFinishInput = z.infer<typeof createFinishSchema>;

/**
 * Edición. Tipo, color y línea se validan contra el acabado **resultante** en el API (lo que
 * no viaja se toma del actual), y solo se pueden cambiar mientras el acabado no tenga bobinas ni
 * compras: el color de esas bobinas sale de él, así que cambiarlo después las repintaría hacia
 * atrás.
 */
export const updateFinishSchema = z
  .object({
    name: nameSchema,
    densityFactor: decimalStringSchema('RATE', { positive: true }),
    kind: finishKindSchema,
    colorId: z.string().uuid('Elige un color del catálogo').nullable(),
    businessLine: finishBusinessLineSchema,
    isActive: z.boolean(),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: 'Nada que actualizar' });
export type UpdateFinishInput = z.infer<typeof updateFinishSchema>;
