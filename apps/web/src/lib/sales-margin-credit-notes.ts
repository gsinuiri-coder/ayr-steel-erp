import {
  CREDIT_NOTE_REASON_LABELS,
  CREDIT_NOTE_REASON_SUNAT_CODE,
  filterBySearch,
  type SalesMarginCreditNoteDto,
} from '@ayr/shared';

/**
 * cc67 (D-720): lo que se busca en el modal «Notas de crédito» de Ventas y margen: la NC, el
 * comprobante que afecta, el pedido, el cliente (nombre y RUC/DNI) y el motivo SUNAT.
 */
export function creditNoteSearchText(note: SalesMarginCreditNoteDto): string[] {
  return [
    note.number,
    note.affectedNumber,
    note.orderCode,
    note.customerName,
    note.customerDocNumber,
    creditNoteReasonText(note.reason),
  ].filter((v): v is string => v !== null);
}

/** Las NC que coinciden con la búsqueda, en el orden en que llegan (por fecha). */
export function filterCreditNotes(
  notes: readonly SalesMarginCreditNoteDto[],
  search: string,
): SalesMarginCreditNoteDto[] {
  return filterBySearch(notes, creditNoteSearchText, search);
}

/** «07 · Devolución por ítem»: el código SUNAT visible, como el rótulo «Motivo SUNAT» (D-661). */
export function creditNoteReasonText(reason: SalesMarginCreditNoteDto['reason']): string {
  if (reason === null) return '—';
  return `${CREDIT_NOTE_REASON_SUNAT_CODE[reason]} · ${CREDIT_NOTE_REASON_LABELS[reason]}`;
}

/** «Ver la nota de crédito» o «Ver las 3 notas de crédito». */
export function creditNotesLinkLabel(count: number): string {
  return count === 1 ? 'Ver la nota de crédito' : `Ver las ${String(count)} notas de crédito`;
}
