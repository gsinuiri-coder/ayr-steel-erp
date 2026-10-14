import {
  CREDIT_NOTE_KIND_REASONS,
  CREDIT_NOTE_KINDS,
  MAX_BACKDATED_ISSUE_DAYS,
  addDays,
  type CreditNoteKind,
  type CreditNoteReason,
} from '@ayr/shared';

/** `YYYY-MM-DD`. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** cc52 (D-646): el grupo al que pertenece un motivo SUNAT (el primero que lo lista). */
export function creditNoteKindOf(reason: CreditNoteReason): CreditNoteKind {
  return CREDIT_NOTE_KINDS.find((k) => CREDIT_NOTE_KIND_REASONS[k].includes(reason)) ?? 'ANNUL';
}

/** cc52 (D-646): el motivo con que arranca un grupo al elegirlo. */
export function defaultReasonOfKind(kind: CreditNoteKind): CreditNoteReason {
  const first = CREDIT_NOTE_KIND_REASONS[kind][0];
  if (first === undefined) throw new Error(`El grupo ${kind} no tiene motivos`);
  return first;
}

/**
 * cc52 (D-645): la fecha de la NC, con las mismas reglas que el API. No antes de la emisión del
 * comprobante afectado, no después de hoy y no más atrás que la ventana de emisión
 * (`MAX_BACKDATED_ISSUE_DAYS`). Solo el ADMINISTRADOR elige otra fecha que hoy. `null` si vale.
 * Las fechas son `YYYY-MM-DD`, que se comparan como texto.
 */
export function creditNoteDateError(
  date: string,
  invoiceIssueDate: string,
  today: string,
  isAdmin: boolean,
): string | null {
  if (!ISO_DATE.test(date)) return 'Escribe una fecha válida';
  if (!isAdmin && date !== today) {
    return 'Solo un administrador puede registrar la nota con otra fecha que hoy';
  }
  if (date > today) return 'La fecha de la nota no puede ser posterior a hoy';
  if (date < invoiceIssueDate) {
    return 'La fecha de la nota no puede ser anterior a la emisión del comprobante';
  }
  if (date < addDays(today, -MAX_BACKDATED_ISSUE_DAYS)) {
    return `La fecha de la nota no puede tener más de ${MAX_BACKDATED_ISSUE_DAYS} días de atraso`;
  }
  return null;
}
