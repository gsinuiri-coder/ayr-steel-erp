import { Prisma } from '@prisma/client';
import { Decimal } from '@ayr/shared';
import type { EngineLineCost } from './document-profitability';
import type { DocumentLineRow } from './sales-by-material.service';
import {
  declaredDocuments,
  withEngineCosts,
  type CostRow,
  type SalesByLineRow,
} from './sales-margin.service';

/**
 * cc55 (D-667) — **un solo costo para lo fabricado contra pedido.** `withEngineCosts` reemplaza, en
 * «Ventas y margen», el costo por despacho (promedio del SKU) de una línea fabricada contra pedido
 * por el de su OP, que es el que calcula el motor (el mismo que usa la rentabilidad del
 * comprobante).
 */
const sale = (over: Partial<CostRow>): CostRow => ({
  sales_order_id: 'o1',
  invoice_id: 'f1',
  business_line_code: 'metallic-roofing',
  sales_order_item_id: 'i1',
  cost_pen: new Prisma.Decimal('7399.38'),
  kind: 'SALE',
  ...over,
});

const line = (over: Partial<DocumentLineRow>): DocumentLineRow =>
  ({
    document_id: 'f1',
    order_id: 'o1',
    sales_order_item_id: 'i1',
    item_id: 'fl1',
    line_code: 'metallic-roofing',
    product_line: 'metallic-roofing',
    in_engine: true,
    ...over,
  }) as DocumentLineRow;

const cost = (pen: string, status: EngineLineCost['status'] = 'COMPLETE'): EngineLineCost => ({
  costPen: new Decimal(pen),
  status,
});

describe('withEngineCosts (cc55, D-667)', () => {
  it('la línea fabricada pasa del promedio del despacho al costo de su OP, en su comprobante', () => {
    const out = withEngineCosts([sale({})], [line({})], new Map([['fl1', cost('7966.0989')]]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      sales_order_id: 'o1',
      invoice_id: 'f1',
      business_line_code: 'metallic-roofing',
      kind: 'SALE',
    });
    expect(out[0]?.cost_pen.toString()).toBe('7966.0989');
  });

  it('las líneas que no son del motor (reventa, stock) se quedan con su despacho', () => {
    const resale = sale({
      sales_order_item_id: 'i2',
      business_line_code: 'trading',
      cost_pen: new Prisma.Decimal('100'),
    });
    const out = withEngineCosts(
      [sale({}), resale],
      [line({})],
      new Map([['fl1', cost('7966.0989')]]),
    );
    expect(out.map((r) => [r.business_line_code, r.cost_pen.toString()])).toEqual([
      ['trading', '100'],
      ['metallic-roofing', '7966.0989'],
    ]);
  });

  it('una línea que el motor no costea (sin producción) se queda entera con el promedio', () => {
    const out = withEngineCosts(
      [sale({})],
      [line({}), line({ item_id: 'fl2', document_id: 'f2' })],
      new Map([
        ['fl1', cost('5000')],
        ['fl2', cost('0', 'NO_COST_YET')],
      ]),
    );
    expect(out.map((r) => r.cost_pen.toString())).toEqual(['7399.38']);
  });

  it('la devolución (RETURN) de una línea del motor también se reemplaza: la NC lleva su costo de OP', () => {
    const ret = sale({ kind: 'RETURN', invoice_id: 'nc1', cost_pen: new Prisma.Decimal('-200') });
    const out = withEngineCosts(
      [sale({}), ret],
      [line({}), line({ item_id: 'ncl1', document_id: 'nc1' })],
      new Map([
        ['fl1', cost('7966.0989')],
        ['ncl1', cost('-215.30')],
      ]),
    );
    expect(out.map((r) => [r.invoice_id, r.cost_pen.toString()])).toEqual([
      ['f1', '7966.0989'],
      ['nc1', '-215.3'],
    ]);
  });

  it('sin líneas del motor, las filas no cambian', () => {
    const rows = [sale({}), sale({ sales_order_item_id: null })];
    expect(withEngineCosts(rows, [], new Map())).toEqual(rows);
  });
});

describe('revisiones del corte B (H1, H2)', () => {
  it('H2: una línea con producción parcial se queda entera con el promedio', () => {
    const out = withEngineCosts(
      [sale({})],
      [line({})],
      new Map([['fl1', cost('5000', 'PARTIAL')]]),
    );
    expect(out.map((r) => r.cost_pen.toString())).toEqual(['7399.38']);
  });

  const lines = (doc: string, n: number): SalesByLineRow => ({
    document_id: doc,
    business_line_code: 'metallic-roofing',
    subtotal_pen: new Prisma.Decimal('1'),
    line_count: n,
  });

  it('H1: un comprobante con todas sus líneas por el motor declara su costo', () => {
    const rows = [sale({ sales_order_item_id: null, from_engine: true })];
    expect([...declaredDocuments(rows, [lines('f1', 1)])]).toEqual(['f1']);
  });

  it('H1: uno mixto, con el resto sin despacho declarado, no declara', () => {
    const rows = [
      sale({ sales_order_item_id: null, from_engine: true }),
      sale({ invoice_id: null, business_line_code: 'trading', sales_order_item_id: 'i2' }),
    ];
    expect(declaredDocuments(rows, [lines('f1', 2)]).size).toBe(0);
  });

  it('H1: uno mixto cuyo despacho de reventa sí lo declara, declara', () => {
    const rows = [
      sale({ sales_order_item_id: null, from_engine: true }),
      sale({ business_line_code: 'trading', sales_order_item_id: 'i2' }),
    ];
    expect([...declaredDocuments(rows, [lines('f1', 2)])]).toEqual(['f1']);
  });
});
