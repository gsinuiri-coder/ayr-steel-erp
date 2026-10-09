import { describe, expect, it } from 'vitest';
import { Decimal } from '@ayr/shared';
import {
  displayDecimal,
  formatDateTime,
  formatKg,
  formatKgPrecise,
  formatMeters,
  formatNumber,
  formatQty,
  formatQtyAsIs,
  formatUnitQty,
} from './format';

/** cc31: las reglas de cifras a la vista (ESPEC §0, «Números»). */
describe('formato de cifras', () => {
  it('kilos a 2 decimales en listas y formularios, con redondeo y no truncado', () => {
    expect(formatKg('4027.435')).toBe('4,027.44 kg');
    expect(formatKg('4027.434')).toBe('4,027.43 kg');
    expect(formatKg('0')).toBe('0.00 kg');
    expect(formatKg(new Decimal('1000'))).toBe('1,000.00 kg');
    expect(formatKg('12.5', null)).toBe('12.50');
  });

  it('kilos del kardex y de la bobina a 3 decimales', () => {
    expect(formatKgPrecise('4500')).toBe('4,500.000 kg');
    expect(formatKgPrecise('147.5414')).toBe('147.541 kg');
  });

  it('metros a 2 decimales; el tercero solo si no es cero', () => {
    expect(formatMeters('12')).toBe('12.00 m');
    expect(formatMeters('12.000')).toBe('12.00 m');
    expect(formatMeters('4.205')).toBe('4.205 m');
    expect(formatMeters('4.2')).toBe('4.20 m');
    expect(formatMeters('1623.113')).toBe('1,623.113 m');
    expect(formatMeters('4.2049')).toBe('4.205 m');
    expect(formatMeters('4.2001')).toBe('4.20 m');
  });

  it('formatQty aplica la regla por unidad y deja las demás como vienen', () => {
    expect(formatQty('4500.000', 'kg')).toBe('4,500.00 kg');
    expect(formatQty('20.000', 'm')).toBe('20.00 m');
    expect(formatQty('20.000', 'u')).toBe('20.000 u');
    expect(formatQty('1220.00', 'mm')).toBe('1,220.00 mm');
    expect(formatQty('3500')).toBe('3,500');
  });

  it('formatUnitQty traduce la unidad SUNAT antes de formatear', () => {
    expect(formatUnitQty('89.606', 'KGM')).toBe('89.61 kg');
    expect(formatUnitQty('24.600', 'MTR')).toBe('24.60 m');
    expect(formatUnitQty('10', 'NIU')).toBe('10 u');
  });

  it('formatQtyAsIs conserva la escala para planta y bobina', () => {
    expect(formatQtyAsIs('4500.000', 'kg')).toBe('4,500.000 kg');
  });

  it('los negativos conservan el signo y el cero no lleva signo', () => {
    expect(formatNumber('-1234.5', 2)).toBe('-1,234.50');
    expect(formatNumber('-0.001', 2)).toBe('0.00');
  });
});

describe('fecha y hora', () => {
  it('muestra la hora de Lima en 24 h, sin importar la zona del navegador', () => {
    // 21:03 UTC son las 16:03 en Lima.
    expect(formatDateTime('2026-09-16T21:03:11.000Z')).toBe('16/09/2026 16:03');
    // 02:30 UTC del 8 son las 21:30 del 7 en Lima.
    expect(formatDateTime('2026-10-08T02:30:00.000Z')).toBe('07/10/2026 21:30');
    expect(formatDateTime('2026-10-08T05:00:00.000Z')).toBe('08/10/2026 00:00');
    expect(formatDateTime(null)).toBe('—');
  });
});

describe('cifras a medio escribir', () => {
  it('un texto que no es número se muestra tal cual en vez de romper la pantalla', () => {
    expect(formatKg('')).toBe(' kg');
    expect(formatKg('12 ')).toBe('12.00 kg');
    expect(formatNumber('abc', 2)).toBe('abc');
    expect(formatMeters('4,2')).toBe('4,2 m');
  });
});

describe('lo que no es cero no se muestra como cero', () => {
  it('un faltante de gramos sale con 3 decimales', () => {
    expect(formatKg('0.004')).toBe('0.004 kg');
    expect(formatKg('0.0004')).toBe('0.000 kg');
    expect(formatKg('0')).toBe('0.00 kg');
    expect(formatKg('0.005')).toBe('0.01 kg');
  });
});

describe('decimal de un campo que no se edita (cc36)', () => {
  it('al menos 2 decimales, sin ceros de más y sin perder cifras', () => {
    expect(displayDecimal('35.4000')).toBe('35.40');
    expect(displayDecimal('12.000')).toBe('12.00');
    expect(displayDecimal('9.8333')).toBe('9.8333');
    expect(displayDecimal('4.2050')).toBe('4.205');
    expect(displayDecimal('7')).toBe('7.00');
    expect(displayDecimal('')).toBe('');
    expect(displayDecimal('abc')).toBe('abc');
    expect(displayDecimal('0')).toBe('0');
  });
});
