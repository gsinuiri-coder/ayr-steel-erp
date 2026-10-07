import { describe, expect, it } from 'vitest';
import {
  PERIOD_STORAGE_KEY,
  completePeriod,
  defaultMonth,
  defaultPeriod,
  formatPeriodRange,
  fullMonth,
  isValidDate,
  isValidMonth,
  matchMonthPreset,
  matchPreset,
  monthError,
  monthPeriod,
  parseStoredPeriod,
  periodError,
  periodMonth,
  presetMonth,
  presetPeriod,
  readStoredPeriod,
  writeStoredPeriod,
} from './report-period';

/** cc32 — el periodo de la plantilla de reportes. */
const TODAY = '2026-10-07';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe('atajos de periodo', () => {
  it('este mes va del primero a hoy', () => {
    expect(presetPeriod('this-month', TODAY)).toEqual({ from: '2026-10-01', to: '2026-10-07' });
  });

  it('el mes anterior es entero, con su último día real', () => {
    expect(presetPeriod('last-month', TODAY)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(presetPeriod('last-month', '2026-03-15')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(presetPeriod('last-month', '2028-03-01')).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
  });

  it('el mes anterior a enero es diciembre del año pasado', () => {
    expect(presetPeriod('last-month', '2026-01-10')).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
  });

  it('los últimos 3 meses son este mes y los dos anteriores, hasta hoy', () => {
    expect(presetPeriod('last-3-months', TODAY)).toEqual({ from: '2026-08-01', to: TODAY });
    expect(presetPeriod('last-3-months', '2026-02-05')).toEqual({
      from: '2025-12-01',
      to: '2026-02-05',
    });
  });

  it('este año va del 1 de enero a hoy', () => {
    expect(presetPeriod('this-year', TODAY)).toEqual({ from: '2026-01-01', to: TODAY });
  });

  it('reconoce el atajo de un periodo y deja el resto como rango libre', () => {
    expect(matchPreset({ from: '2026-09-01', to: '2026-09-30' }, TODAY)).toBe('last-month');
    expect(matchPreset({ from: '2026-10-01', to: TODAY }, TODAY)).toBe('this-month');
    expect(matchPreset({ from: '2026-10-02', to: TODAY }, TODAY)).toBeNull();
  });

  it('en enero, «Este año» y «Este mes» coinciden: manda el atajo elegido', () => {
    const january = '2026-01-15';
    const period = { from: '2026-01-01', to: january };
    expect(matchPreset(period, january, 'this-year')).toBe('this-year');
    expect(matchPreset(period, january, 'this-month')).toBe('this-month');
    // Un atajo elegido que ya no describe el periodo no se impone.
    expect(matchPreset({ from: '2025-12-01', to: '2025-12-31' }, january, 'this-year')).toBe(
      'last-month',
    );
  });
});

describe('rango inválido', () => {
  it('fechas que no existen o mal escritas', () => {
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2026-13-01')).toBe(false);
    expect(isValidDate('2026-1-01')).toBe(false);
    expect(isValidDate('')).toBe(false);
    expect(isValidDate('2028-02-29')).toBe(true);
    expect(periodError({ from: '2026-02-30', to: TODAY })).not.toBeNull();
  });

  it('un año a medio teclear (0002) o fuera de rango no es un periodo', () => {
    expect(periodError({ from: '0002-10-01', to: TODAY })).toMatch(/año/);
    expect(periodError({ from: '1999-12-31', to: TODAY })).toMatch(/año/);
    expect(periodError({ from: '2026-10-01', to: '2101-01-01' })).toMatch(/año/);
    expect(periodError({ from: '2000-01-01', to: '2100-12-31' })).toBeNull();
  });

  it('un rango que termina antes de empezar', () => {
    expect(periodError({ from: '2026-10-10', to: '2026-10-01' })).toMatch(/posterior/);
  });

  it('un solo día es un rango válido', () => {
    expect(periodError({ from: TODAY, to: TODAY })).toBeNull();
  });
});

describe('predeterminado', () => {
  it('sin nada guardado, el mes en curso', () => {
    expect(defaultPeriod(TODAY, null)).toEqual({
      from: '2026-10-01',
      to: TODAY,
      preset: 'this-month',
    });
  });

  it('con un periodo guardado y válido, ese', () => {
    const stored = { from: '2026-09-01', to: '2026-09-15', preset: null };
    expect(defaultPeriod(TODAY, stored)).toEqual(stored);
  });

  it('un periodo guardado inválido no se usa', () => {
    expect(defaultPeriod(TODAY, { from: '2026-10-10', to: '2026-10-01', preset: null })).toEqual({
      from: '2026-10-01',
      to: TODAY,
      preset: 'this-month',
    });
  });

  it('completa la URL: sin fechas, el predeterminado; con una, la otra sale del mes', () => {
    const stored = { from: '2026-09-01', to: '2026-09-15', preset: null };
    expect(completePeriod({ from: '', to: '' }, TODAY, stored)).toEqual(stored);
    expect(completePeriod({ from: '2026-01-01', to: '' }, TODAY, stored)).toEqual({
      from: '2026-01-01',
      to: TODAY,
      preset: null,
    });
    expect(completePeriod({ from: '', to: '2026-10-05' }, TODAY, null)).toEqual({
      from: '2026-10-01',
      to: '2026-10-05',
      preset: null,
    });
  });

  it('escribe el rango al lado de los atajos', () => {
    expect(formatPeriodRange({ from: '2026-10-01', to: TODAY })).toBe(
      'Del 01/10/2026 al 07/10/2026',
    );
  });
});

describe('persistencia entre reportes', () => {
  it('un rango libre se guarda con sus fechas', () => {
    const storage = memoryStorage();
    writeStoredPeriod(storage, { from: '2026-08-03', to: '2026-08-20' }, null, TODAY);
    expect(storage.data.get(PERIOD_STORAGE_KEY)).toBe('{"from":"2026-08-03","to":"2026-08-20"}');
    expect(readStoredPeriod(storage, '2026-12-01')).toEqual({
      from: '2026-08-03',
      to: '2026-08-20',
      preset: null,
    });
  });

  it('un atajo se guarda como atajo y se resuelve con la fecha del día en que se lee', () => {
    const storage = memoryStorage();
    writeStoredPeriod(storage, presetPeriod('this-month', TODAY), 'this-month', TODAY);
    expect(storage.data.get(PERIOD_STORAGE_KEY)).toBe('{"preset":"this-month"}');
    // Al día siguiente, «Este mes» llega hasta el día siguiente.
    expect(readStoredPeriod(storage, '2026-10-08')).toEqual({
      from: '2026-10-01',
      to: '2026-10-08',
      preset: 'this-month',
    });
    // Y el mes siguiente, es el mes nuevo.
    expect(readStoredPeriod(storage, '2026-11-02')).toEqual({
      from: '2026-11-01',
      to: '2026-11-02',
      preset: 'this-month',
    });
  });

  it('un rango libre que coincide con un atajo se guarda como atajo', () => {
    const storage = memoryStorage();
    writeStoredPeriod(storage, { from: '2026-09-01', to: '2026-09-30' }, null, TODAY);
    expect(storage.data.get(PERIOD_STORAGE_KEY)).toBe('{"preset":"last-month"}');
  });

  it('en enero se guarda el atajo elegido, no el primero que coincide', () => {
    const storage = memoryStorage();
    const january = '2026-01-15';
    writeStoredPeriod(storage, presetPeriod('this-year', january), 'this-year', january);
    expect(storage.data.get(PERIOD_STORAGE_KEY)).toBe('{"preset":"this-year"}');
    expect(readStoredPeriod(storage, '2026-03-01')?.from).toBe('2026-01-01');
  });

  it('no guarda un periodo inválido, tampoco un año a medio teclear', () => {
    const storage = memoryStorage();
    writeStoredPeriod(storage, { from: '2026-10-10', to: '2026-10-01' }, null, TODAY);
    writeStoredPeriod(storage, { from: '0002-10-01', to: TODAY }, null, TODAY);
    expect(storage.data.size).toBe(0);
  });

  it('lo guardado roto o ajeno se ignora', () => {
    expect(parseStoredPeriod('no es json', TODAY)).toBeNull();
    expect(parseStoredPeriod('{"from":1,"to":"2026-01-01"}', TODAY)).toBeNull();
    expect(parseStoredPeriod('{"preset":"ayer"}', TODAY)).toBeNull();
    expect(parseStoredPeriod('{"from":"0002-01-01","to":"2026-01-01"}', TODAY)).toBeNull();
    expect(parseStoredPeriod('null', TODAY)).toBeNull();
    expect(
      readStoredPeriod(memoryStorage({ [PERIOD_STORAGE_KEY]: '{"from":"x"}' }), TODAY),
    ).toBeNull();
  });

  it('sin almacenamiento, o si el navegador lo bloquea, no lanza', () => {
    expect(readStoredPeriod(null, TODAY)).toBeNull();
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    expect(readStoredPeriod(blocked, TODAY)).toBeNull();
    expect(() => {
      writeStoredPeriod(blocked, { from: '2026-10-01', to: TODAY }, 'this-month', TODAY);
    }).not.toThrow();
  });
});

describe('mes del Reporte mensual de bobinas (cc32, corte 2)', () => {
  it('valida el mes', () => {
    expect(isValidMonth('2026-09')).toBe(true);
    expect(isValidMonth('2026-13')).toBe(false);
    expect(isValidMonth('2026-9')).toBe(false);
    expect(monthError('nada')).toBe('El mes no es válido: revisa la fecha.');
    expect(monthError('2026-09')).toBeNull();
  });

  it('atajos y el atajo que corresponde', () => {
    expect(presetMonth('this-month', TODAY)).toBe('2026-10');
    expect(presetMonth('last-month', TODAY)).toBe('2026-09');
    expect(presetMonth('last-month', '2026-01-15')).toBe('2025-12');
    expect(matchMonthPreset('2026-09', TODAY)).toBe('last-month');
    expect(matchMonthPreset('2026-08', TODAY)).toBeNull();
  });

  it('el mes de un periodo es el de su fecha final, sin pasar del mes en curso', () => {
    expect(periodMonth({ from: '2026-09-01', to: '2026-09-30' }, TODAY)).toBe('2026-09');
    expect(periodMonth({ from: '2026-08-01', to: '2026-12-31' }, TODAY)).toBe('2026-10');
    expect(defaultMonth(TODAY, null)).toBe('2026-10');
    expect(defaultMonth(TODAY, { from: '2026-07-01', to: '2026-07-31' })).toBe('2026-07');
    expect(defaultMonth(TODAY, { from: '2026-07-31', to: '2026-07-01' })).toBe('2026-10');
  });

  it('el periodo que se recuerda al elegir un mes', () => {
    expect(fullMonth('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthPeriod('2026-09', TODAY)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(monthPeriod('2026-10', TODAY)).toEqual({ from: '2026-10-01', to: TODAY });
  });
});

describe('mes fuera de los años admitidos (cc32, corte 2)', () => {
  it('rechaza un año fuera de 2000..2100', () => {
    expect(monthError('1999-12')).toMatch(/entre 2000 y 2100/);
    expect(monthError('2101-01')).toMatch(/entre 2000 y 2100/);
    expect(monthError('2100-12')).toBeNull();
  });
});
