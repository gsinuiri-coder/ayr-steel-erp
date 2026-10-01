import { formatMoney } from './quotation-pdf';

/**
 * P-14: el PDF de la cotización redondea al céntimo (HALF_UP) en vez de truncar. Antes,
 * 2,806.3172 salía «2 806.31» en el papel y 2,806.32 en la web.
 */
describe('formatMoney del PDF de cotización (P-14)', () => {
  it('redondea en vez de truncar: 2806.3172 → «2 806.32»', () => {
    expect(formatMoney('2806.3172')).toBe('2 806.32');
  });

  it('el medio céntimo sube (HALF_UP): x.xx5 → x.xx + 0.01', () => {
    expect(formatMoney('10.0050')).toBe('10.01');
    expect(formatMoney('1234.5650')).toBe('1 234.57');
    expect(formatMoney('10.0049')).toBe('10.00');
  });

  it('el redondeo que arrastra sube la parte entera y los miles', () => {
    expect(formatMoney('999999.9950')).toBe('1 000 000.00');
  });

  it('conserva el formato de miles y los dos decimales de siempre', () => {
    expect(formatMoney('1234.5000')).toBe('1 234.50');
    expect(formatMoney('0.0000')).toBe('0.00');
    expect(formatMoney('12')).toBe('12.00');
    expect(formatMoney('1234567.8900')).toBe('1 234 567.89');
  });
});
