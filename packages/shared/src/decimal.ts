import Decimal from 'decimal.js';
import { z } from 'zod';

/**
 * Helper Decimal (D-003): dinero, kg y mm NUNCA se operan con `number`.
 * Escalas explícitas (§3.3): dinero 4, kg 3, mm 2.
 */
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

export const SCALE = {
  MONEY: 4,
  KG: 3,
  MM: 2,
  /** Factores y tasas que no son dinero/kg/mm pero igual deben ser Decimal (D-003):
   *  factor de densidad de acabado, margen%, tipo de cambio. */
  RATE: 4,
} as const;
export type ScaleKey = keyof typeof SCALE;

/** Entrada aceptada: string o Decimal.  queda excluido a propósito (D-003). */
export type DecimalInput = string | Decimal;

/** Convierte cualquier entrada válida a Decimal. Lanza si no es numérica. */
export function toDecimal(value: DecimalInput): Decimal {
  if (value instanceof Decimal) return value;
  const d = new Decimal(value);
  if (!d.isFinite()) throw new TypeError(`Valor decimal inválido: ${value}`);
  return d;
}

/** Redondea a la escala indicada (HALF_UP) y devuelve Decimal. */
export function roundTo(value: DecimalInput, scale: ScaleKey): Decimal {
  return toDecimal(value).toDecimalPlaces(SCALE[scale], Decimal.ROUND_HALF_UP);
}

export const money = (v: DecimalInput): Decimal => roundTo(v, 'MONEY');
export const kg = (v: DecimalInput): Decimal => roundTo(v, 'KG');
export const mm = (v: DecimalInput): Decimal => roundTo(v, 'MM');
export const rate = (v: DecimalInput): Decimal => roundTo(v, 'RATE');

/** Serializa para transporte/persistencia con la escala fija (string, nunca number). */
export function toFixedString(value: DecimalInput, scale: ScaleKey): string {
  return roundTo(value, scale).toFixed(SCALE[scale]);
}

export const sum = (values: DecimalInput[]): Decimal =>
  values.reduce<Decimal>((acc, v) => acc.plus(toDecimal(v)), new Decimal(0));

export const isZero = (v: DecimalInput): boolean => toDecimal(v).isZero();
export const isPositive = (v: DecimalInput): boolean => toDecimal(v).gt(0);

/**
 * Schema Zod para un campo Decimal serializado como string (D-003: nunca `number`).
 * Normaliza a la escala fija y valida que sea un decimal real antes de redondear.
 */
export function decimalStringSchema(
  scale: ScaleKey,
  opts: { positive?: boolean; max?: number } = {},
) {
  return (
    z
      .string({ required_error: 'Este valor es obligatorio' })
      .trim()
      .refine((v) => /^-?\d+(\.\d+)?$/.test(v), 'Debe ser un número decimal (ej: 12.5)')
      .transform((v) => toFixedString(v, scale))
      .refine((v) => !opts.positive || toDecimal(v).gt(0), 'Debe ser mayor a cero')
      // Sin cota superior, un valor mayor que la columna `NUMERIC` de destino explota como
      // `numeric field overflow` de Postgres, que sale al cliente como un 500 en vez de
      // como el 400 legible que corresponde.
      .refine(
        (v) => opts.max === undefined || toDecimal(v).abs().lte(opts.max),
        `El valor máximo admitido es ${opts.max ?? ''}`,
      )
  );
}

/**
 * Topes por tipo de dato, alineados con la escala y precisión de las columnas del
 * schema de Prisma (§3.3). Se usan en los campos que llegan del usuario.
 */
export const MAX_VALUE = {
  /** `Decimal(8,2)`: ancho de bobina en mm. */
  WIDTH_MM: 999_999,
  /** `Decimal(6,2)`: espesor en mm. */
  THICKNESS_MM: 9_999,
  /** `Decimal(12,3)` / `Decimal(16,3)`: kilos. */
  KG: 999_999_999,
  /** `Decimal(18,4)`: dinero. */
  MONEY: 99_999_999_999,
  /** `Decimal(10,4)`: tipo de cambio. */
  RATE: 999_999,
} as const;
