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

/**
 * D-185: `n` días hábiles después de `isoDate` (`YYYY-MM-DD`), contando de lunes a viernes.
 * El día de partida no cuenta: reservar un viernes con 3 días hábiles vence el miércoles.
 *
 * Sin calendario de feriados a propósito: la empresa no tiene uno cargado y un feriado que
 * cae dentro del plazo solo lo acorta un día — el vendedor lo ve en "tiempo restante" y
 * vuelve a reservar.
 */
export function addBusinessDays(isoDate: string, n: number): string {
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  let remaining = n;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
}

/**
 * D-185: el instante en que vence una reserva temporal hecha hoy: el **final** del `n`-ésimo
 * día hábil en Lima. Lima no tiene horario de verano, así que el desfase fijo es exacto.
 */
export function temporaryReservationExpiry(n: number, now: Date = new Date()): Date {
  const lastDay = addBusinessDays(businessToday(now), n);
  return new Date(`${lastDay}T23:59:59.999-05:00`);
}

/**
 * D-185: una reserva temporal nunca vence después que su cotización. Pasado el último día de
 * vigencia (fin del día en Lima) ya no se puede confirmar, y seguir apartando material para algo
 * que no se puede confirmar es quitárselo a otro sin motivo. `validUntil` es la fecha
 * `YYYY-MM-DD`; `null` es sin vencimiento (D-157) y no recorta nada.
 */
export function capToQuotationValidity(expiresAt: Date, validUntil: string | null): Date {
  if (validUntil === null) return expiresAt;
  const endOfValidity = new Date(`${validUntil}T23:59:59.999-05:00`);
  return endOfValidity.getTime() < expiresAt.getTime() ? endOfValidity : expiresAt;
}
