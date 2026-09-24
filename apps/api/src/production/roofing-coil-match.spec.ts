import { preferExactFinish } from './roofing-coil-match';

/**
 * D-271: planta puede montar cualquier bobina del mismo color comercial (D-270), pero el
 * selector ofrece primero las del acabado exacto del producto — el RAL que se vendió.
 */
describe('preferExactFinish (D-271)', () => {
  const row = (code: string, finishId: string, status: 'OPEN' | 'CLOSED' = 'OPEN') => ({
    code,
    finishId,
    status,
  });

  it('pone primero las del acabado del producto y conserva el orden dentro de cada grupo', () => {
    const sorted = preferExactFinish(
      [
        row('B-01', 'rojo-3002'),
        row('B-02', 'rojo-3020'),
        row('B-03', 'rojo-3002'),
        row('B-04', 'rojo-3020'),
      ],
      'rojo-3020',
    );
    expect(sorted.map((c) => [c.code, c.exactFinish])).toEqual([
      ['B-02', true],
      ['B-04', true],
      ['B-01', false],
      ['B-03', false],
    ]);
  });

  it('las cerradas siguen yendo al final, aunque sean del acabado exacto', () => {
    const sorted = preferExactFinish(
      [row('B-01', 'otro'), row('B-02', 'exacto', 'CLOSED'), row('B-03', 'exacto')],
      'exacto',
    );
    expect(sorted.map((c) => c.code)).toEqual(['B-03', 'B-01', 'B-02']);
  });

  it('sin acabado del producto no marca ninguna como exacta ni reordena', () => {
    const sorted = preferExactFinish([row('B-02', 'x'), row('B-01', 'y')], null);
    expect(sorted.map((c) => [c.code, c.exactFinish])).toEqual([
      ['B-02', false],
      ['B-01', false],
    ]);
  });
});
