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
 * Tolerancia de "no cuadra" para la importación de ventas históricas (D-138/D-142) —
 * **no** la canónica de RF-71, que sigue con `totalTolerance` de arriba.
 *
 * Acá el precio unitario no viene impreso en el papel: sale de dividir VALOR DE VENTA entre
 * CANTIDAD (D-138) y se guarda a la escala del proyecto (D-003), así que el redondeo
 * compuesto de volver a sumar las líneas se acumula más de lo que "un céntimo por línea"
 * asume — ese número se calibró para RF-71, donde el importe de cada línea ya viene
 * redondeado del papel. El peor caso real medido contra el Excel del dueño (D-142, sesión
 * 7-final-C) fue 0.21 en un comprobante de varias líneas; 0.25 deja un margen chico sin
 * abrir la puerta a un total inventado.
 *
 * Es **una sola constante** que lee tanto la previsualización
 * (`SalesHistoryImportAdapter.validateGroup`, que solo avisa) como la confirmación
 * (`FiscalImportService.resolveTotals`, que de verdad manda) — la lección de D-088 otra
 * vez: dos números que dicen lo mismo puestos a mano en dos archivos terminan, tarde o
 * temprano, diciendo cosas distintas.
 */
export const SALES_HISTORY_TOTAL_TOLERANCE_PEN = '0.25';

/**
 * Igual que `salesHistoryTotalMismatch` compara neto+IGV contra el precio de venta, para el
 * import de ventas históricas: acá el neto, el IGV y el bruto son columnas propias del
 * export (D-138), así que no hay nada que recalcular a una tarifa fija — solo comprobar que
 * las tres sumas cuadran entre sí, con la tolerancia compartida de arriba.
 */
export function salesHistoryTotalMismatch(
  netPen: string,
  igvPen: string,
  grossPen: string,
): { computed: Decimal; declared: Decimal } | null {
  const computed = toDecimal(netPen).plus(igvPen);
  const declared = toDecimal(grossPen);
  if (computed.minus(declared).abs().lte(toDecimal(SALES_HISTORY_TOTAL_TOLERANCE_PEN))) {
    return null;
  }
  return { computed, declared };
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
 *
 * `tolerance` es opcional y por defecto es la de RF-71 (`totalTolerance`, un céntimo por
 * línea); D-142 la pisa con `SALES_HISTORY_TOTAL_TOLERANCE_PEN` para la importación de
 * ventas históricas, que tiene su propio perfil de redondeo (ver esa constante).
 */
export function totalMismatch(
  lines: SalesLineInput[],
  declaredTotalPen: string,
  tolerance?: Decimal,
): { computed: Decimal; declared: Decimal } | null {
  const computed = salesTotals(lines).total;
  const declared = toDecimal(declaredTotalPen);
  if (
    computed
      .minus(declared)
      .abs()
      .lte(tolerance ?? totalTolerance(lines.length))
  )
    return null;
  return { computed, declared };
}
