import Decimal from 'decimal.js';

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

/** Serializa para transporte/persistencia con la escala fija (string, nunca number). */
export function toFixedString(value: DecimalInput, scale: ScaleKey): string {
  return roundTo(value, scale).toFixed(SCALE[scale]);
}

export const sum = (values: DecimalInput[]): Decimal =>
  values.reduce<Decimal>((acc, v) => acc.plus(toDecimal(v)), new Decimal(0));

export const isZero = (v: DecimalInput): boolean => toDecimal(v).isZero();
export const isPositive = (v: DecimalInput): boolean => toDecimal(v).gt(0);
