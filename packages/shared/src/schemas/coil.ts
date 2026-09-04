import { z } from 'zod';
import { decimalStringSchema, MAX_VALUE, toDecimal } from '../decimal';
import {
  BUSINESS_LINES,
  COIL_KINDS,
  COIL_SPLIT_STATUSES,
  COIL_STATUSES,
  CURRENCIES,
} from '../enums';

/**
 * Bobina de acero (RF-10..RF-14). Alta siempre por una de las tres vías de Fase 2a
 * (compra manual, XML de factura, planilla); no hay endpoint de creación suelta.
 * Las operaciones de Fase 2b (partido, merma, cierre, edición, anulación) sí entran
 * por HTTP y viven más abajo en este archivo.
 */
export const coilSchema = z.object({
  id: z.string().uuid(),
  /** RF-13: `{supplierCode}-{finishCode}-{thicknessMm}-{weightKg}-{correlativo}`. */
  code: z.string(),
  /** RF-14: `{finishCode}-{thicknessMm}`, ignora el ancho. */
  typeKey: z.string(),
  /** D-049: `COIL` (bobina) o `STRIP` (fleje). */
  kind: z.enum(COIL_KINDS),
  businessLine: z.enum(BUSINESS_LINES),
  supplierId: z.string().uuid(),
  supplierName: z.string(),
  purchaseId: z.string().uuid().nullable(),
  purchaseLabel: z.string().nullable(),
  finishId: z.string().uuid(),
  finishCode: z.string(),
  finishName: z.string(),
  weightKg: z.string(),
  widthMm: z.string(),
  thicknessMm: z.string(),
  /**
   * D-085: color de la bobina. Las prepintadas lo llevan, las galvanizadas van en null. Es
   * lo que el filtro de la OP de coberturas compara contra el color del producto, por
   * **igualdad estricta** — null incluido.
   */
  colorId: z.string().uuid().nullable(),
  colorCode: z.string().nullable(),
  colorName: z.string().nullable(),
  colorHex: z.string().nullable(),
  currency: z.enum(CURRENCIES),
  exchangeRate: z.string(),
  /** Costo por kg SIN IGV (D-038). El landed cost (D-043) lo puede subir. */
  unitCostPerKg: z.string(),
  totalCost: z.string(),
  totalCostPen: z.string(),
  status: z.enum(COIL_STATUSES),
  parentCoilId: z.string().uuid().nullable(),
  /** Código de la bobina madre, cuando esta nació de un partido (RF-15). */
  parentCoilCode: z.string().nullable(),
  splitId: z.string().uuid().nullable(),
  notes: z.string().nullable(),
  /** Kilos disponibles según el kardex; puede diferir de `weightKg` tras consumos. */
  availableKg: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CoilDto = z.infer<typeof coilSchema>;

/** Filtros de la lista de bobinas por línea (RF-23). */
export const coilQuerySchema = z.object({
  businessLine: z.enum(BUSINESS_LINES).optional(),
  finishId: z.string().uuid().optional(),
  thicknessMm: decimalStringSchema('MM', { positive: true }).optional(),
  status: z.enum(COIL_STATUSES).optional(),
  supplierId: z.string().uuid().optional(),
  /** D-049: filtra bobinas (`COIL`) o flejes (`STRIP`); sin filtro trae ambos. */
  kind: z.enum(COIL_KINDS).optional(),
  /** D-085: filtra por color. `sin-color` trae las que no lo tienen (galvanizadas). */
  colorId: z.union([z.literal('sin-color'), z.string().uuid()]).optional(),
  search: z.string().trim().max(80).optional(),
});
export type CoilQuery = z.infer<typeof coilQuerySchema>;

// --------------------------------------------------------------------------
// Fase 2b — partido (RF-15/RF-16)
// --------------------------------------------------------------------------

/** Motivo escrito por el usuario. Va al kardex (`notes`) y a la auditoría. */
export const reasonSchema = z
  .string({ required_error: 'El motivo es obligatorio' })
  .trim()
  .min(3, 'Explica el motivo en al menos 3 caracteres')
  .max(240, 'Máximo 240 caracteres');

export const coilSplitChildSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  widthMm: z.string(),
  weightKg: z.string(),
  status: z.enum(COIL_STATUSES),
});
export type CoilSplitChildDto = z.infer<typeof coilSplitChildSchema>;

