import { z } from 'zod';
import { businessToday } from '../business-date';

/**
 * Fecha de operación (D-124) — el **día de negocio**, en zona de Lima, al que pertenece un
 * hecho: cuándo entró la bobina, cuándo salió el despacho, cuándo se cobró.
 *
 * Existe aparte del timestamp de auditoría (`createdAt`/`at`, que sigue diciendo cuándo se
 * tipeó) porque son dos preguntas distintas, y confundirlas hace imposible cargar el
 * histórico de un mes ya cerrado: sin ella, todo lo que se registre hoy queda fechado hoy y
 * ningún reporte de agosto lo ve. Por defecto es hoy, así que el flujo normal no cambia en
 * nada; retrofecharla es privilegio de ADMINISTRADOR.
 */
export const operationDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha de operación inválida (YYYY-MM-DD)')
  // El regex acepta días que no existen: `2026-08-32` reventaba recién en Prisma, con un 500
  // dentro de la transacción, y `2026-02-31` era peor porque **no fallaba** — rodaba en
  // silencio al 2 de marzo. El ida y vuelta por `Date` es la forma barata de exigir que el
  // día exista de verdad… pero hay dos clases de fecha imposible y solo una sobrevive al
  // `Date`: `2026-02-31` rueda al 2 de marzo (y el ida y vuelta la delata), mientras que
  // `2026-08-32` o `2026-13-01` dan `Invalid Date`, y ahí `toISOString()` **lanza**
  // `RangeError` — dentro de un `refine` eso es un 500, no el 400 que corresponde.
  .refine(isCalendarDate, 'Esa fecha no existe en el calendario');

/**
 * `YYYY-MM-DD` que existe en el calendario: el ida y vuelta por `Date` delata `2026-02-31` (rueda
 * al 3 de marzo) y el `isNaN` corta `2026-08-32` o `2026-13-01` antes de que `toISOString()`
 * lance. La usan `operationDateSchema` y, desde cc33 (N5), las fechas de compras.
 */
export function isCalendarDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const parsed = toDateOnly(v);
  return !Number.isNaN(parsed.getTime()) && fromDateOnly(parsed) === v;
}

/**
 * Piso de la carga histórica. Nada se retrofecha antes de esta fecha: por debajo de ella no
 * hay operación real que cargar, solo un dedo que resbaló en el año. Es configurable por
 * entorno (`HISTORICAL_LOAD_START`) porque el mes que se carga cambia con el cliente.
 */
export const DEFAULT_HISTORICAL_LOAD_START = '2026-08-01';

/**
 * Campos que toda operación retrofechable acepta.
 *
 * `confirmBackdate` no es un permiso: es el acuse de la advertencia que el API devuelve
 * cuando el movimiento retrofechado cae **antes** de movimientos que el ítem ya tiene
 * (D-124). La regla de carga es cronológica; esto la sostiene sin construir un recálculo
 * retroactivo del promedio ponderado que producción, hoy vacía, no necesita.
 */
/**
 * Código del error que devuelve el guardrail cronológico (D-124). Viaja en el cuerpo del
 * 400 junto al mensaje para que el web sepa que **esa** falla se puede reintentar
 * confirmando, sin tener que reconocer el texto del mensaje.
 */
export const BACKDATE_OUT_OF_ORDER = 'BACKDATE_OUT_OF_ORDER';
/** cc53 (D-652): un movimiento atrasado que dejaría el kardex en negativo; trae `firstValidDate`. */
export const BACKDATE_NEGATIVE_STOCK = 'BACKDATE_NEGATIVE_STOCK';

