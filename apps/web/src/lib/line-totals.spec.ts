import { describe, expect, it } from 'vitest';
import {
  LINE_TOTALS_COLLAPSE_BELOW_PX,
  listContainer,
  shouldCollapseLineTotals,
  tableRoomWhenOpen,
} from './line-totals';

/** Un nodo raíz falso: solo lo que `listContainer` lee. */
function root(count: number): ParentNode {
  const tables = Array.from({ length: count }, (_, i) => ({ parentElement: { id: String(i) } }));
  return { querySelectorAll: () => tables } as unknown as ParentNode;
}

describe('cc48 (D-629): la franja «Totales por línea» se pliega cuando la tabla queda baja', () => {
  it('el alto que queda es la ventana menos lo de arriba, lo de abajo y el margen', () => {
    expect(tableRoomWhenOpen({ viewportHeight: 768, tableTop: 315, belowWhenOpen: 50 })).toBe(379);
  });

  it('a 1366×768 con la franja de una fila, abierta; con la tabla de antes (110 px), plegada', () => {
    expect(
      shouldCollapseLineTotals({ viewportHeight: 768, tableTop: 315, belowWhenOpen: 50 }),
    ).toBe(false);
    expect(
      shouldCollapseLineTotals({ viewportHeight: 768, tableTop: 315, belowWhenOpen: 110 }),
    ).toBe(true);
  });

  it('el umbral: justo en 360 px no se pliega; uno menos, sí', () => {
    const at = (room: number) =>
      shouldCollapseLineTotals({
        viewportHeight: 1000,
        tableTop: 1000 - room - 24,
        belowWhenOpen: 0,
      });
    expect(at(LINE_TOTALS_COLLAPSE_BELOW_PX)).toBe(false);
    expect(at(LINE_TOTALS_COLLAPSE_BELOW_PX - 1)).toBe(true);
  });

  it('sin una sola lista medida, queda abierta', () => {
    expect(shouldCollapseLineTotals(null)).toBe(false);
  });

  it('el contenedor de la lista, solo si hay exactamente una', () => {
    expect(listContainer(root(1))).toEqual({ id: '0' });
    expect(listContainer(root(0))).toBeNull();
    expect(listContainer(root(2))).toBeNull();
  });
});
