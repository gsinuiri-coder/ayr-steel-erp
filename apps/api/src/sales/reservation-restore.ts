import {
  InventoryItemType,
  ReservationStatus,
  SalesOrderStatus,
  type Prisma,
} from '@prisma/client';
import { Decimal, toDecimal } from '@ayr/shared';

/**
 * D-379: la reserva de producto terminado de una línea que se fabrica contra el pedido.
 *
 * Una línea así **solo se despacha desde esa reserva** (`resolveDispatchTarget`, D-088/D-171):
 * no vuelve nunca a la materia prima. Liberarla a mano dejaba la línea sin camino de despacho
 * y sin forma de reponerla —«Completar reserva» (D-341) no toma una liberada— y es lo que trabó
 * FFA1-00001382 (`docs/analisis/ffa1-1382-2026-10-01.md`). Esta pieza hace las dos mitades:
 *
 * 1. **El bloqueo:** esa reserva no se libera a mano mientras cubra producto fabricado sin
 *    despachar (`fabricatedReleaseBlock`).
 * 2. **La reversa:** una reserva de producto liberada **a mano** se restaura (`restorable`,
 *    `restoreQty`). Una cerrada por despacho, por producción o por anular el pedido, no.
 *
 * Sin migración: lo que separa una liberación manual de las demás ya está en el dato. Es la única
 * que deja `qty` con la cantidad que prometía —cancelar, cambiar cantidad o bobina, la reversa de
 * producción y el cierre de la OP la ponen en cero— y la única que escribe
 * `sales.reservation.release` en `audit_log`.
 */

export const RESERVATION_RELEASE_ACTION = 'sales.reservation.release';
export const RESERVATION_RESTORE_ACTION = 'sales.reservation.restore';

/** Lo que hace falta leer de la línea del pedido (`ReservationLine`). */
export const RESERVATION_LINE_SELECT = {
  lineNumber: true,
  productId: true,
  qty: true,
  unit: true,
  reserveItemType: true,
  reserveItemId: true,
} as const;

/** La línea del pedido, con lo que decide si se fabrica contra él. */
export interface ReservationLine {
  lineNumber: number;
  productId: string;
  qty: { toString(): string };
  unit: string;
  reserveItemType: InventoryItemType;
  reserveItemId: string;
}

/**
 * ¿La reserva es la del **producto terminado** de una línea que se fabrica contra el pedido?
 *
 * Es el mismo criterio que `resolveDispatchTarget`: la línea no está respaldada por su propio
 * producto desde que se confirmó (reservó materia prima), y la reserva es sobre ese producto.
 * Un perfil o una plancha vendidos de stock reservan el producto desde el principio y no entran.
 */
export function isFabricatedLineReservation(
  reservation: { itemType: InventoryItemType; itemId: string },
  line: Pick<ReservationLine, 'productId' | 'reserveItemType' | 'reserveItemId'>,
): boolean {
  const backedByProduct =
    line.reserveItemType === InventoryItemType.PRODUCT && line.reserveItemId === line.productId;
  return (
    !backedByProduct &&
    reservation.itemType === InventoryItemType.PRODUCT &&
    reservation.itemId === line.productId
  );
}

/**
 * El motivo por el que esa reserva **no** se libera a mano, o `null` si se puede.
 *
 * Mientras esté activa con cantidad, cubre metros (o piezas) ya fabricados que todavía no
 * salieron: liberarla deja la línea sin despacho posible. Anular el pedido sigue liberándola
 * como siempre; esto solo corta la liberación suelta.
 */
export function fabricatedReleaseBlock(
  reservation: {
    itemType: InventoryItemType;
    itemId: string;
    status: ReservationStatus;
    qty: { toString(): string };
    unit: string;
  },
  line: ReservationLine,
): string | null {
  if (reservation.status !== ReservationStatus.ACTIVE) return null;
  if (!isFabricatedLineReservation(reservation, line)) return null;
  const qty = toDecimal(reservation.qty.toString());
  if (qty.lte(0)) return null;
  return (
    `La línea ${String(line.lineNumber)} se fabrica contra el pedido y esta reserva cubre ` +
    `${qty.toFixed(3)} ${reservation.unit} ya fabricados que todavía no se despacharon: no se ` +
    'libera a mano. Despacha la línea, revierte la producción o anula el pedido.'
  );
}

/** El último evento de liberación o restauración de cada reserva, en una sola consulta. */
export async function latestReleaseEvents(
  db: Prisma.TransactionClient,
  reservationIds: readonly string[],
): Promise<Map<string, { action: string; at: Date; reason: string | null }>> {
  const out = new Map<string, { action: string; at: Date; reason: string | null }>();
  if (reservationIds.length === 0) return out;
  const rows = await db.auditLog.findMany({
    where: {
      entity: 'reservations',
      entityId: { in: [...reservationIds] },
      action: { in: [RESERVATION_RELEASE_ACTION, RESERVATION_RESTORE_ACTION] },
    },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    select: { entityId: true, action: true, at: true, after: true },
  });
  for (const row of rows) {
    if (row.entityId === null || out.has(row.entityId)) continue;
    const after = row.after as { reason?: unknown } | null;
    out.set(row.entityId, {
      action: row.action,
      at: row.at,
      reason: typeof after?.reason === 'string' ? after.reason : null,
    });
  }
  return out;
}