export const coilSplitSchema = z.object({
  id: z.string().uuid(),
  parentCoilId: z.string().uuid(),
  parentCoilCode: z.string(),
  /** Kilos de la madre que entraron al partido. */
  splitWeightKg: z.string(),
  kerfLossMm: z.string(),
  kerfLossKg: z.string(),
  status: z.enum(COIL_SPLIT_STATUSES),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  revertedAt: z.string().nullable(),
  children: z.array(coilSplitChildSchema),
});
export type CoilSplitDto = z.infer<typeof coilSplitSchema>;

/**
 * Ancho mínimo de una bobina hija, en mm. Una tira más angosta no existe en una
 * slitter real; el límite impide "partir" una bobina en una tira de 0.01 mm y hacer
 * desaparecer el resto del valor como merma de corte.
 */
export const MIN_CHILD_WIDTH_MM = 5;

/**
 * Fracción mínima del ancho de la madre que tienen que cubrir las hijas. Un corte que
 * bota más del 20 % del ancho no es un partido, es dar de baja la bobina: para eso está
 * la merma (RF-17), que exige motivo y queda auditada como tal.
 */
export const MIN_SPLIT_YIELD = 0.8;

/** Tope de filas de anchos y de bobinas hijas de un mismo partido. */
export const MAX_SPLIT_ROWS = 20;
export const MAX_SPLIT_CHILDREN = 20;

const splitChildInputSchema = z.object({
  widthMm: decimalStringSchema('MM', { positive: true, max: MAX_VALUE.WIDTH_MM }).refine(
    (v) => toDecimal(v).gte(MIN_CHILD_WIDTH_MM),
    `El ancho de cada hija debe ser de al menos ${MIN_CHILD_WIDTH_MM} mm`,
  ),
  /** Tiras idénticas de ese ancho; el slitting casi siempre produce varias. */
  count: z
    .number()
    .int()
    .min(1, 'Al menos una tira')
    .max(MAX_SPLIT_CHILDREN, `Máximo ${MAX_SPLIT_CHILDREN} tiras iguales`)
    .default(1),
});

/**
 * RF-15. `splitWeightKg` es opcional: si no viene, se parte todo el saldo disponible
 * de la madre. El peso se prorratea por ancho **sobre el ancho de la madre**, y todo lo
 * que las hijas no cubren (el kerf declarado más el recorte de borde) es pérdida de
 * corte. El API exige además un ancho mínimo por hija y un piso de aprovechamiento,
 * para que un partido no pueda usarse como baja encubierta de la bobina.
 */
export const createCoilSplitSchema = z
  .object({
    splitWeightKg: decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG }).optional(),
    kerfLossMm: decimalStringSchema('MM', { max: MAX_VALUE.WIDTH_MM }).default('0.00'),
    children: z
      .array(splitChildInputSchema)
      .min(1, 'El partido necesita al menos una bobina hija')
      // Cada hija abre una fila de bobina y un movimiento de kardex dentro de la misma
      // transacción que mantiene el lock del saldo de la madre.
      .max(MAX_SPLIT_ROWS, `Un partido admite hasta ${MAX_SPLIT_ROWS} filas de anchos`),
  })
  .superRefine((d, ctx) => {
    if (toDecimal(d.kerfLossMm).isNegative()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kerfLossMm'],
        message: 'La merma de corte no puede ser negativa',
      });
    }
    const strips = d.children.reduce((acc, c) => acc + c.count, 0);
    if (strips > MAX_SPLIT_CHILDREN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['children'],
        message: `Un partido admite hasta ${MAX_SPLIT_CHILDREN} bobinas hijas`,
      });
    }
  });
