import type { InventoryItemType, Prisma } from '@prisma/client';
import { liveMovements } from '../inventory/live-movements';

/** Un movimiento de la compra, como lo lee la anulación. */
export interface OwnMovement {
  id: bigint;
  itemType: InventoryItemType;
  itemId: string;
  type: string;
  reversalOfId: bigint | null;
  reversals: unknown[];
}

/**
 * Contra qué movimiento de la compra se mide «posterior» en cada ítem, para el guardrail de la
 * anulación (`assertNothingMovedAfter`).
 *
 * - D-372 (cc15): solo los ítems donde la compra **todavía tiene algo vigente**. Un ítem cuyos
 *   movimientos de la compra están todos revertidos (el producto viejo tras un cambio de
 *   producto en «Editar compra») ya no recibe nada de esta compra: la anulación no le hace nada,
 *   y medir «posterior» contra su ingreso revertido dejaba la compra sin poder anularse en cuanto
 *   ese producto se movía por otro documento.
 * - Si la compra le hizo un **ingreso** vigente al ítem, se mide contra el último ingreso suyo.
 *   Un ajuste de costo propio posterior (la corrección proporcional de cc15) **no** corre la
 *   referencia: si corriera, una salida ajena entre el ingreso y el ajuste dejaría de verse y la
 *   anulación revertiría un ingreso ya consumido (revisión de cc15a, P1-1).
 * - Si no hay ingreso (una compra de servicio que solo dejó un landed cost, D-043), contra el
 *   último movimiento suyo: anular un flete no puede quedar bloqueado por el ingreso de la
 *   bobina, que es anterior a su propio ajuste.
 */
export function lastOwnMovementByLiveItem(
  movements: {
    id: bigint;
    itemId: string;
    type: string;
    reversalOfId: bigint | null;
    reversals: unknown[];
  }[],
): Map<string, bigint> {
  const live = liveMovements(movements);
  const liveItems = new Set(live.map((m) => m.itemId));
  const lastLiveIn = new Map<string, bigint>();
  for (const m of live) {
    if (m.type !== 'IN') continue;
    const current = lastLiveIn.get(m.itemId);
    if (current === undefined || m.id > current) lastLiveIn.set(m.itemId, m.id);
  }
  const lastOwnId = new Map<string, bigint>();
  for (const m of movements) {
    if (!liveItems.has(m.itemId) || lastLiveIn.has(m.itemId)) continue;
    const current = lastOwnId.get(m.itemId);
    if (current === undefined || m.id > current) lastOwnId.set(m.itemId, m.id);
  }
  for (const [itemId, id] of lastLiveIn) lastOwnId.set(itemId, id);
  return lastOwnId;
}

/**
 * Qué movimientos ajenos y vivos, posteriores a la compra, bloquean su anulación
 * (`assertNothingMovedAfter`). `null` si la compra no tiene ítems que medir.
 *
 * - Lo ya anulado no bloquea (ni el movimiento revertido ni su reversa), y se filtra **en la
 *   consulta**, antes del límite de filas (segunda revisión de cc15a, P2-1).
 * - D-382 (cc15b, P2-2): en **producto terminado**, una **entrada** ajena posterior (otra compra,
 *   una producción, una apertura) no bloquea, igual que en la precondición de
 *   `InventoryService.replaceEntry`: la reversa de la anulación saca solo lo que entró con esta
 *   compra y el saldo final se comprueba en `reverse` (no negativo, reservas D-066). Sin esto, el
 *   reingreso de un reemplazo, que tiene id mayor aunque su fecha sea anterior, dejaba sin poder
 *   anularse cualquier compra posterior del mismo producto. El filtro va en la consulta por el
 *   mismo motivo que el de lo anulado: en memoria, cinco entradas tapaban una salida viva.
 * - En **bobina** cualquier movimiento ajeno sigue bloqueando, entradas incluidas: la anulación
 *   también cancela la ficha de la bobina, y una entrada ajena viva la dejaría cancelada con
 *   saldo en el kardex.
 */
export function laterMovementsWhere(
  movements: OwnMovement[],
): Prisma.InventoryMovementWhereInput | null {
  const lastOwnId = lastOwnMovementByLiveItem(movements);
  if (lastOwnId.size === 0) return null;
  const itemTypes = new Map(movements.map((m) => [m.itemId, m.itemType]));
  return {
    OR: [...lastOwnId].map(([itemId, id]) =>
      itemTypes.get(itemId) === 'PRODUCT'
        ? { itemId, id: { gt: id }, type: { not: 'IN' as const } }
        : { itemId, id: { gt: id } },
    ),
    reversalOfId: null,
    reversals: { none: {} },
    id: { notIn: movements.map((m) => m.id) },
  };
}

/** Hasta cinco movimientos que bloquean la anulación (para nombrarlos en el mensaje). */
export async function findBlockingLaterMovements(
  tx: Prisma.TransactionClient,
  movements: OwnMovement[],
) {
  const where = laterMovementsWhere(movements);
  if (where === null) return [];
  const later = await tx.inventoryMovement.findMany({
    where,
    orderBy: { id: 'asc' },
    include: { reversals: { select: { id: true } } },
    take: 5,
  });
  const ownIds = new Set(movements.map((m) => m.id));
  return liveMovements(later).filter((m) => !ownIds.has(m.id));
}
