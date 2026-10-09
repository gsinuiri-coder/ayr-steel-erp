import { describe, expect, it } from 'vitest';
import { metersToMm, mmToMetersShort } from './pieces';

describe('largo en metros para el campo (cc36)', () => {
  it('2 decimales; el tercero solo si no es cero, y vuelve a los mismos milímetros', () => {
    expect(mmToMetersShort('4200.00')).toBe('4.20');
    expect(mmToMetersShort('3600.00')).toBe('3.60');
    expect(mmToMetersShort('4205.00')).toBe('4.205');
    for (const mm of ['4200.00', '3600.00', '4205.00', '12000.00']) {
      expect(metersToMm(mmToMetersShort(mm))).toBe(mm);
    }
  });
});
