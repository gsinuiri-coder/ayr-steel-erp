import { describe, expect, it } from 'vitest';
import {
  listPriceWithIgv,
  posCartTotals,
  posLineAmounts,
  posLinePayload,
  seededPriceWithIgv,
} from './pos-pricing';

/** cc27 (UX26-01, D-452): el mostrador muestra con IGV y guarda sin IGV, al céntimo del comprobante. */
describe('precios del mostrador', () => {
  it('la ficha muestra el precio de lista con IGV, el mismo número que el catálogo', () => {
    expect(listPriceWithIgv('50.0000')).toBe('59.0000');
    expect(listPriceWithIgv('10.0100')).toBe('11.8118');
  });

  it('un precio que nadie tocó viaja por su valor de lista sin IGV (D-377)', () => {
    expect(
      posLinePayload({ qty: '1', priceWithIgvPen: '59.0000', listValuePen: '50.0000' }),
    ).toEqual({ unitPricePen: '50.0000' });
  });

  it('el campo se siembra al céntimo, y ese número sigue siendo el de lista (A-8)', () => {
    expect(seededPriceWithIgv('10.0100')).toBe('11.81');
    expect(seededPriceWithIgv('50.0000')).toBe('59.00');
    // Retipear el número de la ficha no cambia el total: viaja por el valor de lista.
    expect(posLinePayload({ qty: '3', priceWithIgvPen: '11.81', listValuePen: '10.0100' })).toEqual(
      { unitPricePen: '10.0100' },
    );
    expect(
      posLinePayload({ qty: '3', priceWithIgvPen: '11.8118', listValuePen: '10.0100' }),
    ).toEqual({ unitPricePen: '10.0100' });
  });

  it('un precio tipeado viaja como precio con IGV (D-255)', () => {
    expect(posLinePayload({ qty: '1', priceWithIgvPen: '55', listValuePen: '50.0000' })).toEqual({
      unitPriceWithIgvPen: '55.0000',
    });
    expect(posLinePayload({ qty: '1', priceWithIgvPen: '55', listValuePen: null })).toEqual({
      unitPriceWithIgvPen: '55.0000',
    });
  });

  it('sin precio o sin cantidad válidos la línea no tiene importe', () => {
    expect(posLinePayload({ qty: '1', priceWithIgvPen: '', listValuePen: null })).toBeNull();
    expect(posLinePayload({ qty: '1', priceWithIgvPen: 'abc', listValuePen: null })).toBeNull();
    expect(posLinePayload({ qty: '1', priceWithIgvPen: '0', listValuePen: null })).toBeNull();
    expect(posLineAmounts({ qty: '0', priceWithIgvPen: '59', listValuePen: null })).toBeNull();
    expect(posLineAmounts({ qty: '', priceWithIgvPen: '59', listValuePen: null })).toBeNull();
  });

  it('S/ 50 sin IGV: importe con IGV 59.00 y pie 50.00 + 9.00 = 59.00', () => {
    const line = posLineAmounts({
      qty: '1.000',
      priceWithIgvPen: '59.0000',
      listValuePen: '50.0000',
    });
    expect(line?.total.toFixed(2)).toBe('59.00');
    const totals = posCartTotals([line]);
    expect(totals.subtotal.toFixed(2)).toBe('50.00');
    expect(totals.igv.toFixed(2)).toBe('9.00');
    expect(totals.total.toFixed(2)).toBe('59.00');
  });

  it('el pie redondea la suma de las líneas, no cada línea (D-377)', () => {
    // Tres unidades de valor 10.01: gravada 30.03, IGV céntimo(5.4054) = 5.41, total 35.44.
    const line = posLineAmounts({ qty: '3', priceWithIgvPen: '11.8118', listValuePen: '10.0100' });
    expect(line?.subtotal.toFixed(4)).toBe('30.0300');
    const totals = posCartTotals([line]);
    expect(totals.subtotal.toFixed(2)).toBe('30.03');
    expect(totals.igv.toFixed(2)).toBe('5.41');
    expect(totals.total.toFixed(2)).toBe('35.44');
  });

  it('con un precio tipeado con IGV el total es cantidad × precio, sin perder céntimos', () => {
    // El caso de COT-000002 (D-255): 3.5 × 4194 = 14 679.00, no 14 678.99.
    const line = posLineAmounts({ qty: '3.5', priceWithIgvPen: '4194', listValuePen: null });
    expect(line?.total.toFixed(2)).toBe('14679.00');
    const totals = posCartTotals([line, null]);
    expect(totals.total.toFixed(2)).toBe('14679.00');
    expect(totals.subtotal.plus(totals.igv).toFixed(2)).toBe('14679.00');
  });
});
