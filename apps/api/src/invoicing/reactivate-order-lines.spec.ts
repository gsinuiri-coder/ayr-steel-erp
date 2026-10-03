import {
  paperTotalDifference,
  planOrderLines,
  type DocumentLineRow,
} from './reactivate-order-lines';

/**
 * D-378: el plan de «Reactivar con las líneas actuales del pedido». El comprobante pasa a
 * facturar el pedido entero; las filas que ya existían se actualizan en su lugar y las líneas
 * nuevas del pedido se agregan al final.
 */
describe('planOrderLines (D-378)', () => {
  const orderLine = (
    id: string,
    lineNumber: number,
    qty: string,
    subtotalPen: string,
    igvPen: string,
    totalPen: string,
  ) => ({
    id,
    lineNumber,
    productId: `p-${id}`,
    description: `Producto ${id}`,
    qty,
    unit: 'NIU',
    subtotalPen,
    igvPen,
    totalPen,
  });

  const docLine = (
    id: string,
    lineNumber: number,
    salesOrderItemId: string,
    qty: string,
    subtotalPen: string,
    igvPen: string,
    totalPen: string,
    unitPricePen: string,
  ): DocumentLineRow => ({
    id,
    lineNumber,
    productId: `p-${salesOrderItemId}`,
    description: `Papel ${id}`,
    qty,
    unit: 'MTR',
    unitPricePen,
    subtotalPen,
    igvPen,
    totalPen,
    salesOrderItemId,
  });

  // El caso del dueño: el papel tenía dos líneas y al pedido le faltaba la segunda.
  const ORIGINAL = docLine(
    'fdi-1',
    1,
    'soi-1',
    '48.000',
    '100.0000',
    '18.0000',
    '118.0000',
    '2.0833',
  );
  const ORDER = [
    orderLine('soi-1', 1, '48', '100.0000', '18.0000', '118.0000'),
    orderLine('soi-2', 2, '3', '30.0300', '5.4054', '35.4354'),
  ];

  it('conserva la fila original (id, número, descripción, unidad) y agrega la del pedido al final', () => {
    const plan = planOrderLines([ORIGINAL], ORDER);

    expect(plan.updates).toEqual([
      {
        id: 'fdi-1',
        productId: 'p-soi-1',
        description: 'Papel fdi-1',
        unit: 'MTR',
        qty: '48.000',
        unitPricePen: '2.0833',
        subtotalPen: '100.0000',
        igvPen: '18.0000',
        totalPen: '118.0000',
      },
    ]);
    expect(plan.creates).toEqual([
      {
        lineNumber: 2,
        productId: 'p-soi-2',
        description: 'Producto soi-2',
        unit: 'NIU',
        salesOrderItemId: 'soi-2',
        qty: '3.000',
        unitPricePen: '10.0100',
        subtotalPen: '30.0300',
        igvPen: '5.4054',
        totalPen: '35.4354',
      },
    ]);
    expect(plan.after.lines.map((l) => [l.lineNumber, l.description, l.unit, l.added])).toEqual([
      [1, 'Papel fdi-1', 'MTR', false],
      [2, 'Producto soi-2', 'NIU', true],
    ]);
    expect(plan.changed).toBe(true);
  });

  it('la cabecera va al céntimo con D-377: gravada y IGV suman las líneas por separado', () => {
    const plan = planOrderLines([ORIGINAL], ORDER);
    // Gravada 130.03; IGV céntimo(18 + 5.4054) = 23.41; total 153.44.
    expect(plan.before).toMatchObject({
      subtotalPen: '100.0000',
      igvPen: '18.0000',
      totalPen: '118.0000',
    });
    expect(plan.after).toMatchObject({
      subtotalPen: '130.0300',
      igvPen: '23.4100',
      totalPen: '153.4400',
    });
  });

  it('una línea entera copia el importe del pedido, que es el del papel (D-169), y el unitario sale de él (D-255)', () => {
    // 146 × 16.28928 da 2378.23 de valor en el papel: el importe no se recalcula desde el
    // unitario redondeado.
    const plan = planOrderLines(
      [],
      [orderLine('soi-9', 1, '146', '2378.2349', '428.0823', '2806.3172')],
    );
    expect(plan.creates[0]).toMatchObject({
      subtotalPen: '2378.2349',
      igvPen: '428.0823',
      totalPen: '2806.3172',
      unitPricePen: '16.2893',
    });
  });

  it('una línea original cuyo precio o cantidad cambió en el pedido toma los importes nuevos (decisión 2)', () => {
    const plan = planOrderLines(
      [ORIGINAL],
      [orderLine('soi-1', 1, '50', '104.1667', '18.7500', '122.9167')],
    );
    expect(plan.updates[0]).toMatchObject({ id: 'fdi-1', qty: '50.000', totalPen: '122.9167' });
    expect(plan.creates).toEqual([]);
    expect(plan.changed).toBe(true);
  });

  it('si la línea del pedido cambió de producto, la fila toma el producto nuevo con su descripción y su unidad', () => {
    const otherCoil = { ...ORDER[0]!, productId: 'p-otra-bobina', description: 'Otra bobina' };
    const plan = planOrderLines([ORIGINAL], [otherCoil]);
    expect(plan.updates[0]).toMatchObject({
      id: 'fdi-1',
      productId: 'p-otra-bobina',
      description: 'Otra bobina',
      unit: 'NIU',
    });
    expect(plan.after.lines[0]).toMatchObject({ description: 'Otra bobina', unit: 'NIU' });
    // Mismos importes, pero otro material: es un cambio.
    expect(plan.changed).toBe(true);
  });

  it('el «antes» muestra la cabecera grabada, no la recalculada con D-377', () => {
    // Un manual anterior a D-377: la cabecera grabada no es el céntimo de la suma de líneas.
    const stored = { subtotalPen: '100.0049', igvPen: '18.0009', totalPen: '118.0058' };
    const plan = planOrderLines([ORIGINAL], ORDER, stored);
    expect(plan.before).toMatchObject({
      subtotalPen: '100.0049',
      igvPen: '18.0009',
      totalPen: '118.0058',
    });
    // El «después» siempre se calcula con D-377.
    expect(plan.after.totalPen).toBe('153.4400');
  });

  it('una línea facturada en parte pasa a la línea entera del pedido (decisión 1)', () => {
    const partial = docLine('fdi-1', 1, 'soi-1', '20', '41.6667', '7.5000', '49.1667', '2.0833');
    const plan = planOrderLines([partial], [ORDER[0]!]);
    expect(plan.updates[0]).toMatchObject({ id: 'fdi-1', qty: '48.000', totalPen: '118.0000' });
    expect(plan.changed).toBe(true);
  });

  it('sin cambios en el pedido el plan no cambia nada y lo dice', () => {
    const plan = planOrderLines([ORIGINAL], [ORDER[0]!]);
    expect(plan.changed).toBe(false);
    expect(plan.creates).toEqual([]);
    expect(plan.after.totalPen).toBe(plan.before.totalPen);
  });

  it('respeta el orden del pedido para las agregadas y numera después de la última del comprobante', () => {
    const plan = planOrderLines(
      [docLine('fdi-3', 3, 'soi-2', '3', '30.0300', '5.4054', '35.4354', '10.0100')],
      [orderLine('soi-3', 3, '1', '10.0000', '1.8000', '11.8000'), ORDER[0]!, ORDER[1]!],
    );
    expect(plan.creates.map((c) => [c.lineNumber, c.salesOrderItemId])).toEqual([
      [4, 'soi-1'],
      [5, 'soi-3'],
    ]);
    expect(plan.after.lines.map((l) => l.orderLineNumber)).toEqual([2, 1, 3]);
  });
});

describe('paperTotalDifference (D-378)', () => {
  it('coincide al céntimo', () => {
    expect(paperTotalDifference('153.44', '153.4400')).toBeNull();
  });

  it('devuelve papel − líneas con signo', () => {
    expect(paperTotalDifference('153.45', '153.4400')).toBe('0.01');
    expect(paperTotalDifference('150', '153.4400')).toBe('-3.44');
  });
});
