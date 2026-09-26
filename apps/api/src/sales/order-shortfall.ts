import { ReservationStatus, type InventoryItemType } from '@prisma/client';
import { Decimal, toDecimal, type OrderShortfallDto } from '@ayr/shared';

/**
 * D-341 — aritmética del faltante de un pedido confirmado con faltante.
 *
 * El faltante es lo que **no se pudo reservar** y vive en `reservations.shortfall_qty`. Estas
 * funciones son puras a propósito: la regla (qué se reserva, qué queda pendiente, cómo se suma
 * para mostrarlo) se prueba sin base de datos, y el servicio solo las aplica dentro de sus locks.
 */

/**
 * Parte lo que se necesita en lo que hoy se puede reservar y lo que queda sin reservar. Nunca
 * reserva más de lo disponible ni menos de cero: un disponible negativo (material ya
 * comprometido de más por otro documento) se trata como cero, no como deuda.
 */
export function splitReservable(
  needed: Decimal,
  available: Decimal,
): { reserve: Decimal; shortfall: Decimal } {
  const positiveNeed = Decimal.max(needed, new Decimal(0));
  const reserve = Decimal.max(Decimal.min(positiveNeed, available), new Decimal(0));
  return { reserve, shortfall: positiveNeed.minus(reserve) };
}

export interface ShortfallReservationRow {
  itemType: InventoryItemType;
  itemId: string;
  unit: string;
  shortfallQty: { toString(): string };
  status: ReservationStatus;
}

/**
 * Suma el faltante por ítem prometido (para materia prima, el agregado espesor + color) de las
 * reservas **vivas**. Una reserva liberada o consumida no aporta: la liberada ya no promete nada
 * y la consumida es material que la producción ya usó, así que su faltante dejó de ser una
 * pregunta abierta del pedido.
 */
export function sumShortfalls(
  rows: readonly ShortfallReservationRow[],
  labelOf: (itemType: InventoryItemType, itemId: string) => string | undefined,
): OrderShortfallDto[] {
  const byKey = new Map<string, { label: string; unit: string; missing: Decimal }>();
  for (const row of rows) {
    if (row.status !== ReservationStatus.ACTIVE) continue;
    const missing = toDecimal(row.shortfallQty.toString());
    if (missing.lte(0)) continue;
    const key = `${row.itemType}:${row.itemId}:${row.unit}`;
    const current = byKey.get(key);
    if (current) {
      current.missing = current.missing.plus(missing);
    } else {
      byKey.set(key, {
        label: labelOf(row.itemType, row.itemId) ?? row.itemId,
        unit: row.unit,
        missing,
      });
    }
  }
  return [...byKey.values()]
    .sort((a, b) => a.label.localeCompare(b.label, 'es'))
    .map((v) => ({ label: v.label, missingQty: v.missing.toFixed(3), unit: v.unit }));
}

/**
 * El faltante pendiente de un conjunto de reservas, en la forma que va a `audit_log`: nada si no
 * hay (para no ensuciar el `before` de una anulación común), o `{ shortfalls: [...] }`.
 */
export function shortfallAudit(
  rows: readonly { id: string; shortfallQty: { toString(): string } }[],
): { shortfalls?: { reservationId: string; missingQty: string }[] } {
  const pending = rows
    .map((r) => ({ reservationId: r.id, missing: toDecimal(r.shortfallQty.toString()) }))
    .filter((r) => r.missing.gt(0))
    .map((r) => ({ reservationId: r.reservationId, missingQty: r.missing.toFixed(3) }));
  return pending.length > 0 ? { shortfalls: pending } : {};
}

/**
 * Una línea que quedó con faltante al confirmar, para el rastro de `audit_log`. Una interfaz no
 * es asignable al JSON de la auditoría; quien la escribe la copia con `{ ...line }`.
 */
export interface ShortfallLine {
  lineNumber: number;
  label: string;
  unit: string;
  promisedQty: string;
  reservedQty: string;
  missingQty: string;
}
