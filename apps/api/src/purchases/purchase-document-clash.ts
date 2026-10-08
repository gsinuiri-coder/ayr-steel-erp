import { ConflictException } from '@nestjs/common';
import { PurchaseStatus, type Prisma, type PurchaseDocType } from '@prisma/client';
import { normalizePurchaseNumber } from '@ayr/shared';

/**
 * cc33 (ceros a la izquierda, decisión del dueño): el comprobante de una compra viva se compara
 * **sin ceros a la izquierda**. El índice único de D-132 compara texto, y `F001-00012` y `F001-12`
 * del mismo proveedor pasaban como compras distintas. Los números nuevos se guardan ya
 * normalizados (`normalizePurchaseNumber`), pero en la base quedan números viejos con ceros: por
 * eso el choque se busca entre las vivas de la misma serie y se compara normalizado acá, no en SQL.
 * Lo viejo no se toca (no se reparan datos).
 */
export async function assertNoLiveDocumentClash(
  tx: Prisma.TransactionClient,
  doc: {
    supplierId: string;
    docType: PurchaseDocType;
    series: string;
    number: string;
    /** La compra que se está corrigiendo: no choca consigo misma. */
    excludeId?: string;
  },
): Promise<void> {
  const target = normalizePurchaseNumber(doc.number);
  const candidates = await tx.purchase.findMany({
    where: {
      supplierId: doc.supplierId,
      docType: doc.docType,
      series: doc.series,
      status: { not: PurchaseStatus.CANCELLED },
      ...(doc.excludeId ? { id: { not: doc.excludeId } } : {}),
    },
    select: { number: true },
  });
  // El mensaje es el mismo de siempre (D-132): quien lo lee o lo compara no cambia.
  if (candidates.some((p) => normalizePurchaseNumber(p.number) === target)) {
    throw new ConflictException(
      'Ese comprobante ya está registrado para este proveedor en una compra vigente',
    );
  }
}
