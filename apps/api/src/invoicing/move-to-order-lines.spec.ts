import { pairRowsToOrder } from './move-to-order-lines';
import type { DocumentLineRow, OrderLineRow } from './reactivate-order-lines';

/**
 * D-381: el emparejado de las filas de un comprobante anulado con las líneas del pedido destino.
 * Va de lo más seguro a lo menos: producto, cantidad y total; después producto; después
 * cualquier línea libre (cambio de producto). Nunca deja una fila sin pareja si hay líneas libres.
 */
describe('pairRowsToOrder (D-381)', () => {
  const row = (
    id: string,
    lineNumber: number,
    productId: string,
    qty = '1',
    totalPen = '11.8000',
  ): DocumentLineRow => ({
    id,
    lineNumber,
    productId,
    description: `Papel ${id}`,
    qty,
    unit: 'NIU',
    unitPricePen: '10.0000',
    subtotalPen: '10.0000',
    igvPen: '1.8000',
    totalPen,
    salesOrderItemId: `src-${id}`,
  });
  const line = (
    id: string,
    lineNumber: number,
    productId: string,
    qty = '1',
    totalPen = '11.8000',
  ): OrderLineRow => ({
    id,
    lineNumber,
    productId,
    description: `Pedido ${id}`,
    qty,
    unit: 'NIU',
    subtotalPen: '10.0000',
    igvPen: '1.8000',
    totalPen,
  });

  it('el caso de FFA1-00001389: seis filas por producto con las líneas 2 a 7, la 1 queda libre', () => {
    const products = ['ALV', 'SIKA', 'AUTO', 'BOOM', 'PH', 'PU'];
    const rows = products.map((p, i) => row(`fdi-${String(i + 1)}`, i + 1, p));
    const lines = [
      line('dst-1', 1, 'UPVC'),
      ...products.map((p, i) => line(`dst-${String(i + 2)}`, i + 2, p)),
    ];
    const { pairing, unpaired } = pairRowsToOrder(rows, lines);
    expect(unpaired).toEqual([]);
    expect([...pairing.entries()]).toEqual(
      products.map((_, i) => [`fdi-${String(i + 1)}`, `dst-${String(i + 2)}`]),
    );
    expect([...pairing.values()]).not.toContain('dst-1');
  });

  it('dos líneas del mismo producto: prefiere la de misma cantidad y total antes que el orden', () => {
    const { pairing } = pairRowsToOrder(
      [row('fdi-1', 1, 'P', '5', '59.0000'), row('fdi-2', 2, 'P', '2', '23.6000')],
      [line('dst-1', 1, 'P', '2', '23.6000'), line('dst-2', 2, 'P', '5', '59.0000')],
    );
    expect(pairing.get('fdi-1')).toBe('dst-2');
    expect(pairing.get('fdi-2')).toBe('dst-1');
  });

  it('sin pareja exacta, empareja por producto aunque cambien cantidad o importe', () => {
    const { pairing, unpaired } = pairRowsToOrder(
      [row('fdi-1', 1, 'P', '5', '59.0000')],
      [line('dst-1', 1, 'Q'), line('dst-2', 2, 'P', '7', '82.6000')],
    );
    expect(unpaired).toEqual([]);
    expect(pairing.get('fdi-1')).toBe('dst-2');
  });

  it('sin el producto en el destino, toma la primera línea libre: es un cambio de producto', () => {
    const { pairing, unpaired } = pairRowsToOrder(
      [row('fdi-1', 1, 'P'), row('fdi-2', 2, 'Q')],
      [line('dst-1', 1, 'Q'), line('dst-2', 2, 'R'), line('dst-3', 3, 'S')],
    );
    expect(unpaired).toEqual([]);
    expect(pairing.get('fdi-2')).toBe('dst-1');
    expect(pairing.get('fdi-1')).toBe('dst-2');
  });

  it('con menos líneas en el destino, las filas que sobran quedan sin pareja (el servicio bloquea)', () => {
    const { pairing, unpaired } = pairRowsToOrder(
      [row('fdi-1', 1, 'P'), row('fdi-2', 2, 'Q')],
      [line('dst-1', 1, 'Q')],
    );
    expect(pairing.get('fdi-2')).toBe('dst-1');
    expect(unpaired.map((d) => d.id)).toEqual(['fdi-1']);
  });

  it('respeta el orden de línea de las filas aunque lleguen desordenadas', () => {
    const { pairing } = pairRowsToOrder(
      [row('fdi-2', 2, 'P'), row('fdi-1', 1, 'P')],
      [line('dst-1', 1, 'P'), line('dst-2', 2, 'P')],
    );
    expect(pairing.get('fdi-1')).toBe('dst-1');
    expect(pairing.get('fdi-2')).toBe('dst-2');
  });
});
