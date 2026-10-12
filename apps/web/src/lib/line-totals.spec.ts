import { describe, expect, it } from 'vitest';
import { LINE_TOTALS_COLLAPSE_BELOW_PX, listRoomPx, shouldCollapseLineTotals } from './line-totals';

/** Un nodo raíz falso: solo lo que `listRoomPx` lee. */
function root(maxHeights: string[]): ParentNode {
  const tables = maxHeights.map((maxHeight) => ({ parentElement: { style: { maxHeight } } }));
  return { querySelectorAll: () => tables } as unknown as ParentNode;
}

describe('cc48 (D-629): la franja «Totales por línea» se pliega cuando la tabla queda baja', () => {
  it('abierta, se pliega por debajo del umbral y no por encima', () => {
    expect(shouldCollapseLineTotals(LINE_TOTALS_COLLAPSE_BELOW_PX - 1, false, 60)).toBe(true);
    expect(shouldCollapseLineTotals(LINE_TOTALS_COLLAPSE_BELOW_PX, false, 60)).toBe(false);
  });

  it('plegada, decide con el alto que tendría abierta: no oscila', () => {
    // Plegada deja 400 px; abierta ocuparía 60 px más y dejaría 340: sigue plegada.
    expect(shouldCollapseLineTotals(400, true, 60)).toBe(true);
    // Con una ventana más alta, abierta deja 380: se abre.
    expect(shouldCollapseLineTotals(440, true, 60)).toBe(false);
  });

  it('sin una sola lista medida, queda abierta', () => {
    expect(shouldCollapseLineTotals(null, false, 60)).toBe(false);
    expect(shouldCollapseLineTotals(null, true, 60)).toBe(false);
  });

  it('el alto de la lista es su max-height, solo si hay exactamente una', () => {
    expect(listRoomPx(root(['412px']))).toBe(412);
    expect(listRoomPx(root([]))).toBeNull();
    expect(listRoomPx(root(['412px', '300px']))).toBeNull();
    expect(listRoomPx(root(['none']))).toBeNull();
    expect(listRoomPx(root(['']))).toBeNull();
  });
});
