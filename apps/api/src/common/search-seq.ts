/** El mayor valor de una columna `INTEGER` de Postgres (INT4): el tipo de `seq`. */
const INT4_MAX = 2_147_483_647;

/**
 * El correlativo que un buscador de lista compara contra `seq` (`COT-000123` o `123` → 123), o
 * `null` si el texto no trae dígitos o el número no cabe en la columna.
 *
 * D-387: el buscador extrae **todos** los dígitos del texto, así que un RUC de once dígitos
 * (`20134615804`) daba un número que no entra en INT4: Postgres rechazaba la consulta y la lista
 * respondía 500 («No se pudieron cargar…») a quien buscaba un cliente por su RUC. Un número así
 * no puede ser un correlativo: no se compara, y el RUC se sigue encontrando por el documento.
 */
export function searchSeqOf(search: string | undefined): number | null {
  const digits = search?.replace(/\D/g, '') ?? '';
  if (digits === '') return null;
  const seq = Number(digits);
  return seq <= INT4_MAX ? seq : null;
}
