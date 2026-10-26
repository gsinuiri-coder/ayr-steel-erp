/**
 * cc68 (D-722): qué impide revertir una entrada de la carga inicial de productos. Función pura: el
 * servicio junta los hechos (bajo el lock, al ejecutar) y esta función decide.
 *
 * Una entrada del lote se puede revertir solo si sigue siendo lo único que movió su producto desde
 * la carga: sin movimientos posteriores (ni salidas, ni ajustes, ni recosteos), sin reversa previa y
 * sin stock prometido (reservas de pedido o reservas temporales de cotización vigentes). El mensaje
 * nombra el SKU, como pide el brief.
 */
export interface RevertEntryFacts {
  sku: string;
  /** La entrada ya tiene su reversa (se revirtió antes). */
  alreadyReversed: boolean;
  /** Movimientos del mismo producto posteriores a la entrada (fuera de su propia reversa). */
  laterMovements: number;
  /** Reservas de pedido `ACTIVE` sobre el producto. */
  activeReservations: number;
  /** Reservas temporales de cotización `ACTIVE` y sin vencer. */
  activeQuotationReservations: number;
}

export function revertEntryErrors(f: RevertEntryFacts): string[] {
  const errors: string[] = [];
  if (f.alreadyReversed) errors.push(`${f.sku}: esta entrada ya se revirtió`);
  if (f.laterMovements > 0) {
    errors.push(
      `${f.sku}: tiene ${String(f.laterMovements)} movimiento(s) de kardex posterior(es) a la carga; la reversa solo saca una carga que nadie usó`,
    );
  }
  if (f.activeReservations > 0) {
    errors.push(
      `${f.sku}: tiene ${String(f.activeReservations)} reserva(s) de pedido activa(s); libéralas antes`,
    );
  }
  if (f.activeQuotationReservations > 0) {
    errors.push(
      `${f.sku}: tiene ${String(f.activeQuotationReservations)} reserva(s) temporal(es) de cotización vigente(s)`,
    );
  }
  return errors;
}
