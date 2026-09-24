import { plantLineMeasures } from './plant-measures';

describe('plantLineMeasures (hoja de planta, D-271)', () => {
  it('dice el color comercial y el RAL que se prefiere, que sale del acabado del producto', () => {
    expect(
      plantLineMeasures({
        thicknessMm: '0.40',
        widthMm: '1000.00',
        lengthMm: null,
        color: { name: 'ROJO' },
        finish: { code: 'ALZ-ROJO-3020', name: 'ALUZINC ROJO 3020' },
      }),
    ).toBe('0.40 mm · 1000.00 mm de ancho · ROJO, de preferencia RAL 3020');
  });

  it('sin RAL en el acabado nombra solo el color; sin color, nada de color', () => {
    expect(
      plantLineMeasures({
        thicknessMm: '0.30',
        widthMm: null,
        lengthMm: '3600.00',
        color: { name: 'BLANCO' },
        finish: { code: 'ALZ-BLANCO', name: 'ALUZINC BLANCO' },
      }),
    ).toBe('0.30 mm · largo fijo 3.60 m · BLANCO');
    expect(
      plantLineMeasures({
        thicknessMm: '0.30',
        widthMm: '1000.00',
        lengthMm: null,
        color: null,
        finish: { code: 'ALZ-NATURAL', name: 'ALUZINC NATURAL' },
      }),
    ).toBe('0.30 mm · 1000.00 mm de ancho');
  });

  it('un producto sin nada que medir devuelve el guion', () => {
    expect(
      plantLineMeasures({
        thicknessMm: null,
        widthMm: null,
        lengthMm: null,
        color: null,
        finish: null,
      }),
    ).toBe('—');
  });
});
