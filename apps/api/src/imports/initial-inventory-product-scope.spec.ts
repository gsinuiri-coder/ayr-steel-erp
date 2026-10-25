import { BusinessLineCode, Prisma } from '@prisma/client';
import { productScopeError } from './initial-inventory-product-import.service';

/**
 * D-207 y D-712 (dw-03) — qué productos entran en la carga inicial. Compra-reventa de UPVC y
 * Reventa como hasta hoy; perfiles de Drywall fabricados por unidades con su ficha completa; nada
 * más. Si al perfil le falta un dato, el motivo lo nombra.
 */

const dec = (v: string | null) => (v === null ? null : new Prisma.Decimal(v));

function profile(overrides: Partial<Parameters<typeof productScopeError>[0]> = {}) {
  return {
    unit: 'NIU',
    source: 'MANUFACTURED' as const,
    businessLine: { code: BusinessLineCode.DRYWALL },
    thicknessMm: dec('0.43'),
    widthMm: dec('124'),
    lengthMm: dec('3000'),
    pieceWeightKg: dec('1.32'),
    ...overrides,
  };
}

const purchased = (code: BusinessLineCode) =>
  profile({
    source: 'PURCHASED',
    businessLine: { code },
    thicknessMm: null,
    widthMm: null,
    lengthMm: null,
    pieceWeightKg: null,
  });

describe('productScopeError (D-207, D-712)', () => {
  it('UPVC y Reventa compradas entran sin ficha de dimensiones', () => {
    expect(productScopeError(purchased(BusinessLineCode.ROOFING))).toBeNull();
    expect(productScopeError(purchased(BusinessLineCode.TRADING))).toBeNull();
  });

  it('un fabricado de UPVC o Reventa sigue fuera', () => {
    const manufactured = {
      ...purchased(BusinessLineCode.TRADING),
      source: 'MANUFACTURED' as const,
    };
    expect(productScopeError(manufactured)).toMatch(/producto fabricado/);
  });

  it('el perfil de Drywall fabricado por unidades y con la ficha completa entra', () => {
    expect(productScopeError(profile())).toBeNull();
  });

  it('coberturas fabricadas sigue fuera, con o sin ficha', () => {
    expect(
      productScopeError(profile({ businessLine: { code: BusinessLineCode.METALLIC_ROOFING } })),
    ).toMatch(/ni un perfil de Drywall/);
    expect(productScopeError(purchased(BusinessLineCode.METALLIC_ROOFING))).toMatch(
      /ni un perfil de Drywall/,
    );
  });

  it('un SKU de Drywall comprado no entra por esta vía', () => {
    expect(productScopeError(profile({ source: 'PURCHASED' }))).toMatch(
      /no es un perfil fabricado/,
    );
  });

  it('un perfil que no va en unidades se rechaza nombrando la unidad', () => {
    expect(productScopeError(profile({ unit: 'MTR' }))).toMatch(/en MTR: .*unidades \(NIU\)/);
  });

  it.each([
    ['thicknessMm', 'el espesor'],
    ['widthMm', 'el ancho del fleje'],
    ['lengthMm', 'el largo'],
    ['pieceWeightKg', 'el peso por pieza'],
  ] as const)('sin %s se rechaza nombrando %s', (field, label) => {
    expect(productScopeError(profile({ [field]: null }))).toBe(
      `al perfil le falta en el catálogo ${label}. Complétalo antes de cargarlo.`,
    );
    expect(productScopeError(profile({ [field]: dec('0') }))).toContain(label);
  });

  it('si faltan varios, los nombra todos', () => {
    expect(productScopeError(profile({ thicknessMm: null, pieceWeightKg: null }))).toBe(
      'al perfil le falta en el catálogo el espesor, el peso por pieza. Complétalo antes de cargarlo.',
    );
  });
});