export type CreateCoilSplitInput = z.infer<typeof createCoilSplitSchema>;

// --------------------------------------------------------------------------
// Fase 2b — merma, cierre, edición y anulación (RF-17..RF-21)
// --------------------------------------------------------------------------

/** RF-17, D-040: salida `SCRAP` valorizada al costo promedio vigente. */
export const createCoilScrapSchema = z.object({
  qtyKg: decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG }),
  reason: reasonSchema,
});
export type CreateCoilScrapInput = z.infer<typeof createCoilScrapSchema>;

/** RF-18, RF-21 y anulación de compra: toda reversa exige motivo (RF-95). */
export const reverseMovementSchema = z.object({ reason: reasonSchema });
export type ReverseMovementInput = z.infer<typeof reverseMovementSchema>;

/** RF-19: abrir o cerrar una bobina. Una cerrada no entra a producción ni a partido. */
export const setCoilStatusSchema = z.object({
  status: z.enum(['OPEN', 'CLOSED'], { errorMap: () => ({ message: 'Estado inválido' }) }),
  reason: reasonSchema.optional(),
});
export type SetCoilStatusInput = z.infer<typeof setCoilStatusSchema>;

/**
 * RF-20. Los campos de costo (`currency`, `exchangeRate`, `unitCostPerKg`) recuestan
 * el ingreso vía reversa + nuevo movimiento y solo los admite ADMINISTRADOR con la
 * bobina sin movimientos posteriores al `IN` inicial (D-045). El resto se edita libre
 * mientras la bobina esté abierta.
 */
export const updateCoilSchema = z
  .object({
    widthMm: decimalStringSchema('MM', { positive: true, max: MAX_VALUE.WIDTH_MM }).optional(),
    /**
     * D-085. Cadena vacía = quitar el color. Se edita bajo el mismo guardrail que el ancho
     * (bobina abierta y no montada en una OP): cambiar el color de un rollo que una orden
     * ya montó rompería, a mitad de corrida, la igualdad contra la que se validó (D-086).
     */
    colorId: z.union([z.literal(''), z.string().uuid('Color inválido')]).optional(),
    notes: z.string().trim().max(500).optional(),
    currency: z.enum(CURRENCIES).optional(),
    exchangeRate: decimalStringSchema('RATE', { positive: true, max: MAX_VALUE.RATE }).optional(),
    unitCostPerKg: decimalStringSchema('MONEY', {
      positive: true,
      max: MAX_VALUE.MONEY,
    }).optional(),
    reason: reasonSchema.optional(),
  })
  .superRefine((d, ctx) => {
    if (Object.values(d).every((v) => v === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'No hay nada que cambiar' });
    }
    const touchesCost =
      d.currency !== undefined || d.exchangeRate !== undefined || d.unitCostPerKg !== undefined;
    if (touchesCost && !d.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'Cambiar el costo de una bobina exige un motivo (D-045)',
      });
    }
    if (d.currency === 'PEN' && d.exchangeRate !== undefined && !toDecimal(d.exchangeRate).eq(1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exchangeRate'],
        message: 'Una bobina en soles va con tipo de cambio 1',
      });
    }
    // Pasar a moneda extranjera sin decir el tipo de cambio dejaría el recosteo
    // arrastrando el TC anterior —1.0000 si la bobina venía en soles— y el costo del
    // kardex, que va en soles (D-042), entraría dividido por 3.7 sin que nada avise.
    if (d.currency !== undefined && d.currency !== 'PEN' && d.exchangeRate === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exchangeRate'],
        message: 'Cambiar la moneda a dólares exige indicar el tipo de cambio',
      });
    }
  });
export type UpdateCoilInput = z.infer<typeof updateCoilSchema>;
