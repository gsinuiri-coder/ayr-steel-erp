import { UNITS_SYMBOL, unitSymbol } from './unit-symbol';

describe('unitSymbol (D-579)', () => {
  it('las unidades se muestran como «und» y el resto con su abreviatura', () => {
    expect(UNITS_SYMBOL).toBe('und');
    expect(unitSymbol('NIU')).toBe('und');
    expect(unitSymbol('KGM')).toBe('kg');
    expect(unitSymbol('MTR')).toBe('m');
    expect(unitSymbol('TNE')).toBe('t');
    expect(unitSymbol('ZZ')).toBe('');
  });

  it('un código desconocido se muestra tal cual', () => {
    expect(unitSymbol('XYZ')).toBe('XYZ');
  });
});
