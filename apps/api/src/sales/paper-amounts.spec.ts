import { paperAmounts } from '@ayr/shared';

/**
 * D-255 (decisión del dueño, 2026-09-24): el trío del papel normalizado a dos decimales. Si la
 * suma se separa del total en un céntimo o menos, manda el total del papel y el IGV es la resta;
 * ese IGV tiene que quedar a un céntimo o menos del 18 % del valor.
 */
describe('paperAmounts — el trío del papel', () => {
  const fixed = (r: ReturnType<typeof paperAmounts>) =>
    r === null ? null : [r.net.toFixed(2), r.igv.toFixed(2), r.total.toFixed(2)];

  it('FFA1-1350: 12439.831 + 2239.16958 ≠ 14679.000 → 12439.83 / 2239.17 / 14679.00', () => {
    expect(fixed(paperAmounts('12439.831', '2239.16958', '14679.000'))).toEqual([
      '12439.83',
      '2239.17',
      '14679.00',
    ]);
  });

  it('una suma que se separa del total en 0.02 se descarta', () => {
    expect(paperAmounts('12439.831', '2239.18958', '14679.000')).toBeNull();
  });

  it('un IGV que, como resta, se aleja más de un céntimo del 18 % se descarta', () => {
    // 100 + 0 = 100: la suma cuadra, pero un IGV cero no es el 18 % de 100.
    expect(paperAmounts('100.00', '0.00', '100.00')).toBeNull();
  });

  it('un trío que ya cuadra exacto queda igual', () => {
    expect(fixed(paperAmounts('100.00', '18.00', '118.00'))).toEqual(['100.00', '18.00', '118.00']);
  });
});
