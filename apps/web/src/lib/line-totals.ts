/**
 * cc48 (D-629): la franja «Totales por línea» de los reportes se pliega sola cuando, abierta,
 * dejaría la tabla principal con menos de este alto. Plegada o abierta, las cifras son las mismas:
 * plegar solo esconde la fila.
 */
export const LINE_TOTALS_COLLAPSE_BELOW_PX = 360;

/** El selector de la tabla de lista (`Table list`, `components/ui/table.tsx`). */
const LIST_TABLE_SELECTOR = "[data-slot='table'][data-density='list']";

/**
 * El alto que la tabla de lista tiene hoy: el `max-height` que le fija `useFillViewport`. `null`
 * cuando no hay exactamente una lista en la pantalla (con dos, D-547, no se reparte la ventana) o
 * cuando todavía no se midió.
 */
export function listRoomPx(root: ParentNode): number | null {
  const tables = root.querySelectorAll(LIST_TABLE_SELECTOR);
  if (tables.length !== 1) return null;
  const container = tables[0]?.parentElement;
  if (!container) return null;
  const room = Number.parseFloat(container.style.maxHeight);
  return Number.isFinite(room) ? room : null;
}

/**
 * Si la franja va plegada. `room` es el alto de la tabla con la franja como está ahora; plegada,
 * abrirla le quitaría `openExtraPx` (lo que la franja abierta ocupa de más), así que se decide con
 * el alto que tendría abierta, y la decisión no oscila al plegar.
 */
export function shouldCollapseLineTotals(
  room: number | null,
  collapsed: boolean,
  openExtraPx: number,
): boolean {
  if (room === null) return false;
  const roomIfOpen = collapsed ? room - Math.max(openExtraPx, 0) : room;
  return roomIfOpen < LINE_TOTALS_COLLAPSE_BELOW_PX;
}
