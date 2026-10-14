import { Decimal } from '@ayr/shared';
import { backdatedCostMessage, backdatedCostMismatch } from './backdated-cost';

const at = (qty: string, value: string) => ({ qty: new Decimal(qty), value: new Decimal(value) });

describe('backdatedCostMismatch (cc52, D-648)', () => {
  it('avisa cuando el promedio de hoy no es el de la fecha', () => {
    expect(backdatedCostMismatch('70.7924', at('416', '31023.7408'), 1)).toEqual({
      costUsed: '70.7924',
      costAtDate: '74.5763',
      laterCount: 1,
    });
  });

  it('sin entradas posteriores, no avisa', () => {
    expect(backdatedCostMismatch('70.7924', at('416', '31023.7408'), 0)).toBeNull();
  });

  it('con el mismo promedio a cuatro decimales, no avisa', () => {
    expect(backdatedCostMismatch('74.5763', at('416', '31023.7408'), 3)).toBeNull();
  });

  it('una diferencia de redondeo (una diezmilésima, o menos de un céntimo en la salida) no avisa', () => {
    // 10 / 3 = 3.33333…: el promedio guardado es 3.3333.
    expect(backdatedCostMismatch('3.3333', at('3', '10'), 1, '3')).toBeNull();
    expect(backdatedCostMismatch('3.3340', at('3', '10'), 1, '1')).toBeNull();
    expect(backdatedCostMismatch('3.3400', at('3', '10'), 1, '3')?.costAtDate).toBe('3.3333');
  });

  it('sin saldo a esa fecha no hay promedio con que comparar', () => {
    expect(backdatedCostMismatch('70.7924', at('0', '0'), 2)).toBeNull();
    expect(backdatedCostMismatch('70.7924', at('-5', '0'), 2)).toBeNull();
  });

  it('un valor negativo a la fecha cuenta como cero, como el saldo corrido del kardex', () => {
    expect(backdatedCostMismatch('10.0000', at('5', '-3'), 1)?.costAtDate).toBe('0.0000');
  });

  it('el mensaje dice la fecha, el ítem, los dos costos y cómo salir', () => {
    const text = backdatedCostMessage(
      { operationDate: '2026-09-03', label: 'UPVC6MT', unit: 'NIU' },
      { costUsed: '70.7924', costAtDate: '74.5763', laterCount: 1 },
    );
    expect(text).toContain('2026-09-03');
    expect(text).toContain('UPVC6MT');
    expect(text).toContain('S/ 70.7924 por NIU');
    expect(text).toContain('S/ 74.5763');
    expect(text).toContain('Registrar igual');
  });
});
