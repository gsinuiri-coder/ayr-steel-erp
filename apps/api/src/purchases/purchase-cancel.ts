import { liveMovements } from '../inventory/live-movements';

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
