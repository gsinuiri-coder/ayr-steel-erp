/**
 * D-579: la abreviatura de una unidad SUNAT (catálogo 03) **para mostrar** en los PDFs internos y
 * los Excel: «und» para las unidades (`NIU`), «kg», «m», «t». Es el mismo mapa que `unitSymbol`
 * de `apps/web/src/lib/format.ts`; si cambia uno, cambia el otro.
 *
 * Solo es la vista: el código que se guarda, el que viaja al PSE/XML y el de los comprobantes
 * (y la tabla 6 del formato 13.1 de SUNAT) no pasan por aquí.
 */
export const UNITS_SYMBOL = 'und';

const UNIT_SYMBOL: Record<string, string> = {
  KGM: 'kg',
  NIU: UNITS_SYMBOL,
  MTR: 'm',
  TNE: 't',
  ZZ: '',
};

/** Un código desconocido se muestra tal cual. */
export function unitSymbol(unit: string): string {
  return UNIT_SYMBOL[unit] ?? unit;
}
