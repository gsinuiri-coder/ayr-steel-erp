import { describe, expect, it } from 'vitest';
import {
  formatUnitSums,
  joinWithY,
  qtyError,
  sumByUnit,
  toFixText,
  ubigeoError,
} from './dispatch-form';

describe('cc31 — formulario de nuevo despacho', () => {
  it('suma por unidad con Decimal y en el orden en que aparecen', () => {
    const sums = sumByUnit([
      { qty: '12', unit: 'NIU' },
      { qty: '12.5', unit: 'MTR' },
      { qty: '8', unit: 'NIU' },
      { qty: '', unit: 'KGM' },
      { qty: '0.1', unit: 'MTR' },
    ]);
    expect(sums.map((s) => [s.unit, s.total.toFixed()])).toEqual([
      ['NIU', '20'],
      ['MTR', '12.6'],
    ]);
    expect(formatUnitSums(sums)).toBe('20 und y 12.60 m');
  });

  it('enumera con «y»', () => {
    expect(joinWithY([])).toBe('');
    expect(joinWithY(['a'])).toBe('a');
    expect(joinWithY(['a', 'b', 'c'])).toBe('a, b y c');
  });

  it('el ubigeo dice qué corregir', () => {
    expect(ubigeoError('150131')).toBeNull();
    expect(ubigeoError(' 150131 ')).toBeNull();
    expect(ubigeoError('')).toBe('Escribe el ubigeo: 6 dígitos del distrito.');
    expect(ubigeoError('1501')).toBe('Deben ser 6 dígitos; van 4.');
    expect(ubigeoError('15a1')).toBe('Solo números: el ubigeo tiene 6 dígitos.');
  });

  it('la cantidad vacía no es error; la que pasa lo pendiente sí', () => {
    expect(qtyError('', '12', 'NIU')).toBeNull();
    expect(qtyError('12', '12', 'NIU')).toBeNull();
    expect(qtyError('14', '12', 'NIU')).toBe('Quedan 12 und por despachar.');
    expect(qtyError('0', '12', 'NIU')).toBe(
      'Escribe una cantidad mayor que cero, con punto decimal.',
    );
    expect(qtyError('1,5', '12', 'NIU')).not.toBeNull();
  });

  it('cuenta lo que hay por corregir', () => {
    expect(toFixText(1)).toBe('1 dato por corregir');
    expect(toFixText(3, ['cantidad', 'cantidades'])).toBe('3 cantidades por corregir');
  });
});