export interface RestorableCandidate {
  id: string;
  status: ReservationStatus;
  itemType: InventoryItemType;
  qty: { toString(): string };
  salesOrder: { status: SalesOrderStatus };
}

/**
 * Por qué una reserva **no** se restaura, o `null` si se puede. `lastAction` es la acción del
 * último evento de liberación o restauración (`latestReleaseEvents`).
 */
export function restoreBlock(
  candidate: RestorableCandidate,
  lastAction: string | null,
): string | null {
  if (candidate.salesOrder.status === SalesOrderStatus.CANCELLED) {
    return 'El pedido está anulado: su reserva no se restaura';
  }
  if (candidate.salesOrder.status === SalesOrderStatus.FULFILLED) {
    return 'El pedido ya está atendido: no hay reserva que restaurar';
  }
  if (candidate.status === ReservationStatus.ACTIVE) return 'La reserva ya está activa';
  if (candidate.status === ReservationStatus.CONSUMED) {
    return 'La reserva se cerró con un despacho o una orden de producción: no se restaura';
  }
  if (candidate.itemType !== InventoryItemType.PRODUCT) {
    return 'Solo se restaura una reserva de producto terminado';
  }
  // Las demás liberaciones (anular, cambiar cantidad o bobina, revertir o cerrar producción)
  // ponen la cantidad en cero y no escriben `sales.reservation.release`.
  if (toDecimal(candidate.qty.toString()).lte(0) || lastAction !== RESERVATION_RELEASE_ACTION) {
    return 'Solo se restaura una reserva liberada a mano; esta se cerró por otra operación';
  }
  return null;
}

/** Los ids restaurables de una lista, para el DTO (una consulta de auditoría para todas). */
export async function restorableReservationIds(
  db: Prisma.TransactionClient,
  candidates: readonly RestorableCandidate[],
): Promise<Set<string>> {
  const released = candidates.filter(
    (c) =>
      c.status === ReservationStatus.RELEASED &&
      c.itemType === InventoryItemType.PRODUCT &&
      toDecimal(c.qty.toString()).gt(0),
  );
  const events = await latestReleaseEvents(
    db,
    released.map((c) => c.id),
  );
  return new Set(
    released
      .filter((c) => restoreBlock(c, events.get(c.id)?.action ?? null) === null)
      .map((c) => c.id),
  );
}

/**
 * Por línea de pedido: la reserva de producto terminado liberada a mano que se puede restaurar,
 * si existe. Es lo que el detalle del comprobante enlaza cuando una línea sale «No se despacha»
 * porque se fabrica contra el pedido y su reserva ya no está.
 */
export async function restorableByLine(
  db: Prisma.TransactionClient,
  orderItemIds: readonly string[],
): Promise<Map<string, { salesOrderId: string; reservationId: string }>> {
  const out = new Map<string, { salesOrderId: string; reservationId: string }>();
  if (orderItemIds.length === 0) return out;
  const rows = await db.reservation.findMany({
    where: {
      salesOrderItemId: { in: [...orderItemIds] },
      itemType: InventoryItemType.PRODUCT,
      status: ReservationStatus.RELEASED,
    },
    select: {
      id: true,
      status: true,
      itemType: true,
      itemId: true,
      qty: true,
      salesOrderId: true,
      salesOrderItemId: true,
      salesOrder: { select: { status: true } },
      salesOrderItem: { select: RESERVATION_LINE_SELECT },
    },
  });
  const fabricated = rows.filter((r) => isFabricatedLineReservation(r, r.salesOrderItem));
  const ok = await restorableReservationIds(db, fabricated);
  for (const r of fabricated) {
    if (ok.has(r.id)) {
      out.set(r.salesOrderItemId, { salesOrderId: r.salesOrderId, reservationId: r.id });
    }
  }
  return out;
}

/**
 * Cuánto vuelve a prometer la reserva: lo que prometía al liberarse, sin pasar de lo que a la
 * línea le queda por despachar **en la misma unidad**. Si las unidades difieren (una línea que
 * se vende en otra unidad que la del ítem), manda lo que prometía la reserva.
 */
export function restoreQty(input: {
  reservationQty: { toString(): string };
  reservationUnit: string;
  line: Pick<ReservationLine, 'qty' | 'unit'>;
  dispatchedOnItem: Decimal;
}): Decimal {
  const promised = toDecimal(input.reservationQty.toString());
  if (input.line.unit !== input.reservationUnit) return promised;
  const pending = toDecimal(input.line.qty.toString()).minus(input.dispatchedOnItem);
  return Decimal.max(Decimal.min(promised, pending), new Decimal(0));
}
