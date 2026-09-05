import { Decimal, salesTotals, toDecimal, type SalesLineInput } from '@ayr/shared';

/**
 * Las tres comprobaciones de un comprobante importado que **solo se ven mirando el grupo
 * entero** (RF-71), separadas de la base y de Nest para poder probarlas.
 *
 * Son las que se equivocan en silencio: un total que no es el del papel entra como una
 * deuda equivocada en la cuenta del cliente, y una cabecera que cambia a mitad del archivo
 * hace que se importe un documento que nadie emitió.
 */

/**
 * Texto de un campo ya normalizado. Los valores de `ImportRow.data` viajan como JSON y
 * vuelven como `unknown`: `String(x)` sobre un objeto daría `[object Object]` y haría que
 * dos cabeceras distintas parecieran iguales.
 */
export function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * ¿Este texto es un decimal que `toDecimal` puede leer?
 *
 * Hace falta porque una fila **inválida** conserva en `data` lo que el usuario escribió, sin
 * normalizar: si "Cantidad" dice `abc`, ese `abc` sigue ahí. Sin este filtro, la validación
 * de grupo se lo pasaba a `toDecimal`, que lanza, y una planilla con un número mal escrito
 * terminaba en un 500 en vez de en una fila marcada en rojo.
 */
export function isDecimalText(value: unknown): value is string {
  return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim());
}

/**
 * Tolerancia al comparar el total declarado con la suma de las líneas: un céntimo por
 * línea.
 *
 * El comprobante original redondeó a dos decimales línea por línea y acá se recalcula con
 * la escala del proyecto (cuatro, D-003), así que exigir igualdad exacta habría rechazado
 * comprobantes correctos; aceptar cualquier diferencia habría dejado entrar un total
 * inventado.
 */
export function totalTolerance(lineCount: number): Decimal {
  return new Decimal('0.01').times(Math.max(lineCount, 1));
}

/**
 * Qué campos de cabecera **no** dicen lo mismo en todas las filas del comprobante.
 *
 * Devuelve las etiquetas de los que difieren, en el orden en que se declararon. Si alguno
 * difiere no se sabe cuál de las dos versiones del documento se está importando, así que
 * no se importa ninguna.
 */
export function mismatchedHeaderLabels(
  rows: Record<string, unknown>[],
  fields: readonly { key: string; label: string }[],
): string[] {
  return fields
    .filter((field) => new Set(rows.map((row) => asText(row[field.key]))).size > 1)
    .map((field) => field.label);
}

/**
 * Diferencia entre lo que suman las líneas y el total que declara el archivo, o `null`
 * cuando cuadra dentro de la tolerancia. Devuelve además el calculado, que es la mitad
 * útil del mensaje: sin él, el usuario sabe que no cuadra pero no por cuánto.
 */
export function totalMismatch(
  lines: SalesLineInput[],
  declaredTotalPen: string,
): { computed: Decimal; declared: Decimal } | null {
  const computed = salesTotals(lines).total;
  const declared = toDecimal(declaredTotalPen);
  if (computed.minus(declared).abs().lte(totalTolerance(lines.length))) return null;
  return { computed, declared };
}
