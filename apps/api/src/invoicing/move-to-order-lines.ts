import { toDecimal } from '@ayr/shared';
import type { DocumentLineRow, OrderLineRow } from './reactivate-order-lines';

/**
 * D-381: al traer un comprobante anulado a otro pedido, qué línea del pedido destino factura cada
 * fila del comprobante. Sin base de datos.
 *
 * Las filas apuntan a líneas del pedido de origen, así que no hay ningún id en común con el
 * destino. El emparejado va de lo más seguro a lo menos, siempre en orden de línea:
 *
 * 1. mismo producto, misma cantidad y mismo total de línea (dos líneas del mismo producto con
 *    importes distintos no se cruzan; el control del total no lo vería);
 * 2. mismo producto;
 * 3. cualquier línea libre: es un cambio de producto, que `planOrderLines` resuelve tomando
 *    producto, descripción y unidad del pedido, y que el modal resalta.
 *
 * Las líneas del destino que quedan libres son las nuevas del comprobante (`planOrderLines` las
 * agrega al final). Las filas sin pareja (`unpaired`) significan que el destino tiene menos líneas
 * que el comprobante: nunca se borra una fila (D-378), así que el servicio bloquea.
 */
export interface RowPairing {
  /** Id de la fila del comprobante → id de la línea del pedido destino. */
  pairing: Map<string, string>;
  unpaired: DocumentLineRow[];
}

export function pairRowsToOrder(
  documentLines: readonly DocumentLineRow[],
  targetOrderLines: readonly OrderLineRow[],
): RowPairing {
  const rows = [...documentLines].sort((a, b) => a.lineNumber - b.lineNumber);
  const free = [...targetOrderLines].sort((a, b) => a.lineNumber - b.lineNumber);
  const pairing = new Map<string, string>();

  const pass = (matches: (d: DocumentLineRow, o: OrderLineRow) => boolean) => {
    for (const d of rows) {
      if (pairing.has(d.id)) continue;
      const i = free.findIndex((o) => matches(d, o));
      if (i < 0) continue;
      const [taken] = free.splice(i, 1);
      if (taken) pairing.set(d.id, taken.id);
    }
  };

  pass(
    (d, o) =>
      d.productId === o.productId &&
      toDecimal(d.qty.toString()).eq(toDecimal(o.qty.toString())) &&
      toDecimal(d.totalPen.toString()).eq(toDecimal(o.totalPen.toString())),
  );
  pass((d, o) => d.productId === o.productId);
  pass(() => true);

  return { pairing, unpaired: rows.filter((d) => !pairing.has(d.id)) };
}
