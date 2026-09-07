/**
 * El reloj del negocio. **Módulo hoja: no importa nada del paquete.**
 *
 * Vive solo, y eso no es prolijidad — es la corrección de un defecto real (D-130). Estas dos
 * cosas estaban en `schemas/sales.ts`, y cuando `schemas/operation.ts` pasó a necesitarlas se
 * cerró un ciclo de imports: `operation → sales → coil → operation`. En la salida CommonJS de
 * `tsc`, un módulo a medio inicializar no lanza: devuelve `undefined`. Así, el
 * `{ ...backdatableFields }` de `coil.ts` y `roofing.ts` esparcía `undefined` y **borraba en
 * silencio** los campos de fecha de operación de seis schemas.
 *
 * Mientras este archivo no importe nada, ningún schema puede cerrar un ciclo contra él.
 */

/**
 * Zona horaria del negocio. La empresa opera en Perú y **todas** las fechas de negocio
 * —emisión, vigencia, vencimiento, fecha de operación— son días calendario de Lima, no de UTC.
 */
export const BUSINESS_TIME_ZONE = 'America/Lima';

/**
 * El día de hoy **en Lima**, en `YYYY-MM-DD`.
 *
 * No es un detalle: Lima va cinco horas detrás de UTC, así que entre las 19:00 y la
 * medianoche hora local, `new Date().toISOString()` ya devuelve la fecha del día siguiente.
 * Con eso, una cotización válida "hasta el 10" se rechazaba por vencida durante las últimas
 * cinco horas del día 10, y el pedido nacía fechado el 11 (D-069, D-112).
 */
export function businessToday(now: Date = new Date()): string {
  // `en-CA` da directamente `YYYY-MM-DD`; `Intl` resuelve el desfase y el horario de verano
  // (que Perú no tiene, pero no hace falta asumirlo).
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
