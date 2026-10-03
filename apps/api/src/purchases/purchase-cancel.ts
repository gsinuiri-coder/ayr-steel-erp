import { liveMovements } from '../inventory/live-movements';

/**
 * Contra qué movimiento de la compra se mide «posterior» en cada ítem, para el guardrail de la
 * anulación (`assertNothingMovedAfter`).
 *
 * - Por ítem y contra el **último** movimiento que la compra le hizo, no contra el conjunto
 *   entero: anular un flete (D-043) no puede quedar bloqueado por el ingreso de la bobina, que
 *   es anterior a su propio ajuste.
 * - D-372 (cc15): solo los ítems donde la compra **todavía tiene algo vigente**. Un ítem cuyos
 *   movimientos de la compra están todos revertidos (el producto viejo tras un cambio de
 *   producto en «Editar compra») ya no recibe nada de esta compra: la anulación no le hace nada,
 *   y medir «posterior» contra su ingreso revertido dejaba la compra sin poder anularse en cuanto
 *   ese producto se movía por otro documento.
 */
export function lastOwnMovementByLiveItem(
  movements: { id: bigint; itemId: string; reversalOfId: bigint | null; reversals: unknown[] }[],
): Map<string, bigint> {
  const liveItems = new Set(liveMovements(movements).map((m) => m.itemId));
  const lastOwnId = new Map<string, bigint>();
  for (const m of movements) {
    if (!liveItems.has(m.itemId)) continue;
    const current = lastOwnId.get(m.itemId);
    if (current === undefined || m.id > current) lastOwnId.set(m.itemId, m.id);
  }
  return lastOwnId;
}
