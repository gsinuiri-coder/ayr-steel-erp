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

/**
 * D-271: el RAL de un acabado. Desde D-270 el maestro de colores es el **color comercial**
 * (ROJO) y el RAL (3002, 3020) vive en el acabado, escrito al final de su código
 * (`ALZ-ROJO-3020`) o de su nombre. Son cuatro dígitos exactos al final, precedidos por algo
 * que no sea un dígito: `EDBO089957` no es un RAL. Solo presentación y orden del selector de
 * planta; ninguna regla de montaje lo lee.
 */
export function finishRal(finish: { code: string; name: string }): string | null {
  for (const value of [finish.code, finish.name]) {
    const match = /(?:^|\D)(\d{4})$/.exec(value.trim());
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
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

/**
 * Cómo se nombra un acabado **en la pantalla** (F8-S7/M2).
 *
 * El catálogo los identifica por código técnico (`ALZ-ROJO-3020`), que es lo correcto para el
 * SKU, el `typeKey` y cualquier cruce de datos. Pero el vendedor que elige una bobina para
 * cotizar no piensa en `ALZ-ROJO-3020`: piensa «rojo». Pedido del cliente tras usar la app:
 * el selector hablaba en el idioma del catálogo y no en el del mostrador.
 *
 * **Es solo presentación.** D-203 queda intacto: el acabado sigue siendo tipo + color + línea,
 * el `colorId` sigue saliendo del acabado y todo filtrado y emparejamiento sigue yendo por id
 * (D-085). Acá no se decide nada, solo se elige qué texto se lee.
 *
 * La regla:
 * - Un **prepintado** se muestra por su color comercial (`Rojo`, `Azul`), que es su rasgo
 *   distintivo y lo único que el cliente pide por teléfono.
 * - `NATURAL` y `GALVANIZADO` no tienen color: se muestran por su nombre, que ya es del
 *   idioma del negocio (`Aluzinc natural`, `Galvanizado`).
 * - El **código técnico solo aparece cuando hace falta para desambiguar**: si dos acabados
 *   activos comparten color comercial —dos rojos de RAL distinto, que es exactamente el caso
 *   que el catálogo real tiene con `ALZ-ROJO-3002` y `ALZ-ROJO-3020`—, elegir a ciegas entre
 *   dos «Rojo» es peor que leer un código. Ahí, y solo ahí, se agrega.
 *
 * Por eso la etiqueta depende del **conjunto** que se está mostrando y no del acabado solo:
 * la misma fila se lee «Rojo» en una lista donde es el único rojo y «Rojo (ALZ-ROJO-3020)» en
 * una donde no. `finishLabels` calcula los duplicados una vez para toda la lista.
 */
export function finishLabels(finishes: readonly FinishDto[]): Map<string, string> {
  const seen = new Map<string, number>();
  for (const f of finishes) {
    const base = baseLabelOf(f);
    seen.set(base, (seen.get(base) ?? 0) + 1);
  }
  return new Map(
    finishes.map((f) => {
      const base = baseLabelOf(f);
      // El código desambigua; el RAL no, porque no todo color del proveedor tiene uno.
      return [f.id, (seen.get(base) ?? 0) > 1 ? `${base} (${f.code})` : base];
    }),
  );
}

function baseLabelOf(finish: FinishDto): string {
  if (finish.kind === 'PREPINTADO' && finish.colorName) return finish.colorName;
  // Sin nombre no queda más que el código: un acabado sin `name` no debería existir, pero la
  // pantalla no es el lugar donde eso se descubre a los gritos.
  return finish.name || finish.code;
}

/** El mismo texto para las dos mitades de la pregunta, en el `<label>` del campo. */
export const FINISH_FIELD_LABEL = 'Acabado / Color';
