/**
 * cc31 (ESPEC §6): los campos numéricos aceptan lo que se escriba —«12,5», «4,027.44», « 15 »— y
 * al salir quedan en la forma que entiende el resto del formulario y el API: punto decimal, sin
 * separador de miles ni espacios. No se redondea: lo que se envía no pierde precisión.
 *
 * Una sola coma sin punto es la coma decimal («12,5» → «12.5»). Con punto, o con varias comas,
 * las comas son separadores de miles («4,027.44» → «4027.44», «1,500,000» → «1500000»).
 * Lo que no parece un número se deja como está: la validación del campo dirá qué corregir.
 */
export function normalizeDecimalInput(raw: string): string {
  const text = raw.replace(/\s+/g, '');
  if (!/^-?[\d.,]+$/.test(text)) return raw;
  const commas = (text.match(/,/g) ?? []).length;
  const dots = (text.match(/\./g) ?? []).length;
  if (commas === 0) return text;
  if (dots === 0 && commas === 1) return text.replace(',', '.');
  if (dots <= 1) return text.replace(/,/g, '');
  return raw;
}
