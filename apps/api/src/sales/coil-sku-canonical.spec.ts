import { FinishKind } from '@prisma/client';
import {
  canonicalCoilSku,
  coilThicknessToken,
  commercialColorToken,
  normalizeCoilSku,
} from '@ayr/shared';

/**
 * **RF-S4b/M1 — el SKU canónico de una bobina y el normalizador único (D-252).**
 *
 * Regla del dueño: `BOB` + espesor en centésimas de mm con tres dígitos + color comercial o
 * tipo. El RAL nunca separa colores y el ancho nunca entra en el SKU. El origen (el sistema de
 * facturación del cliente) escribe el espesor con dos dígitos —`BOB38ROJO`—, así que el
 * normalizador tiene que aceptar esa forma, la canónica, la decimal y, como respaldo, la
 * descripción de la línea.
 *
 * Los códigos y descripciones de acá son **todos** los de bobina del export de ventas de
 * agosto de 2026, copiados letra por letra (sin datos de clientes).
 */

/** Los tokens que el catálogo conoce: colores comerciales y tipos sin color. */
const KNOWN = new Set(['ROJO', 'AZUL', 'VERDE', 'BLANCO', 'GRIS', 'NATURAL', 'GALVANIZADO']);

describe('D-252 — el SKU canónico se arma desde espesor + color comercial o tipo', () => {
  it('el espesor va en centésimas de mm, siempre con tres dígitos', () => {
    expect(coilThicknessToken('0.30')).toBe('030');
    expect(coilThicknessToken('0.38')).toBe('038');
    expect(coilThicknessToken('0.4')).toBe('040');
    expect(coilThicknessToken('0.45')).toBe('045');
    expect(coilThicknessToken('1.20')).toBe('120');
  });

  it('el RAL nunca separa colores: ROJO y ROJO-3020 son el mismo color comercial', () => {
    expect(commercialColorToken('ROJO')).toBe('ROJO');
    expect(commercialColorToken('ROJO-3020')).toBe('ROJO');
    expect(commercialColorToken('VERDE-6035')).toBe('VERDE');
    expect(commercialColorToken('azul')).toBe('AZUL');
  });

  it('una bobina prepintada toma su color; una sin color, su tipo', () => {
    expect(canonicalCoilSku({ kind: FinishKind.PREPINTADO, colorCode: 'ROJO' }, '0.38')).toBe(
      'BOB038ROJO',
    );
    expect(canonicalCoilSku({ kind: FinishKind.PREPINTADO, colorCode: 'ROJO-3020' }, '0.38')).toBe(
      'BOB038ROJO',
    );
    expect(canonicalCoilSku({ kind: FinishKind.NATURAL, colorCode: null }, '0.40')).toBe(
      'BOB040NATURAL',
    );
    expect(canonicalCoilSku({ kind: FinishKind.GALVANIZADO, colorCode: null }, '0.45')).toBe(
      'BOB045GALVANIZADO',
    );
  });
});

describe('D-252 — el normalizador acepta las variantes del origen y devuelve el canónico', () => {
  it.each([
    ['BOB38ROJO', 'BOB038ROJO'],
    ['BOB38AZUL', 'BOB038AZUL'],
    ['BOB038ROJO', 'BOB038ROJO'],
    ['BOB0.38ROJO', 'BOB038ROJO'],
    ['bob38rojo', 'BOB038ROJO'],
    [' BOB 38 ROJO ', 'BOB038ROJO'],
    ['BOB045GALVANIZADO', 'BOB045GALVANIZADO'],
    ['BOB45GALV', 'BOB045GALVANIZADO'],
  ])('%s → %s', (code, expected) => {
    expect(normalizeCoilSku({ code }, KNOWN)).toEqual(
      expect.objectContaining({ ok: true, sku: expected }),
    );
  });

  it.each([
    ['BOBINA ALUZINC ROJO 0.38 X 1220 RAL 3020', 'BOB038ROJO'],
    ['BOBINA ALUZINC AZUL 0.38 X 1200 RAL 5002', 'BOB038AZUL'],
  ])('descripción del Excel «%s» → %s', (description, expected) => {
    expect(normalizeCoilSku({ code: 'XYZ', description }, KNOWN)).toEqual(
      expect.objectContaining({ ok: true, sku: expected }),
    );
  });

  it('el código manda sobre la descripción cuando los dos se interpretan', () => {
    expect(
      normalizeCoilSku(
        { code: 'BOB38ROJO', description: 'BOBINA ALUZINC ROJO 0.38 X 1220 RAL 3020' },
        KNOWN,
      ),
    ).toEqual(expect.objectContaining({ ok: true, sku: 'BOB038ROJO' }));
  });

  it.each([
    // Un color que el catálogo no tiene no se inventa: la línea queda para revisión.
    [{ code: 'BOB38MORADO' }],
    // Un dígito solo no dice si son décimas o centésimas.
    [{ code: 'BOB5ROJO' }],
    // No es una bobina.
    [{ code: 'COB040BLANCO', description: 'COBERTURA DE ALUZINC 0.40MM COLOR  BLANCO' }],
    // Descripción de bobina sin color ni tipo reconocible.
    [{ code: '', description: 'BOBINA ALUZINC 0.38 X 1200' }],
  ])('no interpreta %j', (input) => {
    expect(normalizeCoilSku(input, KNOWN)).toEqual(expect.objectContaining({ ok: false }));
  });
});
