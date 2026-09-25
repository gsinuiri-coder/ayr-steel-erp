import { describe, expect, it } from 'vitest';
import { unassignedCoilLines } from './unassigned-coil-lines';

const line = (over: Partial<Parameters<typeof unassignedCoilLines>[0][number]> = {}) => ({
  lineNumber: 1,
  productSku: 'BOB038AZUL',
  businessLine: 'trading',
  reserveItemType: 'PRODUCT',
  ...over,
});

describe('unassignedCoilLines (D-322)', () => {
  it('un BOB… de la línea de reventa sin bobina cuenta', () => {
    expect(unassignedCoilLines([line()])).toHaveLength(1);
    expect(unassignedCoilLines([line({ productSku: 'bob38azul' })])).toHaveLength(1);
  });

  it('con bobina asignada no cuenta', () => {
    expect(unassignedCoilLines([line({ reserveItemType: 'COIL' })])).toEqual([]);
  });

  it('otro producto o otra línea de negocio no cuenta', () => {
    expect(unassignedCoilLines([line({ productSku: 'ACC-001' })])).toEqual([]);
    expect(unassignedCoilLines([line({ businessLine: 'roofing' })])).toEqual([]);
  });

  it('devuelve solo las que faltan, con su número de línea', () => {
    const rows = [line({ lineNumber: 1, reserveItemType: 'COIL' }), line({ lineNumber: 2 })];
    expect(unassignedCoilLines(rows).map((l) => l.lineNumber)).toEqual([2]);
  });
});
