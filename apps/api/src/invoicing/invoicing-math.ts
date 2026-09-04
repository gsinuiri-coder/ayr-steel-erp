import { Decimal, toDecimal, type DecimalInput } from '@ayr/shared';

/**
 * Aritmética y reglas de calendario del módulo (D-072..D-075).
 *
 * Todo lo de acá es **puro**: entra y sale sin tocar base ni red. Es donde viven las
 * decisiones que se pueden equivocar en silencio —cuánto queda por facturar, cuándo vence
 * una cuenta por cobrar, cuándo un documento dejó de estar "en camino"— y por eso son las
 * que tienen prueba unitaria.
 *
 * La aritmética de una **línea** no está acá a propósito: ya vive una sola vez en
 * `@ayr/shared` (`salesLineTotals`), compartida con la cotización y el pedido. Dos
 * definiciones de cómo se suma el IGV serían dos totales distintos para el mismo papel.
 */

/**
 * Vencimiento de una cuenta por cobrar (D-075): la fecha de emisión más los días de
 * crédito del cliente. Al contado no hay vencimiento y devuelve `null`.
 *
 * Suma en UTC sobre la fecha de negocio ya resuelta (`businessToday` en `@ayr/shared`),
 * no sobre `new Date()`: acá solo se corren días sobre un `YYYY-MM-DD` que alguien más ya
 * decidió en la zona horaria correcta.
 */
export function dueDateFor(issueDate: string, creditDays: number): string | null {
  if (creditDays <= 0) return null;
  const d = new Date(`${issueDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + creditDays);
  return d.toISOString().slice(0, 10);
}

/**
 * D-073: un documento emitido que el PSE todavía no aceptó y que ya pasó el umbral deja
 * de ser "en camino" y pasa a ser un problema visible.
 *
 * Sin `issuedAt` no hay nada que medir: un borrador nunca está estancado.
 */
export function isStalled(
  issuedAt: Date | null,
  alertAfterHours: number,
  now: Date = new Date(),
): boolean {
  if (!issuedAt) return false;
  const hours = (now.getTime() - issuedAt.getTime()) / 3_600_000;
  return hours >= alertAfterHours;
}

/**
 * Backoff del reintento de envío, en milisegundos (D-073). Crece al doble desde un minuto
 * y se corta en una hora: pasado eso, insistir más seguido no ayuda y solo hace ruido en
 * los logs y en la cuota del PSE.
 */
export function retryDelayMs(attempts: number): number {
  const base = 60_000;
  const capped = Math.min(Math.max(attempts, 0), 6);
  return Math.min(base * 2 ** capped, 3_600_000);
}

/**
 * Lo que **todavía se puede** despachar o facturar de una línea de pedido.
 *
 * Nunca devuelve negativo: si por algún camino se despachó de más, el pendiente es cero y
 * el problema se ve en el detalle, no en un número negativo colándose en un formulario.
 */
export function pendingQty(ordered: DecimalInput, done: DecimalInput): Decimal {
  const remaining = toDecimal(ordered).minus(toDecimal(done));
  return remaining.isNegative() ? new Decimal(0) : remaining;
}

/**
 * Suma de cantidades ya usadas por documento (despachado, facturado, acreditado), a
 * partir de las filas que las llevan. Se calcula **siempre desde las filas**, nunca desde
 * un contador almacenado: un contador se desincroniza con la primera reversa que alguien
 * olvide restar, y este proyecto tiene reversas en todas partes.
 */
export function sumByKey<T>(
  rows: T[],
  key: (row: T) => string,
  qty: (row: T) => DecimalInput,
): Map<string, Decimal> {
  const out = new Map<string, Decimal>();
  for (const row of rows) {
    const k = key(row);
    out.set(k, (out.get(k) ?? new Decimal(0)).plus(toDecimal(qty(row))));
  }
  return out;
}

/**
 * Peso de una línea de despacho cuando el usuario no lo escribió.
 *
 * La reserva de la línea (D-066) dice cuántos kilos respaldan **toda** la línea del
 * pedido; si se despacha una parte, el peso va en la misma proporción. Con la reserva en
 * la misma unidad que la venta (perfiles por pieza, bobina por kilo) esto es exacto; es
 * una estimación solo cuando las unidades difieren, y por eso el campo es editable.
 */
export function proratedWeightKg(
  dispatchQty: DecimalInput,
  orderedQty: DecimalInput,
  reserveQty: DecimalInput,
): Decimal {
  const ordered = toDecimal(orderedQty);
  if (ordered.lte(0)) return new Decimal(0);
  return toDecimal(reserveQty).times(toDecimal(dispatchQty)).div(ordered);
}
