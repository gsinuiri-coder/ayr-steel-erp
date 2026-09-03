/**
 * Movimientos de kardex que siguen afectando el saldo: ni son la anulación de otro, ni
 * fueron anulados. Un par movimiento+reversa se cancela entre sí y no debe bloquear
 * nada, pero como el kardex es append-only (§3.2) esos pares se acumulan para siempre:
 * contarlos dejaba una bobina con una merma ya anulada sin poder anularse ni corregirse
 * nunca, pidiendo "anular primero" un movimiento que el usuario ya había anulado.
 *
 * La forma mínima que necesita: `reversalOfId` y la relación `reversals` incluida.
 */
export function liveMovements<T extends { reversalOfId: bigint | null; reversals: unknown[] }>(
  movements: T[],
): T[] {
  return movements.filter((m) => m.reversalOfId === null && m.reversals.length === 0);
}
