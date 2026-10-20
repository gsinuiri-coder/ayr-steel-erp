import { FiscalDocType } from '@prisma/client';
import { effectiveDueDate, LIVE_DOCUMENT_STATUSES } from '@ayr/shared';

/** Lo que la corrección del vencimiento necesita del comprobante, con fechas `YYYY-MM-DD`. */
export interface DueDateChangeDocument {
  docType: FiscalDocType;
  status: string;
  paymentTerms: string;
  archivedAt: Date | null;
  issueDate: string;
  dueDate: string | null;
  creditNotes: {
    number: string | null;
    creditNoteReason: string | null;
    status: string;
    dueDate: string | null;
    issueDate: string;
    createdAt: string;
  }[];
}

/**
 * cc61 (D-699): por qué no se puede poner este vencimiento, o `null` si se puede. Solo una factura
 * o boleta al crédito y viva; la fecha, no antes de la emisión; y nunca con una NC 13 viva, porque
 * el vencimiento vigente es el de la nota (D-657) y el cambio no se vería.
 */
export function dueDateChangeBlock(
  document: DueDateChangeDocument,
  dueDate: string,
): string | null {
  if (document.docType !== FiscalDocType.FACTURA && document.docType !== FiscalDocType.BOLETA) {
    return 'Solo una factura o una boleta tiene vencimiento';
  }
  if (!LIVE_DOCUMENT_STATUSES.includes(document.status as never) || document.archivedAt !== null) {
    return 'Solo se cambia el vencimiento de un comprobante vigente';
  }
  if (document.paymentTerms !== 'CREDITO') {
    return 'Solo un comprobante al crédito tiene vencimiento';
  }
  const governing = effectiveDueDate(document.dueDate, document.creditNotes);
  if (governing.changedByNote) {
    const note = document.creditNotes
      .filter((n) => n.creditNoteReason === 'OTROS_AJUSTES' && n.dueDate === governing.dueDate)
      .map((n) => n.number)
      .find((n) => n !== null);
    return `Este comprobante tiene una NC 13 vigente${note ? ` (${note})` : ''} que fija su vencimiento: anúlala o registra otra`;
  }
  if (dueDate < document.issueDate) {
    return `El vencimiento no puede ser anterior a la emisión (${document.issueDate})`;
  }
  if (document.dueDate === dueDate) {
    return `El vencimiento ya es ${dueDate}`;
  }
  return null;
}

/** Lo que la CLI de cc61 midió dentro de la transacción, antes de decidir si se queda. */
export interface DueDateFacts {
  documentId: string;
  status: string;
  paymentTerms: string;
  issueDate: string;
  dueDateBefore: string | null;
  dueDateAfter: string | null;
  /** Columnas de la fila del comprobante que cambiaron (`updatedAt` incluida). */
  changedFields: string[];
  /** Acciones de auditoría nuevas sobre el comprobante. */
  newAuditActions: string[];
  /** Otros comprobantes tocados en la misma transacción. */
  otherDocsTouched: number;
  /** El rechazo del servicio, si lo hubo. */
  rejected: string | null;
}

/**
 * cc61: las condiciones del OK del dueño para el `--execute` de la CLI de vencimiento. Vacío si se
 * cumplen todas: el servicio aceptó, lo único que cambió en la fila es el vencimiento (y
 * `updatedAt`), quedó con la fecha pedida, hay una sola auditoría nueva y es la del vencimiento, y
 * no se tocó otro comprobante.
 */
export function dueDateViolations(facts: DueDateFacts, dueDate: string): string[] {
  const out: string[] = [];
  if (facts.rejected !== null) out.push(`el servicio lo rechaza: ${facts.rejected}`);
  if (facts.issueDate > dueDate) {
    out.push(`la emisión (${facts.issueDate}) es posterior al vencimiento pedido (${dueDate})`);
  }
  const extra = facts.changedFields.filter((f) => f !== 'dueDate' && f !== 'updatedAt');
  if (extra.length > 0) out.push(`cambian otras columnas: ${extra.join(', ')}`);
  if (facts.rejected === null && facts.dueDateAfter !== dueDate) {
    out.push(`el vencimiento quedó en ${facts.dueDateAfter ?? 'nada'}, no en ${dueDate}`);
  }
  if (
    facts.rejected === null &&
    (facts.newAuditActions.length !== 1 ||
      facts.newAuditActions[0] !== 'invoicing.document.update-due-date')
  ) {
    out.push(`auditoría inesperada: ${facts.newAuditActions.join(', ') || 'ninguna'}`);
  }
  if (facts.otherDocsTouched > 0) {
    out.push(`se tocaron ${String(facts.otherDocsTouched)} comprobantes más`);
  }
  return out;
}
