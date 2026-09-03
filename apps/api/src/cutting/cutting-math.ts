import { BadRequestException } from '@nestjs/common';
import { Decimal, toDecimal, type DecimalInput } from '@ayr/shared';

/**
 * Validación del plan de anchos de una bobina dentro de una orden de corte (RF-40).
 * A diferencia del partido interno (`planCoilSplit`), acá todavía no hay peso que
 * repartir: el tercero corta físicamente y el peso real llega recién en la recepción
 * (RF-41). Lo único que se puede validar al enviar es que el plan quepa en el ancho de
 * la bobina — igual que el primer chequeo de `planCoilSplit`, sin el resto (que necesita
 * el peso disponible del kardex).
 */
export function validateWidthBudget(
  parentWidthMm: DecimalInput,
  widths: { widthMm: DecimalInput; stripsCount: number }[],
  kerfLossMm: DecimalInput,
  label: string,
): void {
  const parentWidth = toDecimal(parentWidthMm);
  const kerf = toDecimal(kerfLossMm);
  if (kerf.isNegative()) {
    throw new BadRequestException('La merma de corte no puede ser negativa');
  }

  const widthsTotal = widths.reduce(
    (acc, w) => acc.plus(toDecimal(w.widthMm).times(w.stripsCount)),
    new Decimal(0),
  );
  const consumed = widthsTotal.plus(kerf);
  if (consumed.gt(parentWidth)) {
    throw new BadRequestException(
      `${label}: los anchos más la merma de corte (${consumed.toFixed(2)} mm) superan el ancho de la bobina (${parentWidth.toFixed(2)} mm)`,
    );
  }
}

/** Expande `{ widthMm, stripsCount }` a una entrada por tira, en orden. Mismo shape que `expandSplitWidths`. */
export function expandWidthCounts(rows: { widthMm: string; stripsCount: number }[]): string[] {
  return rows.flatMap((row) => Array.from({ length: row.stripsCount }, () => row.widthMm));
}

/**
 * Estado agregado de una orden a partir del estado de sus bobinas (RF-22, RF-40..42).
 * `PARTIALLY_RECEIVED` mientras conviven filas `SENT` y `RECEIVED`; una vez que no
 * queda ninguna `SENT`, la orden pasa a un estado terminal: `RECEIVED` si algo se llegó
 * a recibir, `CANCELLED` si todo se canceló sin recibir nada.
 */
export function deriveCuttingOrderStatus(
  rowStatuses: ('SENT' | 'RECEIVED' | 'CANCELLED')[],
): 'SENT' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED' {
  const hasSent = rowStatuses.includes('SENT');
  const hasReceived = rowStatuses.includes('RECEIVED');
  if (hasSent && hasReceived) return 'PARTIALLY_RECEIVED';
  if (hasSent) return 'SENT';
  if (hasReceived) return 'RECEIVED';
  return 'CANCELLED';
}
