/**
 * cc32 (corte 2): el total al pie de las tablas de los reportes, sobre las filas **a la vista**
 * (con la búsqueda aplicada). Las cuentas son las mismas que hace el API para su total, con los
 * valores completos (`Decimal`) y sin redondear: el redondeo es solo al mostrarlas.
 *
 * cc40 (D-588): las funciones viven en `@ayr/shared` (`report-rows.ts`), porque el Excel con la
 * búsqueda de la pantalla recalcula su total con ellas: la pantalla y el archivo suman igual.
 *
 * Sin búsqueda, cada vista muestra el total que ya trae el API (`allRows`): las filas llegan
 * redondeadas a su escala y sumarlas puede correr un milésimo contra el total, que el API suma
 * sin redondear. Estas funciones son para cuando la búsqueda deja una parte de las filas.
 */
export {
  agingTotalsOf,
  coilMonthTotalsOf,
  materialFiguresOf,
  productionTotalsOf,
  wasteTotalsOf,
  type ProductionTotals,
  type WasteTotals,
} from '@ayr/shared';

/** Las filas a la vista son todas las del reporte: no hay búsqueda que las recorte. */
export function allRows(visible: readonly unknown[], all: readonly unknown[]): boolean {
  return visible.length === all.length;
}
