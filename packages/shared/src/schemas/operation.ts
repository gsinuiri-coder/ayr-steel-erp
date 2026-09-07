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
  .refine((v) => {
    const parsed = toDateOnly(v);
    return !Number.isNaN(parsed.getTime()) && fromDateOnly(parsed) === v;
  }, 'Esa fecha no existe en el calendario');

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

export const backdatableFields = {
  operationDate: operationDateSchema.optional(),
  confirmBackdate: z.boolean().optional(),
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
