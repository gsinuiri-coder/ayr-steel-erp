import { describe, expect, it } from 'vitest';
import type { ProductDto } from '@ayr/shared';
import { drywallProfilesOf, isActiveDrywallProfile } from './drywall-profiles';

/** D-344 — qué perfiles de drywall se ofrecen en planta y corte: solo los del SKU completo. */

function product(over: Partial<ProductDto> = {}): ProductDto {
  return {
    id: 'p-1',
    businessLineId: 'bl-1',
    businessLineCode: 'drywall',
    sku: 'OMEGA045',
    name: 'OMEGA',
    unit: 'NIU',
    listPricePen: null,
    colorId: null,
    colorCode: null,
    colorName: null,
    colorHex: null,
    finishId: null,
    finishCode: null,
    finishName: null,
    densityFactor: null,
    thicknessMm: '0.45',
    widthMm: '115.00',
    lengthMm: '3000.00',
    pieceWeightKg: '1.220',
    roofingKind: null,
    theoreticalKgPerUnit: null,
    isActive: true,
    source: 'MANUFACTURED',
    noFloorReason: null,
    pieceWeightCheck: null,
    canDelete: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('drywallProfilesOf', () => {
  it('un perfil con espesor, ancho y peso se ofrece, con el ancho del fleje del SKU', () => {
    const { ready, incomplete } = drywallProfilesOf([product()]);
    expect(ready).toEqual([
      {
        productId: 'p-1',
        sku: 'OMEGA045',
        name: 'OMEGA',
        thicknessMm: '0.45',
        widthMm: '115.00',
        pieceWeightKg: '1.220',
      },
    ]);
    expect(incomplete).toEqual([]);
  });

  it.each([
    ['sin espesor', { thicknessMm: null }],
    ['sin ancho', { widthMm: null }],
    ['sin peso', { pieceWeightKg: null }],
    ['con peso en cero', { pieceWeightKg: '0.000' }],
  ])('%s: no se ofrece y se lista como incompleto', (_n, over) => {
    const p = product(over);
    const { ready, incomplete } = drywallProfilesOf([p]);
    expect(ready).toEqual([]);
    expect(incomplete).toEqual([p]);
  });

  it('no cuenta lo que no es un perfil de drywall fabricado, activo y en piezas', () => {
    const others = [
      product({ id: 'a', isActive: false }),
      product({ id: 'b', businessLineCode: 'trading' }),
      product({ id: 'c', source: 'PURCHASED' }),
      // Un perfil fabricado pero medido en kilos: el API lo rechazaría con «se debe medir en
      // unidades (NIU)» (D-055), así que ni siquiera se ofrece.
      product({ id: 'd', unit: 'KGM' }),
    ];
    expect(drywallProfilesOf(others)).toEqual({ ready: [], incomplete: [] });
    expect(others.map(isActiveDrywallProfile)).toEqual([false, false, false, false]);
  });
});
