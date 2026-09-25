/**
 * D-290: el rango de fechas del kardex. Por defecto es el **mes en curso**; los presets son
 * «Mes actual», «Mes anterior» y «Todo», y editar una fecha a mano pasa a `custom`. Todo es
 * texto `YYYY-MM-DD` de día de negocio (D-124): nada de `Date` local ni de zonas horarias.
 */
export const KARDEX_RANGES = ['month', 'prev', 'all', 'custom'] as const;
export type KardexRange = (typeof KARDEX_RANGES)[number];

export const KARDEX_RANGE_LABELS: Record<Exclude<KardexRange, 'custom'>, string> = {
  month: 'Mes actual',
  prev: 'Mes anterior',
  all: 'Todo',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value);
}

/** El valor del parámetro `range` de la URL; lo desconocido o vacío es el mes en curso. */
export function parseKardexRange(raw: string): KardexRange {
  return (KARDEX_RANGES as readonly string[]).includes(raw) ? (raw as KardexRange) : 'month';
}

export interface KardexDates {
  /** Vacío = sin cota (`Todo`, o una fecha de `custom` sin llenar). */
  from: string;
  to: string;
}

/** Último día del mes de `YYYY-MM-…` (día 0 del mes siguiente, en UTC para no depender del huso). */
function lastDayOfMonth(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Las fechas efectivas del rango. `today` es el día de negocio de hoy (`businessToday()`);
 * se recibe para que la función sea pura y se pueda probar.
 */
export function resolveKardexDates(
  range: KardexRange,
  customFrom: string,
  customTo: string,
  today: string,
): KardexDates {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  switch (range) {
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'prev': {
      const prevYear = month === 1 ? year - 1 : year;
      const prevMonth = month === 1 ? 12 : month - 1;
      return {
        from: `${String(prevYear)}-${String(prevMonth).padStart(2, '0')}-01`,
        to: lastDayOfMonth(prevYear, prevMonth),
      };
    }
    case 'all':
      return { from: '', to: '' };
    case 'custom':
      return {
        from: isIsoDate(customFrom) ? customFrom : '',
        to: isIsoDate(customTo) ? customTo : '',
      };
  }
}
