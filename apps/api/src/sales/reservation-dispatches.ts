import {
  DispatchStatus,
  ReservationStatus,
  type InventoryItemType,
  type PrismaClient,
} from '@prisma/client';
import { dispatchCode } from '@ayr/shared';

/** Lo mínimo de una reserva para saber qué despacho se la llevó. */
export interface ReservationRef {
  id: string;
  status: ReservationStatus;
  salesOrderItemId: string;
  itemType: InventoryItemType;
  itemId: string;
}

/**
 * D-311: qué despacho se llevó el material de cada reserva **consumida**. La reserva y la
 * línea de despacho comparten la terna (línea del pedido, tipo de ítem, ítem) —la misma con la
 * que `consumeReservationQty` la descuenta—, así que se deriva al leer, sin columna nueva. Solo
 * cuenta el despacho vigente (`ISSUED`; uno revertido devolvió la reserva a activa) y, si hay
 * varios, el último. Una reserva consumida por una OP no tiene línea de despacho y no aparece.
 */
export async function reservationDispatches(
  prisma: Pick<PrismaClient, 'dispatchItem'>,
  rows: readonly ReservationRef[],
): Promise<Map<string, { id: string; code: string }>> {
  const consumed = rows.filter((r) => r.status === ReservationStatus.CONSUMED);
  const out = new Map<string, { id: string; code: string }>();
  if (consumed.length === 0) return out;
  const lines = await prisma.dispatchItem.findMany({
    where: {
      salesOrderItemId: { in: [...new Set(consumed.map((r) => r.salesOrderItemId))] },
      dispatch: { status: DispatchStatus.ISSUED },
    },
    select: {
      salesOrderItemId: true,
      itemType: true,
      itemId: true,
      dispatch: { select: { id: true, seq: true } },
    },
    orderBy: { dispatch: { seq: 'asc' } },
  });
  for (const r of consumed) {
    const mine = lines.filter(
      (l) =>
        l.salesOrderItemId === r.salesOrderItemId &&
        l.itemType === r.itemType &&
        l.itemId === r.itemId,
    );
    const last = mine[mine.length - 1];
    if (last) out.set(r.id, { id: last.dispatch.id, code: dispatchCode(last.dispatch.seq) });
  }
  return out;
}
