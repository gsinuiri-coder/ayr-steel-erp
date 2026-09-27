import {
  businessLineOf,
  comparableDocument,
  currencyOf,
  normalizeDecimal,
  paymentTermsOf,
  purchaseDocTypeOf,
  purchaseTypeOf,
  serviceKindOf,
  splitDocumentNumber,
  suggestSupplierCode,
} from '@ayr/shared';

/** D-351 — los lectores puros de la planilla de compras (`@ayr/shared`). */

describe('lectores de la planilla de compras (D-351)', () => {
  it.each([
    ['Bobinas', 'COIL'],
    ['bobina', 'COIL'],
    ['Producto terminado', 'FINISHED_GOOD'],
    ['SERVICIO', 'SERVICE'],
    ['gasto', 'EXPENSE'],
    ['compra', null],
  ])('tipo «%s» → %s', (raw, expected) => {
    expect(purchaseTypeOf(raw)).toBe(expected);
  });

  it.each([
    ['Drywall', 'drywall'],
    ['Coberturas Aluzinc', 'metallic-roofing'],
    ['metallic-roofing', 'metallic-roofing'],
    ['Reventa', 'trading'],
    ['UPVC', 'roofing'],
    ['acero', null],
  ])('línea «%s» → %s', (raw, expected) => {
    expect(businessLineOf(raw)).toBe(expected);
  });

  it('solo factura y boleta; una nota no se importa', () => {
    expect(purchaseDocTypeOf('Factura')).toBe('FACTURA');
    expect(purchaseDocTypeOf('03')).toBe('BOLETA');
    expect(purchaseDocTypeOf('Nota de crédito')).toBeNull();
  });

  it('moneda, condición de pago y tipo de servicio', () => {
    expect(currencyOf('soles')).toBe('PEN');
    expect(currencyOf('Dólares')).toBe('USD');
    expect(currencyOf('EUR')).toBeNull();
    expect(paymentTermsOf('Crédito')).toBe('CREDITO');
    expect(paymentTermsOf('a plazos')).toBeNull();
    expect(serviceKindOf('Flete')).toBe('FREIGHT');
    expect(serviceKindOf('corte tercerizado')).toBe('CUTTING');
    expect(serviceKindOf('pintura')).toBeNull();
  });

  it.each([
    ['1234,56', '1234.56'],
    ['1.234,56', '1234.56'],
    ['1,234.56', '1234.56'],
    ['1234.5', '1234.5'],
    [' 12 ', '12'],
    ['', null],
    ['abc', null],
    ['-5', null],
  ])('decimal «%s» → %s (coma decimal normalizada)', (raw, expected) => {
    expect(normalizeDecimal(raw)).toBe(expected);
  });

  it('serie-número', () => {
    expect(splitDocumentNumber('f001-00012345')).toEqual({ series: 'F001', number: '00012345' });
    expect(splitDocumentNumber('F001 - 12')).toEqual({ series: 'F001', number: '12' });
    expect(splitDocumentNumber('F001')).toBeNull();
  });

  it('forma comparable: sin espacios, mayúsculas y sin ceros a la izquierda (D-352)', () => {
    expect(comparableDocument('F001-00013071')).toBe('F001-13071');
    expect(comparableDocument('f001 - 13071')).toBe('F001-13071');
    expect(comparableDocument('E001-0')).toBe('E001-0');
    expect(comparableDocument('0013071')).toBe('13071');
  });

  it('código sugerido: iniciales de la razón social, sin la forma societaria, sin chocar', () => {
    expect(suggestSupplierCode('ACEROS ANDINOS DEL PERU S.A.C.', new Set())).toBe('AAP');
    expect(suggestSupplierCode('ACEROS ANDINOS DEL PERU S.A.C.', new Set(['AAP']))).toBe('ACE');
    expect(suggestSupplierCode('Comercial Bravo EIRL', new Set())).toMatch(/^[A-Z]{3}$/);
    // Todas las variantes de tres letras tomadas: pasa a cuatro.
    const taken = new Set<string>();
    for (const a of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      for (const b of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') taken.add(`XY${a}`.slice(0, 2) + b);
    }
    taken.add('XYZ');
    const code = suggestSupplierCode('XY', taken);
    expect(code).toMatch(/^[A-Z]{3,4}$/);
    expect(taken.has(code)).toBe(false);
  });
});
