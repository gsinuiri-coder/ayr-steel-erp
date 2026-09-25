import { describe, expect, it } from 'vitest';
import { kardexCustomPatch, parseKardexRange, resolveKardexDates } from './kardex-range';

describe('resolveKardexDates (D-290)', () => {
  it('el mes actual va del primero de mes a hoy', () => {
    expect(resolveKardexDates('month', '', '', '2026-09-25')).toEqual({
      from: '2026-09-01',
      to: '2026-09-25',
    });
  });

  it('el mes anterior cubre el mes completo, también en febrero bisiesto', () => {
    expect(resolveKardexDates('prev', '', '', '2026-09-25')).toEqual({
      from: '2026-08-01',
      to: '2026-08-31',
    });
    expect(resolveKardexDates('prev', '', '', '2028-03-10')).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
    expect(resolveKardexDates('prev', '', '', '2026-03-10')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });

  it('en enero, el mes anterior es diciembre del año anterior', () => {
    expect(resolveKardexDates('prev', '', '', '2026-01-05')).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
  });

  it('«Todo» no acota', () => {
    expect(resolveKardexDates('all', '2026-01-01', '2026-02-01', '2026-09-25')).toEqual({
      from: '',
      to: '',
    });
  });

  it('un rango a mano usa las fechas de la URL y descarta las inválidas', () => {
    expect(resolveKardexDates('custom', '2026-08-10', '2026-08-20', '2026-09-25')).toEqual({
      from: '2026-08-10',
      to: '2026-08-20',
    });
    expect(resolveKardexDates('custom', 'abc', '', '2026-09-25')).toEqual({ from: '', to: '' });
  });
});

describe('kardexCustomPatch (M0 de correcciones 04)', () => {
  const shown = { from: '2026-09-01', to: '2026-09-25' };

  it('desde el mes en curso, cambiar «Desde» conserva el «Hasta» que se veía', () => {
    expect(
      kardexCustomPatch('from', '2026-08-01', { range: 'month', from: '', to: '' }, shown),
    ).toEqual({ range: 'custom', from: '2026-08-01', to: '2026-09-25' });
  });

  it('con el rango ya a mano, la otra fecha sale de la URL más reciente, no de lo pintado', () => {
    // «Desde» acaba de escribirse (URL: agosto) y lo pintado todavía es el mes en curso: escribir
    // «Hasta» no puede devolver «Desde» a septiembre.
    expect(
      kardexCustomPatch(
        'to',
        '2026-08-31',
        { range: 'custom', from: '2026-08-01', to: '2026-09-25' },
        shown,
      ),
    ).toEqual({ range: 'custom', from: '2026-08-01', to: '2026-08-31' });
  });

  it('vaciar una fecha la deja sin cota', () => {
    expect(
      kardexCustomPatch(
        'from',
        '',
        { range: 'custom', from: '2026-08-01', to: '2026-08-31' },
        shown,
      ),
    ).toEqual({ range: 'custom', from: '', to: '2026-08-31' });
  });
});

describe('parseKardexRange', () => {
  it('lo vacío o desconocido es el mes en curso', () => {
    expect(parseKardexRange('')).toBe('month');
    expect(parseKardexRange('cualquiera')).toBe('month');
    expect(parseKardexRange('all')).toBe('all');
  });
});
