import { describe, expect, it } from 'vitest';
import { coilPoolLabel, groupByPool, matchesCoilFilter } from './coil-sale-picker';

/** D-282: el modal de venta de bobina filtra y agrupa por pool (espesor + color comercial). */

const coil = (code: string, thicknessMm: string, colorName: string | null, finishName: string) => ({
  code,
  thicknessMm,
  colorName,
  finishName,
  finishCode: finishName.replace(/\s+/g, '-').toUpperCase(),
});

describe('coil-sale-picker', () => {
  it('el pool se nombra por espesor y color; sin color, por el acabado', () => {
    expect(coilPoolLabel(coil('B1', '0.38', 'ROJO', 'ALZ ROJO 3020'))).toBe('0.38 mm · ROJO');
    expect(coilPoolLabel(coil('B2', '0.40', null, 'Galvanizado'))).toBe('0.40 mm · Galvanizado');
  });

  it('agrupa por pool, de menor a mayor espesor y en orden de código dentro del grupo', () => {
    const groups = groupByPool([
      coil('C', '0.40', 'AZUL', 'x'),
      coil('B', '0.38', 'ROJO', 'x'),
      coil('A', '0.38', 'ROJO', 'y'),
    ]);
    expect(groups.map((g) => [g.label, g.coils.map((c) => c.code)])).toEqual([
      ['0.38 mm · ROJO', ['A', 'B']],
      ['0.40 mm · AZUL', ['C']],
    ]);
  });

  it('el filtro busca en código, color, acabado (RAL) y espesor, sin mayúsculas', () => {
    const c = coil('SALDO-ALZ-ROJO-3020', '0.38', 'ROJO', 'ALZ ROJO 3020');
    expect(matchesCoilFilter(c, '')).toBe(true);
    expect(matchesCoilFilter(c, 'rojo')).toBe(true);
    expect(matchesCoilFilter(c, '3020')).toBe(true);
    expect(matchesCoilFilter(c, '0.38')).toBe(true);
    expect(matchesCoilFilter(c, 'azul')).toBe(false);
  });
});
