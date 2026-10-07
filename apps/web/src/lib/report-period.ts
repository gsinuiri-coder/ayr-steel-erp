import { formatDate } from './format';

/**
 * cc32 (plantilla de reportes): el periodo de un reporte, sin React ni navegador.
 *
 * - Fechas de negocio en Lima como texto `AAAA-MM-DD` (`businessToday`): nada de `Date` local,
 *   que corre el día según el huso del navegador. `Date.UTC` se usa solo para la aritmética de
 *   calendario (último día del mes, comprobar que la fecha existe), nunca para «hoy».
 * - El periodo va siempre en la URL (`from`, `to`) con fechas absolutas, también el
 *   predeterminado; el último que se eligió se guarda en `sessionStorage` para abrir el siguiente
 *   reporte con el mismo. Un atajo se guarda como atajo («Este mes») y se resuelve con la fecha
 *   del día en que se lee: guardado como fechas, mañana ya no sería «este mes».
 */
export interface ReportPeriod {
  from: string;
  to: string;
}

export const PERIOD_PRESETS = ['this-month', 'last-month', 'last-3-months', 'this-year'] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

/** Un periodo con el atajo que lo describe, o `null` si es un rango libre. */
export interface ResolvedPeriod extends ReportPeriod {
  preset: PeriodPreset | null;
}

export const PERIOD_PRESET_LABELS: Record<PeriodPreset, string> = {
  'this-month': 'Este mes',
  'last-month': 'Mes anterior',
  'last-3-months': 'Últimos 3 meses',
  'this-year': 'Este año',
};

/** La clave del último periodo elegido, compartida por todos los reportes de la sesión. */
export const PERIOD_STORAGE_KEY = 'ayr.reportes.periodo';

/**
 * Años razonables. El campo de fecha avisa cada dígito que se teclea: sin este tope, el año
 * «0002» de camino a «2026» se consultaría y se guardaría como periodo recordado.
 */
export const MIN_YEAR = 2000;
export const MAX_YEAR = 2100;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `AAAA-MM-DD` y una fecha que existe (sin 2026-02-30). */
export function isValidDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

function daysInMonth(year: number, month: number): number {
  // El día 0 del mes siguiente es el último de este.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** El mes `offset` meses antes del de `today` (0 = el mismo), como `[año, mes]`. */
function monthBefore(today: string, offset: number): [number, number] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const index = year * 12 + (month - 1) - offset;
  return [Math.floor(index / 12), (index % 12) + 1];
}

