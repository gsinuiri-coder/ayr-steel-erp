/** El mayor valor de una columna `INTEGER` de Postgres (INT4): el tipo de `seq`. */
const INT4_MAX = 2_147_483_647;

/**
 * El correlativo que un buscador de lista compara contra `seq` (`COT-000123` o `123` → 123), o
 * `null` si el texto no es un código interno o el número no cabe en la columna.
 *
 * D-387: un RUC de once dígitos (`20134615804`) daba un número que no entra en INT4: Postgres
 * rechazaba la consulta y la lista respondía 500. Un número así no puede ser un correlativo: no se
 * compara, y el RUC se sigue encontrando por el documento.
 *
 * cc28 (P2-1 de cc19, D-462): solo cuenta como código interno **un número solo** o el prefijo del
 * documento (`COT`/`PED`, con o sin guion) seguido del número. Antes se juntaban todos los dígitos
 * del texto, así que buscar un comprobante (`BBV1-347`) traía además `COT-001347`, que no tenía nada
 * que ver. Un texto con forma de comprobante busca solo por comprobante.
 */
export function searchSeqOf(search: string | undefined, prefix: 'COT' | 'PED'): number | null {
  const match = new RegExp(`^\\s*(?:${prefix}\\s*-?\\s*)?(\\d+)\\s*$`, 'i').exec(search ?? '');
  const digits = match?.[1];
  if (digits === undefined) return null;
  const seq = Number(digits);
  return seq <= INT4_MAX ? seq : null;
}
