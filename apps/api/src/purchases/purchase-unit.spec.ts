import { purchaseUnitMismatch } from './purchase-unit';

describe('purchaseUnitMismatch (cc69, D-729)', () => {
  it('la misma unidad pasa', () => {
    expect(purchaseUnitMismatch('ESQ30', 'BX', 'BX')).toBeNull();
  });

  it('otra unidad se rechaza nombrando las dos', () => {
    expect(purchaseUnitMismatch('ESQ30', 'BX', 'NIU')).toBe(
      'ESQ30 se lleva en Caja (BX) y la línea dice Unidad (NIU): la unidad de la compra tiene que ser la del producto. Corrige la unidad de la línea (o la del producto, si es la que está mal).',
    );
  });

  it('una unidad vieja del producto se nombra tal como está', () => {
    expect(purchaseUnitMismatch('VIEJO', 'TONELADAS', 'TNE')).toMatch(
      /^VIEJO se lleva en TONELADAS y la línea dice Tonelada \(TNE\)/,
    );
  });
});
