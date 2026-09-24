import { createColorSchema, finishRal, updateColorSchema } from '@ayr/shared';

/**
 * D-273: el candado del maestro de colores. Un color del maestro **es** el color comercial
 * (D-270): no lleva RAL —el RAL va en el acabado— ni puede llamarse como un tipo de acabado.
 */
describe('candado del maestro de colores (D-273)', () => {
  const base = { code: 'ROJO', name: 'Rojo', hexColor: '#9b2423' };

  it('acepta un color comercial limpio', () => {
    expect(createColorSchema.safeParse(base).success).toBe(true);
    expect(
      createColorSchema.safeParse({ ...base, code: 'AZUL-OSC', name: 'Azul oscuro' }).success,
    ).toBe(true);
    // Un dígito suelto no es un RAL: los colores de la suite E2E llevan el prefijo `E2E`.
    expect(createColorSchema.safeParse({ ...base, code: 'E2EABAAAB' }).success).toBe(true);
    // «Coral» contiene «ral» pero no es un RAL.
    expect(createColorSchema.safeParse({ ...base, code: 'CORAL', name: 'Coral' }).success).toBe(
      true,
    );
  });

  it.each([
    ['código con RAL pegado', { code: 'ROJO-3020' }],
    ['código solo RAL', { code: 'RAL9010' }],
    ['nombre con RAL', { name: 'Rojo tráfico 3020' }],
    ['nombre con la palabra RAL', { name: 'Rojo RAL' }],
  ])('rechaza el %s', (_label, over) => {
    const result = createColorSchema.safeParse({ ...base, ...over });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('el RAL va en el acabado');
  });

  it('rechaza el campo RAL del color: el RAL es del acabado', () => {
    const result = createColorSchema.safeParse({ ...base, ralCode: '3020' });
    expect(result.success).toBe(false);
    expect(createColorSchema.safeParse({ ...base, ralCode: '' }).success).toBe(true);
    expect(createColorSchema.safeParse({ ...base, ralCode: null }).success).toBe(true);
    expect(updateColorSchema.safeParse({ ralCode: '3002' }).success).toBe(false);
    expect(updateColorSchema.safeParse({ ralCode: null }).success).toBe(true);
  });

  it.each([
    ['NATURAL', 'Natural'],
    ['GALVANIZADO', 'Galvanizado'],
    ['GALV', 'Galv'],
    ['GALVANIZADA', 'Galvanizada'],
    ['PREPINTADO', 'Prepintado'],
  ])('rechaza el nombre de tipo %s', (code, name) => {
    expect(createColorSchema.safeParse({ ...base, code }).success).toBe(false);
    expect(createColorSchema.safeParse({ ...base, name }).success).toBe(false);
  });

  it('el renombre pasa por el mismo candado', () => {
    expect(updateColorSchema.safeParse({ name: 'Rojo 3002' }).success).toBe(false);
    expect(updateColorSchema.safeParse({ name: 'Natural' }).success).toBe(false);
    expect(updateColorSchema.safeParse({ name: 'Rojo teja' }).success).toBe(true);
    // Desactivar no toca el nombre: el candado no se mete con eso.
    expect(updateColorSchema.safeParse({ isActive: false }).success).toBe(true);
  });
});

describe('finishRal (D-271)', () => {
  it('lee el RAL del código del acabado, y si no del nombre', () => {
    expect(finishRal({ code: 'ALZ-ROJO-3020', name: 'ALUZINC ROJO 3020' })).toBe('3020');
    expect(finishRal({ code: 'ALZ-ROJO', name: 'ALUZINC ROJO 3002' })).toBe('3002');
    expect(finishRal({ code: 'SALDO-ALZ-AZUL-RAL5002', name: 'x' })).toBe('5002');
  });

  it('no inventa un RAL donde no hay cuatro dígitos al final', () => {
    expect(finishRal({ code: 'ALZ-NATURAL', name: 'ALUZINC NATURAL' })).toBeNull();
    expect(finishRal({ code: 'EDBO089957', name: 'Acabado 12345' })).toBeNull();
    expect(finishRal({ code: 'ALZ-ROJO', name: 'ALUZINC ROJO' })).toBeNull();
  });
});
