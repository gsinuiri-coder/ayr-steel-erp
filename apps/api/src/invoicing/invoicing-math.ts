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
 * Cuánto del material reservado se lleva un despacho parcial (D-074).
 *
 * La reserva de la línea (D-066) respalda **toda** la línea del pedido, y no siempre en la
 * misma unidad: una cobertura se vende por pieza y se reserva en kilos de una bobina. Si se
 * despacha una parte, se lleva la parte proporcional de esa reserva — y esa, no la cantidad
 * de venta, es la que sale del kardex y la que se descuenta de la promesa.
 *
 * Se llama `proratedQty` y no `proratedWeightKg` porque el resultado está en la unidad de
 * la **reserva**: llamarlo peso hacía creer que siempre eran kilos.
 */
export function proratedQty(
  dispatchQty: DecimalInput,
  orderedQty: DecimalInput,
  reserveQty: DecimalInput,
): Decimal {
  const ordered = toDecimal(orderedQty);
  if (ordered.lte(0)) return new Decimal(0);
  return toDecimal(reserveQty).times(toDecimal(dispatchQty)).div(ordered);
}