/** El rango de un atajo, contado desde `today` (día de Lima). */
export function presetPeriod(preset: PeriodPreset, today: string): ReportPeriod {
  switch (preset) {
    case 'this-month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'last-month': {
      const [y, m] = monthBefore(today, 1);
      return {
        from: `${String(y)}-${pad(m)}-01`,
        to: `${String(y)}-${pad(m)}-${pad(daysInMonth(y, m))}`,
      };
    }
    case 'last-3-months': {
      // El mes en curso y los dos anteriores, enteros hasta hoy.
      const [y, m] = monthBefore(today, 2);
      return { from: `${String(y)}-${pad(m)}-01`, to: today };
    }
    case 'this-year':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

function samePeriod(a: ReportPeriod, b: ReportPeriod): boolean {
  return a.from === b.from && a.to === b.to;
}

/**
 * El atajo que describe exactamente este periodo, o `null` si es un rango libre. Dos atajos
 * pueden dar las mismas fechas (en enero, «Este mes» y «Este año»): manda el que se eligió
 * (`preferred`) si todavía describe el periodo.
 */
export function matchPreset(
  period: ReportPeriod,
  today: string,
  preferred: PeriodPreset | null = null,
): PeriodPreset | null {
  if (preferred !== null && samePeriod(presetPeriod(preferred, today), period)) return preferred;
  return PERIOD_PRESETS.find((p) => samePeriod(presetPeriod(p, today), period)) ?? null;
}

function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/** El motivo por el que el periodo no sirve, en palabras del usuario; `null` si sirve. */
export function periodError(period: ReportPeriod): string | null {
  if (!isValidDate(period.from) || !isValidDate(period.to)) {
    return 'El periodo no es válido: revisa las fechas.';
  }
  const years = [yearOf(period.from), yearOf(period.to)];
  if (years.some((y) => y < MIN_YEAR || y > MAX_YEAR)) {
    return `El periodo no es válido: el año tiene que estar entre ${String(MIN_YEAR)} y ${String(MAX_YEAR)}.`;
  }
  if (period.from > period.to) {
    return 'El periodo no es válido: la fecha de inicio es posterior a la de fin.';
  }
  return null;
}

/** El predeterminado: el último periodo guardado si es válido; si no, el mes en curso. */
export function defaultPeriod(today: string, stored: ResolvedPeriod | null): ResolvedPeriod {
  if (stored !== null && periodError(stored) === null) return stored;
  return { ...presetPeriod('this-month', today), preset: 'this-month' };
}

/**
 * Completa lo que le falta a la URL. Sin ninguna de las dos fechas, el predeterminado entero;
 * con una sola, la que falta sale del mes en curso (no del periodo guardado, que podría no
 * tener que ver con la fecha que sí vino).
 */
export function completePeriod(
  current: { from: string; to: string },
  today: string,
  stored: ResolvedPeriod | null,
): ResolvedPeriod {
  if (current.from === '' && current.to === '') return defaultPeriod(today, stored);
  const month = presetPeriod('this-month', today);
  return {
    from: current.from === '' ? month.from : current.from,
    to: current.to === '' ? month.to : current.to,
    preset: null,
  };
}

/** «Del 01/10/2026 al 07/10/2026». */
export function formatPeriodRange(period: ReportPeriod): string {
  return `Del ${formatDate(period.from)} al ${formatDate(period.to)}`;
}

function isPreset(value: unknown): value is PeriodPreset {
  return (PERIOD_PRESETS as readonly unknown[]).includes(value);
}

/**
 * Lo guardado, resuelto con la fecha de hoy: un atajo da sus fechas de hoy y un rango libre las
 * suyas. `null` si no se puede leer o no es un periodo válido.
 */
export function parseStoredPeriod(raw: string | null, today: string): ResolvedPeriod | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { preset, from, to } = value as Record<string, unknown>;
    if (isPreset(preset)) return { ...presetPeriod(preset, today), preset };
    if (typeof from !== 'string' || typeof to !== 'string') return null;
    const period = { from, to };
    return periodError(period) === null ? { ...period, preset: null } : null;
  } catch {
    return null;
  }
}

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

/**
 * El almacenamiento de la sesión, o `null` si el navegador no lo deja usar (ventana privada,
 * datos bloqueados, servidor). Nunca lanza.
 */
export function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStoredPeriod(
  storage: ReadableStorage | null,
  today: string,
): ResolvedPeriod | null {
  if (storage === null) return null;
  try {
    return parseStoredPeriod(storage.getItem(PERIOD_STORAGE_KEY), today);
  } catch {
    return null;
  }
}

/**
 * Guarda el periodo: el atajo si lo describe (`preset`, comprobado contra `today`), y si no, las
 * dos fechas. Un periodo inválido no se guarda.
 */
export function writeStoredPeriod(
  storage: WritableStorage | null,
  period: ReportPeriod,
  preset: PeriodPreset | null,
  today: string,
): void {
  if (storage === null || periodError(period) !== null) return;
  const matched = matchPreset(period, today, preset);
  const value = matched === null ? { from: period.from, to: period.to } : { preset: matched };
  try {
    storage.setItem(PERIOD_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Sin almacenamiento, el periodo sigue en la URL; solo no se recuerda.
  }
}
