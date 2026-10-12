/**
 * cc48 (D-629): la franja «Totales por línea» de los reportes se pliega sola cuando, abierta,
 * dejaría la tabla principal con menos de este alto. Plegada o abierta, las cifras son las mismas:
 * plegar solo esconde la fila.
 */
export const LINE_TOTALS_COLLAPSE_BELOW_PX = 360;

/** El margen inferior del marco de la página, que queda debajo de la franja. */
const PAGE_BOTTOM_PX = 24;

/** El selector de la tabla de lista (`Table list`, `components/ui/table.tsx`). */
const LIST_TABLE_SELECTOR = "[data-slot='table'][data-density='list']";

/**
 * El contenedor de la tabla de lista de la pantalla: el que se desplaza. `null` cuando no hay
 * exactamente una (con dos, D-547, no se reparte la ventana y la franja no se pliega).
 */
export function listContainer(root: ParentNode): Element | null {
  const tables = root.querySelectorAll(LIST_TABLE_SELECTOR);
  if (tables.length !== 1) return null;
  return tables[0]?.parentElement ?? null;
}

export interface LineTotalsLayout {
  /** Alto de la ventana. */
  viewportHeight: number;
  /** Dónde empieza la tabla, desde el borde de arriba de la ventana. */
  tableTop: number;
  /** Lo que ocupa, debajo de la tabla, todo hasta el final de la franja **abierta**. */
  belowWhenOpen: number;
}

/**
 * El alto que la ventana le deja a la tabla con la franja abierta. No se lee del `max-height` de
 * la tabla: con pocas filas `useFillViewport` la deja en su alto natural (o en su mínimo de 240 px)
 * aunque sobre ventana, y la franja se plegaría sin motivo.
 */
export function tableRoomWhenOpen(layout: LineTotalsLayout): number {
  return layout.viewportHeight - layout.tableTop - layout.belowWhenOpen - PAGE_BOTTOM_PX;
}

/** Si la franja va plegada. Sin una sola lista medida (`null`), abierta. */
export function shouldCollapseLineTotals(layout: LineTotalsLayout | null): boolean {
  if (layout === null) return false;
  return tableRoomWhenOpen(layout) < LINE_TOTALS_COLLAPSE_BELOW_PX;
}
