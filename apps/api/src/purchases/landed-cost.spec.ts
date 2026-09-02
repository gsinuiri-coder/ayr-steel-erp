import { Decimal } from '@ayr/shared';
import { prorateByWeight } from './landed-cost';

function total(shares: { amountPen: Decimal }[]): string {
  return shares.reduce((acc, s) => acc.plus(s.amountPen), new Decimal(0)).toFixed(4);
}

describe('prorateByWeight (D-043, landed cost por kilo)', () => {
  it('reparte en proporción al peso de cada bobina', () => {
    const shares = prorateByWeight('1000.0000', [
      { id: 'a', qtyKg: '2000.000' },
      { id: 'b', qtyKg: '3000.000' },
    ]);

    expect(shares.map((s) => s.amountPen.toFixed(4))).toEqual(['400.0000', '600.0000']);
    expect(total(shares)).toBe('1000.0000');
  });

  it('la suma de las partes es exactamente el monto, sin céntimos perdidos', () => {
    // 100 entre 3 bobinas iguales: 33.3333 no cierra, el acumulado sí.
    const shares = prorateByWeight('100.0000', [
      { id: 'a', qtyKg: '1.000' },
      { id: 'b', qtyKg: '1.000' },
      { id: 'c', qtyKg: '1.000' },
    ]);

    expect(total(shares)).toBe('100.0000');
    expect(shares.map((s) => s.amountPen.toFixed(4))).toEqual(['33.3333', '33.3334', '33.3333']);
  });

  it('una bobina que pesa el doble recibe el doble de flete', () => {
    const shares = prorateByWeight('900.0000', [
      { id: 'chica', qtyKg: '1000.000' },
      { id: 'grande', qtyKg: '2000.000' },
    ]);
    expect(shares[0]?.amountPen.toFixed(4)).toBe('300.0000');
    expect(shares[1]?.amountPen.toFixed(4)).toBe('600.0000');
  });

  it('devuelve vacío si no hay kilos donde imputar', () => {
    expect(prorateByWeight('500.0000', [])).toEqual([]);
    expect(prorateByWeight('500.0000', [{ id: 'a', qtyKg: '0.000' }])).toEqual([]);
  });

  it('admite un monto negativo (anulación del servicio) y también cierra', () => {
    const shares = prorateByWeight('-1000.0000', [
      { id: 'a', qtyKg: '2000.000' },
      { id: 'b', qtyKg: '3000.000' },
    ]);
    expect(shares.map((s) => s.amountPen.toFixed(4))).toEqual(['-400.0000', '-600.0000']);
    expect(total(shares)).toBe('-1000.0000');
  });
});
