import { describe, expect, it } from 'vitest';
import {
  PERIOD_STORAGE_KEY,
  completePeriod,
  defaultPeriod,
  formatPeriodRange,
  isValidDate,
  matchPreset,
  parseStoredPeriod,
  periodError,
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

  it('un rango que termina antes de empezar', () => {
    expect(periodError({ from: '2026-10-10', to: '2026-10-01' })).toMatch(/posterior/);
  });

  it('un solo día es un rango válido', () => {
    expect(periodError({ from: TODAY, to: TODAY })).toBeNull();
  });
});

describe('predeterminado', () => {
  it('sin nada guardado, el mes en curso', () => {
    expect(defaultPeriod(TODAY, null)).toEqual({ from: '2026-10-01', to: TODAY });
  });

  it('con un periodo guardado y válido, ese', () => {
    const stored = { from: '2026-09-01', to: '2026-09-30' };
    expect(defaultPeriod(TODAY, stored)).toEqual(stored);
  });

  it('un periodo guardado inválido no se usa', () => {
    expect(defaultPeriod(TODAY, { from: '2026-10-10', to: '2026-10-01' })).toEqual({
      from: '2026-10-01',
      to: TODAY,
    });
  });

  it('completa la URL: sin fechas, el predeterminado; con una, la otra sale del mes', () => {
    const stored = { from: '2026-09-01', to: '2026-09-30' };
    expect(completePeriod({ from: '', to: '' }, TODAY, stored)).toEqual(stored);
    expect(completePeriod({ from: '2026-01-01', to: '' }, TODAY, stored)).toEqual({
      from: '2026-01-01',
      to: TODAY,
    });
    expect(completePeriod({ from: '', to: '2026-10-05' }, TODAY, null)).toEqual({
      from: '2026-10-01',
      to: '2026-10-05',
    });
  });

  it('escribe el rango al lado de los atajos', () => {
    expect(formatPeriodRange({ from: '2026-10-01', to: TODAY })).toBe(
      'Del 01/10/2026 al 07/10/2026',
    );
  });
});

describe('persistencia entre reportes', () => {
  it('guarda y vuelve a leer el periodo', () => {
    const storage = memoryStorage();
    writeStoredPeriod(storage, { from: '2026-08-01', to: '2026-08-31' });
    expect(readStoredPeriod(storage)).toEqual({ from: '2026-08-01', to: '2026-08-31' });
  });

  it('no guarda un periodo inválido', () => {
    const storage = memoryStorage();
    writeStoredPeriod(storage, { from: '2026-10-10', to: '2026-10-01' });
    expect(storage.data.size).toBe(0);
  });

  it('lo guardado roto o ajeno se ignora', () => {
    expect(parseStoredPeriod('no es json')).toBeNull();
    expect(parseStoredPeriod('{"from":1,"to":"2026-01-01"}')).toBeNull();
    expect(parseStoredPeriod('null')).toBeNull();
    expect(readStoredPeriod(memoryStorage({ [PERIOD_STORAGE_KEY]: '{"from":"x"}' }))).toBeNull();
  });

  it('sin almacenamiento, o si el navegador lo bloquea, no lanza', () => {
    expect(readStoredPeriod(null)).toBeNull();
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    expect(readStoredPeriod(blocked)).toBeNull();
    expect(() => {
      writeStoredPeriod(blocked, { from: '2026-10-01', to: TODAY });
    }).not.toThrow();
  });
});
