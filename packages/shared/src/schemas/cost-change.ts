import { z } from 'zod';

/**
 * cc56 (D-669) — **el costo de una entrada no se baja a mano para vender más barato.** Cambiar el
 * costo de una bobina (RF-20) o el precio de una compra recibida (D-372) exige uno de estos motivos;
 * el texto libre sigue siendo el detalle. Para vender barato están «A costo» (D-639) y el precio.
 */
export const COST_CHANGE_REASONS = [
  'PURCHASE_CORRECTION',
  'SUPPLIER_CREDIT_NOTE',
  'TYPING_ERROR',
] as const;
export type CostChangeReason = (typeof COST_CHANGE_REASONS)[number];

export const COST_CHANGE_REASON_LABELS: Record<CostChangeReason, string> = {
  PURCHASE_CORRECTION: 'Corrección de la compra',
  SUPPLIER_CREDIT_NOTE: 'Nota de crédito del proveedor',
  TYPING_ERROR: 'Error de digitación',
};

export const costChangeReasonSchema = z.enum(COST_CHANGE_REASONS, {
  errorMap: () => ({ message: 'Motivo de cambio de costo inválido' }),
});

/** Lo que dice la web junto al motivo, y el rechazo del API cuando falta. */
export const COST_CHANGE_HINT =
  'El costo solo se corrige por corrección de la compra, nota de crédito del proveedor o error de digitación. ' +
  'Para vender más barato, usa «A costo» o baja el precio: el costo no se toca.';

export const COST_CHANGE_REQUIRED_MESSAGE = `Cambiar el costo exige elegir el motivo. ${COST_CHANGE_HINT}`;

/** La nota del movimiento de kardex: el motivo de la lista y el detalle tipeado. */
export function costChangeNote(reason: CostChangeReason, detail: string): string {
  return `${COST_CHANGE_REASON_LABELS[reason]}: ${detail}`.slice(0, 240);
}
