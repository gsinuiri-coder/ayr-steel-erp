import { ConflictException } from '@nestjs/common';
import {
  FiscalDocType,
  FiscalDocumentStatus,
  type FiscalDocumentStatus as Status,
  type Prisma,
} from '@prisma/client';
import { businessToday, toDecimal } from '@ayr/shared';

/**
 * cc33 N3 — las notas de crédito y su comprobante afectado.
 *
 * Una nota de crédito en borrador no ajusta ningún saldo, pero se puede registrar o emitir después.
 * Si su factura se anuló o se dio de baja en el medio, quedaba una nota viva sobre un comprobante
 * muerto. Se cierra por los dos lados: anular y dar de baja se rechazan mientras haya un borrador
 * (nombrándolo, como D-383 con los borradores del pedido), y registrar o emitir la nota exige el
 * afectado aceptado y vigente.
 */

/** El día de negocio (Lima) de un instante, como `03/10/2026`. */
function dayLabel(at: Date): string {
  const [y, m, d] = businessToday(at).split('-');
  return `${d ?? ''}/${m ?? ''}/${y ?? ''}`;
}

/**
 * El motivo por el que el comprobante no se puede anular ni dar de baja por sus notas de crédito
 * **en borrador**, o `null` si no hay ninguna. Las vivas las rechaza cada camino con su propio
 * mensaje, que ya existía. `action` completa la frase: «antes de anularlo», «antes de darlo de
 * baja».
 */
export async function draftCreditNoteBlock(
  tx: Prisma.TransactionClient,
  documentId: string,
  action: string,
): Promise<string | null> {
  const drafts = await tx.fiscalDocument.findMany({
    where: {
      affectedDocumentId: documentId,
      docType: FiscalDocType.NOTA_CREDITO,
      status: FiscalDocumentStatus.DRAFT,
      archivedAt: null,
    },
    select: { createdAt: true, totalPen: true },
    orderBy: { createdAt: 'asc' },
  });
  if (drafts.length === 0) return null;
  const named = drafts
    .map(
      (n) =>
        `nota de crédito del ${dayLabel(n.createdAt)} por S/ ${toDecimal(n.totalPen.toString()).toFixed(2)}`,
    )
    .join('; ');
  return `El comprobante tiene ${drafts.length === 1 ? 'una nota de crédito en borrador' : `${String(drafts.length)} notas de crédito en borrador`}: elimina primero ${drafts.length === 1 ? 'el borrador' : 'los borradores'} (${named}) ${action}`;
}

/**
 * Registrar o emitir una nota de crédito exige su afectado **aceptado y vigente**, leído con las
 * dos filas ya bloqueadas. Es la misma condición con la que `createCreditNote` deja crear el
 * borrador, repetida en el único momento en que la nota pasa a existir.
 */
export function assertAffectedStillCreditable(affected: {
  number: string | null;
  status: Status;
  archivedAt: Date | null;
}): void {
  if (affected.status === FiscalDocumentStatus.ACCEPTED && affected.archivedAt === null) return;
  const why =
    affected.archivedAt !== null
      ? 'fue reemplazado por una reimportación'
      : `está ${STATUS_LABEL[affected.status] ?? affected.status}`;
  throw new ConflictException(
    `${affected.number ?? 'El comprobante afectado'} ${why}: esta nota de crédito ya no se registra ni se emite. Descártala`,
  );
}

const STATUS_LABEL: Partial<Record<Status, string>> = {
  [FiscalDocumentStatus.VOIDED]: 'dado de baja',
  [FiscalDocumentStatus.VOID_PENDING]: 'con la baja en trámite',
  [FiscalDocumentStatus.ANNULLED]: 'anulado',
  [FiscalDocumentStatus.REJECTED]: 'rechazado',
  [FiscalDocumentStatus.ISSUED]: 'sin aceptar por SUNAT',
  [FiscalDocumentStatus.SEND_ERROR]: 'sin aceptar por SUNAT',
  [FiscalDocumentStatus.DRAFT]: 'en borrador',
};