/** cc54: los datos del rechazo de D-652, en el cuerpo del 400 (`negativeStock`). */
export interface BackdateNegativeStock {
  /** Qué se intentó, en infinitivo y con su contexto: «Registrar esta salida». */
  action: string;
  /** `YYYY-MM-DD` pedida. */
  operationDate: string;
  /** SKU o código de bobina. */
  item: string;
  /** Cantidad, en texto decimal. */
  qty: string;
  /** Código de unidad (KGM, NIU, MTR…). */
  unit: string;
  /** Primera fecha en que cabe (`YYYY-MM-DD`), o null si ni hoy alcanza. */
  firstValidDate: string | null;
}

const SHORT_UNITS: Record<string, string> = { KGM: 'kg', NIU: 'u', MTR: 'm', TNE: 't' };

/** `YYYY-MM-DD` → `DD/MM/YYYY`; cualquier otra cosa, tal cual. */
export function dayMonthYear(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${m[3] ?? ''}/${m[2] ?? ''}/${m[1] ?? ''}` : date;
}

/**
 * cc54 (P2-3 y P3-3 de la revisión de cc53): el texto del rechazo de D-652, el mismo en todos los
 * caminos (despacho, producción, corte, partido, anulaciones, compras). Fechas como se leen en
 * Perú, la cantidad sin ceros de relleno y la salida que se propone.
 */
export function backdateNegativeStockMessage(x: BackdateNegativeStock): string {
  const qty = x.qty.includes('.') ? x.qty.replace(/\.?0+$/, '') : x.qty;
  const unit = SHORT_UNITS[x.unit] ?? x.unit;
  return (
    `${x.action} con fecha ${dayMonthYear(x.operationDate)} (${qty} ${unit}) dejaría el kardex de ` +
    `${x.item} en negativo en una fecha posterior. ` +
    (x.firstValidDate
      ? `Puedes hacerlo con fecha ${dayMonthYear(x.firstValidDate)} o posterior.`
      : 'No alcanza el stock ni con la fecha de hoy.')
  );
}

export const backdatableFields = {
  operationDate: operationDateSchema.optional(),
  confirmBackdate: z.boolean().optional(),
  // cc53 (D-650): el recosteo por fecha reemplazó el bloqueo de D-648 («Registrar igual»).
} as const;

export const backdatableSchema = z.object(backdatableFields);
export type BackdatableInput = z.infer<typeof backdatableSchema>;

/**
 * `YYYY-MM-DD` → el `Date` que Postgres guarda en una columna `DATE`.
 *
 * Prisma mapea `@db.Date` a medianoche **UTC**; construirlo con `new Date('2026-08-01')`
 * sin la hora explícita depende del huso del proceso y desplaza el día en cualquier
 * servidor que no corra en UTC.
 */
export function toDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** El inverso de {@link toDateOnly}: una columna `DATE` de vuelta a `YYYY-MM-DD`. */
export function fromDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** `YYYY-MM` → primer día de ese mes, en `YYYY-MM-DD`. */
export function startOfMonth(month: string): string {
  return `${month}-01`;
}

/** `YYYY-MM` → primer día del mes **siguiente**, en `YYYY-MM-DD`. Corte superior exclusivo. */
export function startOfNextMonth(month: string): string {
  const [year, mon] = month.split('-').map(Number);
  if (!year || !mon) throw new Error(`Mes inválido: ${month}`);
  const nextYear = mon === 12 ? year + 1 : year;
  const nextMonth = mon === 12 ? 1 : mon + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`;
}

/** Último día del mes, en `YYYY-MM-DD`. Corte superior inclusivo, para mostrar el rango. */
export function endOfMonth(month: string): string {
  const next = toDateOnly(startOfNextMonth(month));
  next.setUTCDate(next.getUTCDate() - 1);
  return fromDateOnly(next);
}

/** El mes de hoy en Lima, en `YYYY-MM`. Valor por defecto de un reporte mensual. */
export function businessMonth(now: Date = new Date()): string {
  return businessToday(now).slice(0, 7);
}

export const monthSchema = z.string().regex(/^\d{4}-\d{2}$/, 'Mes inválido (YYYY-MM)');
