import { describe, expect, it } from 'vitest';
import { listPriceWithIgv } from './list-price';

/** cc31 (corte 6): el precio de lista con IGV que muestran el formulario y el selector. */
describe('precio de lista con IGV', () => {
  it('sin lista no hay precio', () => {
    expect(
      listPriceWithIgv({
        listPricePen: null,
        lengthMm: null,
        unit: 'MTR',
        roofingKind: 'A_MEDIDA',
      }),
    ).toBeNull();
  });

  it('por unidad de venta: el valor sin IGV por 1.18', () => {
    expect(
      listPriceWithIgv({
        listPricePen: '10.0000',
        lengthMm: null,
        unit: 'MTR',
        roofingKind: 'A_MEDIDA',
      }),
    ).toBe('11.8000');
  });

  it('una plancha de catálogo se muestra por metro, o entera con perPiece', () => {
    const plancha = {
      listPricePen: '36.0000',
      lengthMm: '3600.00',
      unit: 'NIU',
      roofingKind: 'PLANCHA',
    } as const;
    expect(listPriceWithIgv(plancha)).toBe('11.8000');
    expect(listPriceWithIgv(plancha, true)).toBe('42.4800');
  });
});
