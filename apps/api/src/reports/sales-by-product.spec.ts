import { sum } from '@ayr/shared';
import {
  assembleSalesByProduct,
  declaredKey,
  type DeclaredDispatch,
  type ProductInvoiceLine,
} from './sales-by-product';

/**
 * cc24 (D-417): «Ventas por material» por producto. Lo que se fija es el criterio: el costo es el
 * de kardex de los despachos que declaran el comprobante; lo que no se puede atribuir así se
 * declara con su motivo; y la venta de la línea es la de las filas más la no trazable más las
 * bobinas que viven en otra pestaña.
 */
function line(over: Partial<ProductInvoiceLine>): ProductInvoiceLine {
  return {
    documentId: 'd1',
    documentNumber: 'F001-1',
    docType: 'FACTURA',
    issueDate: '2026-09-10',
    orderSeq: 7,
    productId: 'p1',
    sku: 'UPVC-01',
    name: 'Teja UPVC',
    unit: 'NIU',
    qty: '10',
    salesPen: '500.0000',
    shownElsewhere: false,
    ...over,
  };
}

function declared(
  entries: [string, string, Partial<DeclaredDispatch>][],
): Map<string, DeclaredDispatch> {
  return new Map(
    entries.map(([doc, product, d]) => [
      declaredKey(doc, product),
      {
        qty: '0',
        costPen: '0',
        untraceable: false,
        // Por omisión todo lo despachado salió con kardex, o nada si se marcó sin salida.
        costedQty: d.untraceable === true ? '0' : (d.qty ?? '0'),
        ...d,
      },
    ]),
  );
}

describe('assembleSalesByProduct (cc24, D-417)', () => {
  it('dos líneas del mismo producto en dos comprobantes suman en una fila', () => {
    const out = assembleSalesByProduct(
      [
        line({}),
        line({ documentId: 'd2', documentNumber: 'F001-2', qty: '4', salesPen: '200.0000' }),
      ],
      declared([
        ['d1', 'p1', { qty: '10', costPen: '300.0000' }],
        ['d2', 'p1', { qty: '4', costPen: '120.0000' }],
      ]),
    );
    expect(out.products.rows).toMatchObject([
      { sku: 'UPVC-01', qty: '14.000', salesPen: '700.0000', costPen: '420.0000', lineCount: 2 },
    ]);
    expect(out.products.total).toEqual({
      salesPen: '700.0000',
      costPen: '420.0000',
      profitPen: '280.0000',
    });
  });

  it('sin despacho declarado: no trazable con su venta, nunca costo 0', () => {
    const out = assembleSalesByProduct([line({})], new Map());
    expect(out.products.rows).toEqual([]);
    expect(out.products.untraceable).toMatchObject([
      { reason: 'SIN_DESPACHO_DECLARADO', qty: '10.000', salesPen: '500.0000' },
    ]);
  });

  it('despacho parcial: se traza lo despachado y el resto se declara', () => {
    const out = assembleSalesByProduct(
      [line({})],
      declared([['d1', 'p1', { qty: '4', costPen: '128.0000' }]]),
    );
    expect(out.products.rows).toMatchObject([
      { qty: '4.000', salesPen: '200.0000', costPen: '128.0000' },
    ]);
    expect(out.products.untraceable).toMatchObject([
      { reason: 'DESPACHO_PARCIAL', qty: '6.000', salesPen: '300.0000' },
    ]);
  });

  it('despacho parcial con un tercio: trazado y no trazable suman la venta exacta', () => {
    const out = assembleSalesByProduct(
      [line({ qty: '3', salesPen: '100.0000' })],
      declared([['d1', 'p1', { qty: '1', costPen: '10.0000' }]]),
    );
    expect(out.products.rows[0]?.salesPen).toBe('33.3333');
    expect(out.products.untraceable[0]?.salesPen).toBe('66.6667');
  });

  it('despachado de más contra el comprobante: a lo facturado le toca su parte del costo', () => {
    const out = assembleSalesByProduct(
      [line({})],
      declared([['d1', 'p1', { qty: '20', costPen: '640.0000' }]]),
    );
    expect(out.products.rows).toMatchObject([{ qty: '10.000', costPen: '320.0000' }]);
  });

  it('despachado sin salida de kardex (D-285): no trazable, no un margen del 100 %', () => {
    const out = assembleSalesByProduct(
      [line({})],
      declared([['d1', 'p1', { qty: '10', costPen: '0', untraceable: true }]]),
    );
    expect(out.products.rows).toEqual([]);
    expect(out.products.untraceable).toMatchObject([{ reason: 'SIN_SALIDA_KARDEX' }]);
  });

  it('cc34 N7: despachos mezclados, se traza solo lo que salió con kardex', () => {
    const out = assembleSalesByProduct(
      [line({})],
      declared([
        ['d1', 'p1', { qty: '10', costedQty: '5', costPen: '160.0000', untraceable: true }],
      ]),
    );
    expect(out.products.rows).toMatchObject([
      { sku: 'UPVC-01', qty: '5.000', salesPen: '250.0000', costPen: '160.0000' },
    ]);
    expect(out.products.untraceable).toMatchObject([
      { reason: 'SIN_SALIDA_KARDEX', qty: '5.000', salesPen: '250.0000' },
    ]);
  });

  it('cc34 N7: con parte sin despachar y parte sin kardex, cada resto con su motivo', () => {
    const out = assembleSalesByProduct(
      [line({})],
      declared([
        ['d1', 'p1', { qty: '6', costedQty: '4', costPen: '120.0000', untraceable: true }],
      ]),
    );
    expect(out.products.rows).toMatchObject([{ qty: '4.000', salesPen: '200.0000' }]);
    expect(out.products.untraceable.map((u) => [u.reason, u.qty, u.salesPen]).sort()).toEqual([
      ['DESPACHO_PARCIAL', '4.000', '200.0000'],
      ['SIN_SALIDA_KARDEX', '2.000', '100.0000'],
    ]);
  });

  it('la nota de crédito resta venta como no trazable', () => {
    const out = assembleSalesByProduct(
      [line({ docType: 'NOTA_CREDITO', qty: '-2', salesPen: '-100.0000' })],
      new Map(),
    );
    expect(out.products.untraceable).toMatchObject([
      { reason: 'NOTA_CREDITO', qty: '-2.000', salesPen: '-100.0000' },
    ]);
  });

  it('venta de la línea = filas + no trazable + bobinas de otra pestaña', () => {
    const lines = [
      line({}),
      line({ documentId: 'd2', qty: '3', salesPen: '150.0000' }),
      line({ documentId: 'd3', docType: 'NOTA_CREDITO', qty: '-1', salesPen: '-50.0000' }),
      line({
        documentId: 'd4',
        sku: 'BOBALZ',
        productId: 'p9',
        salesPen: '4000.0000',
        shownElsewhere: true,
      }),
    ];
    const out = assembleSalesByProduct(
      lines,
      declared([['d1', 'p1', { qty: '6', costPen: '180.0000' }]]),
    );
    const parts = sum([
      ...out.products.rows.map((r) => r.salesPen),
      ...out.products.untraceable.map((u) => u.salesPen),
      out.shownElsewhereSales.toString(),
    ]);
    expect(parts.toFixed(4)).toBe(out.lineSales.toFixed(4));
    expect(out.lineSales.toFixed(4)).toBe('4600.0000');
  });
});
