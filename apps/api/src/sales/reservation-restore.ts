import {
  InventoryItemType,
  InventoryMovementType,
  InventoryRefType,
  ProductionReportStatus,
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
 * 2. **La reversa:** la reserva de lo fabricado liberada **a mano** se restaura (`restoreBlock`,
 *    `restoreQty`), topada por lo fabricado vivo de la línea (`fabricatedAliveQty`). Una cerrada
 *    por despacho, por producción o por anular el pedido, no.
 *
 * Sin migración: lo que separa una liberación manual de las demás ya está en el dato. Es la única
 * que deja `qty` con la cantidad que prometía —cancelar, cambiar cantidad o bobina, la reversa de
 * producción **sobre una reserva activa** y el cierre de la OP la ponen en cero— y la única que
 * escribe `sales.reservation.release` en `audit_log`. La cantidad guardada no sirve como tope: una
 * reversa de producción posterior no la toca (por eso existe `fabricatedAliveQty`).
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
  itemId: string;
  qty: { toString(): string };
  salesOrder: { status: SalesOrderStatus };
  /**
   * La línea **hoy**: qué producto vende y qué reservó al confirmarse. Una reserva de otro
   * producto ya no la respalda, y una línea que no se fabrica contra el pedido queda fuera de
   * D-379 (su reserva liberada no deja la línea sin despacho).
   */
  salesOrderItem: Pick<ReservationLine, 'productId' | 'reserveItemType' | 'reserveItemId'>;
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
  // La línea cambió de producto después de liberarla (D-187/D-254): la fila vieja no respalda
  // nada de lo que la línea vende hoy.
  if (candidate.itemId !== candidate.salesOrderItem.productId) {
    return 'La línea ya no vende ese producto: su reserva vieja no se restaura';
  }
  // D-379 es la reserva de lo fabricado. La de un producto de stock liberada a mano es el uso
  // normal de D-054 y la línea se sigue despachando del saldo libre.
  if (!isFabricatedLineReservation(candidate, candidate.salesOrderItem)) {
    return 'Solo se restaura la reserva de lo fabricado de una línea que se produce contra el pedido';
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
  const ok = await restorableReservationIds(db, rows);
  for (const r of rows) {
    if (ok.has(r.id)) {
      out.set(r.salesOrderItemId, { salesOrderId: r.salesOrderId, reservationId: r.id });
    }
  }
  return out;
}

/**
 * Lo fabricado **vivo** de una línea, en la unidad del producto: los ingresos de producción de
 * sus reportes vigentes que nadie revirtió. Es el tope real de la reserva de lo fabricado.
 *
 * La cantidad que guardaba la reserva al liberarse no alcanza como tope (autorrevisión cc12,
 * P1-1): si después se revierte la producción, `reduceReservation` no toca una fila liberada
 * —solo descuenta de una activa— y la reserva queda prometiendo metros que ya no existen.
 */
export async function fabricatedAliveQty(
  db: Prisma.TransactionClient,
  salesOrderItemId: string,
  productId: string,
): Promise<Decimal> {
  const reports = await db.productionReport.findMany({
    where: {
      status: ProductionReportStatus.ACTIVE,
      productionOrder: { reservation: { salesOrderItemId } },
    },
    select: { id: true },
  });
  if (reports.length === 0) return new Decimal(0);
  const entries = await db.inventoryMovement.findMany({
    where: {
      type: InventoryMovementType.IN,
      refType: InventoryRefType.PRODUCTION,
      itemType: InventoryItemType.PRODUCT,
      itemId: productId,
      refId: { in: reports.map((r) => r.id) },
      reversals: { none: {} },
    },
    select: { qty: true },
  });
  return entries.reduce<Decimal>((acc, m) => acc.plus(toDecimal(m.qty.toString())), new Decimal(0));
}

/**
 * Cuánto vuelve a prometer la reserva: lo que prometía al liberarse, sin pasar de lo fabricado
 * vivo que todavía no salió (`fabricated − dispatchedOnItem`) ni de lo que a la línea le queda
 * por despachar en la misma unidad.
 */
export function restoreQty(input: {
  reservationQty: { toString(): string };
  reservationUnit: string;
  line: Pick<ReservationLine, 'qty' | 'unit'>;
  dispatchedOnItem: Decimal;
  fabricated: Decimal;
}): Decimal {
  let qty = Decimal.min(
    toDecimal(input.reservationQty.toString()),
    input.fabricated.minus(input.dispatchedOnItem),
  );
  if (input.line.unit === input.reservationUnit) {
    qty = Decimal.min(qty, toDecimal(input.line.qty.toString()).minus(input.dispatchedOnItem));
  }
  return Decimal.max(qty, new Decimal(0));
}
