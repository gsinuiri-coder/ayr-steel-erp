import type { HttpException } from '@nestjs/common';
import { BACKDATE_COST_MISMATCH, Decimal, toDecimal, toFixedString } from '@ayr/shared';

/**
 * cc52 (D-648) — **salida con fecha atrasada que cambia de costo.**
 *
 * El kardex valoriza una salida al promedio del saldo **al grabarla** (D-028) y no recalcula
 * hacia atrás. Si la salida lleva una fecha anterior a entradas o ajustes que el ítem ya tiene
 * registrados, ese promedio incluye mercadería que, por fecha, llegó después: una compra de
 * octubre fijaba el costo de ventas de septiembre (UPVC6MT, cc52). Hasta que exista el recosteo
 * por fecha (cc53), esa salida se rechaza con los dos costos; un ADMINISTRADOR puede registrarla
 * igual y queda en la auditoría.
 *
 * Funciones puras: `InventoryService.record` lee los datos y decide con ellas.
 */

/** El saldo de un ítem con todo lo registrado hasta una fecha (inclusive), por valor. */
export interface StockAtDate {
  qty: Decimal;
  value: Decimal;
}

export interface BackdatedCostMismatch {
  /** El promedio de hoy, con el que saldría (4 decimales). */
  costUsed: string;
  /** El promedio que el ítem tenía a la fecha de la salida (4 decimales). */
  costAtDate: string;
  /** Entradas o ajustes registrados con fecha posterior. */
  laterCount: number;
}

/** Una diezmilésima: lo que el redondeo del promedio guardado puede mover el unitario. */
const UNIT_TOLERANCE = new Decimal('0.0001');
/** Un céntimo: por debajo, la diferencia en la salida es ruido de redondeo, no costo. */
const VALUE_TOLERANCE = new Decimal('0.01');

/**
 * `null` si no hay nada que avisar: sin entradas ni ajustes posteriores, sin saldo a esa fecha
 * (no hay promedio con el que comparar; ver el riesgo anotado en D-648) o con el mismo promedio
 * salvo redondeo. El promedio guardado está redondeado a cuatro decimales y el de la fecha sale
 * de sumas exactas: se avisa solo si difieren en más de una diezmilésima **y** la salida cambiaría
 * en un céntimo o más (revisión de cc52, P2).
 */
export function backdatedCostMismatch(
  currentAvgCost: Decimal | string,
  atDate: StockAtDate,
  laterCount: number,
  outQty: Decimal | string = '1',
): BackdatedCostMismatch | null {
  if (laterCount <= 0 || atDate.qty.lte(0)) return null;
  const used = toDecimal(currentAvgCost.toString());
  const value = Decimal.max(atDate.value, new Decimal(0));
  const atDateCost = value.div(atDate.qty);
  const diff = used.minus(atDateCost).abs();
  if (diff.lte(UNIT_TOLERANCE) || diff.times(outQty.toString()).lt(VALUE_TOLERANCE)) return null;
  return {
    costUsed: toFixedString(used, 'MONEY'),
    costAtDate: toFixedString(atDateCost, 'MONEY'),
    laterCount,
  };
}

/** El mensaje del rechazo: la fecha, el ítem y los dos costos, y cómo salir. */
export function backdatedCostMessage(
  input: { operationDate: string; label: string; unit: string },
  mismatch: BackdatedCostMismatch,
): string {
  return (
    `La salida del ${input.operationDate} de ${input.label} saldría al costo promedio de hoy, ` +
    `S/ ${mismatch.costUsed} por ${input.unit}, pero a esa fecha el promedio era ` +
    `S/ ${mismatch.costAtDate}: hay ${String(mismatch.laterCount)} entrada(s) o ajuste(s) con ` +
    'fecha posterior ya registrados. Registrá primero lo más antiguo; un administrador puede ' +
    'registrarla igual («Registrar igual») y queda en la auditoría con los dos costos.'
  );
}

/** Si un error es la pregunta «Registrar igual» de D-648 (no un rechazo definitivo). */
export function isBackdatedCostMismatch(err: HttpException): boolean {
  const body = err.getResponse();
  return (
    typeof body === 'object' &&
    body !== null &&
    'code' in body &&
    (body as { code?: unknown }).code === BACKDATE_COST_MISMATCH
  );
}
