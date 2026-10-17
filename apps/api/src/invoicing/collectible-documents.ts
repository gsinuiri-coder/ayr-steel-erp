import { FiscalDocType, Prisma, type FiscalDocumentStatus } from '@prisma/client';
import {
  Decimal,
  documentBalance,
  effectiveDueDate,
  fromDateOnly,
  hasCollectibleBalance,
  LIVE_DOCUMENT_STATUSES,
  toDecimal,
} from '@ayr/shared';

/**
 * La lectura de cuentas por cobrar: los comprobantes vivos **con algo que cobrar** y su saldo.
 *
 * Vive aparte de `ReceivablesService` desde cc25 (D-421) porque la leen dos pantallas —
 * cobranzas (RF-88) y el reporte de cuentas por cobrar— y tienen que leer lo mismo: una
 * consulta, la regla del saldo de `@ayr/shared` (D-075) y la del céntimo (D-377). Si cada una
 * armara su propia consulta, la primera diferencia de filtro daría dos deudas distintas para el
 * mismo cliente.
 */

const LIVE_STATUSES: FiscalDocumentStatus[] = [...LIVE_DOCUMENT_STATUSES];

const COLLECTIBLE_INCLUDE = {
  customer: { select: { id: true, name: true, docNumber: true } },
  payments: { select: { amountPen: true, reversedAt: true } },
  creditNotes: {
    // RF-72: una versión archivada dejó de ser el documento; no acredita nada.
    where: { status: { in: LIVE_STATUSES }, archivedAt: null },
    // cc54 (D-657): lo que el 13 necesita para el vencimiento vigente (`dueDateOf`).
    select: {
      totalPen: true,
      status: true,
      creditNoteReason: true,
      dueDate: true,
      issueDate: true,
      createdAt: true,
    },
  },
  // RF-S3c: de quién es el comprobante (`documentOwnerId`). El reporte de CxC lo usa para el
  // filtro por vendedor y el enlace al pedido; cobranzas no lo lee.
  salesOrder: { select: { id: true, seq: true, sellerId: true } },
  dispatch: { select: { salesOrder: { select: { id: true, seq: true, sellerId: true } } } },
} satisfies Prisma.FiscalDocumentInclude;

export type CollectibleDocumentRow = Prisma.FiscalDocumentGetPayload<{
  include: typeof COLLECTIBLE_INCLUDE;
}>;

/** Un comprobante con saldo, con el saldo ya calculado (cuatro decimales). */
export interface CollectibleDocument {
  document: CollectibleDocumentRow;
  balance: Decimal;
  paid: Decimal;
  credited: Decimal;
}

type Reader = Pick<Prisma.TransactionClient, 'fiscalDocument' | '$queryRaw'>;

/**
 * Una sola lectura para todos los comprobantes con saldo: Prisma la resuelve en un número fijo de
 * consultas (una por relación incluida), sin importar cuántos comprobantes haya. Los que tienen un
 * resto de fracciones de céntimo (D-377) no son deuda y no se devuelven.
 */
export async function loadCollectibleDocuments(prisma: Reader): Promise<CollectibleDocument[]> {
  // cc57 (E-06 de audit-01): primero, en SQL, los que todavía tienen algo que cobrar (total menos
  // cobros vigentes menos NC vivas, mayor que cero). Es un superconjunto de la regla de
  // `documentBalance` —que sigue decidiendo abajo, con el céntimo de D-377—: lo único que deja
  // afuera es lo ya cobrado o acreditado entero. Sin esto se traían todos los comprobantes vivos
  // de la historia con sus cinco relaciones para descartar en memoria los pagados.
  const live = Prisma.join(LIVE_STATUSES.map((st) => Prisma.sql`${st}`));
  const pending = await prisma.$queryRaw<{ id: string }[]>`
    SELECT fd."id"
    FROM "fiscal_documents" fd
    WHERE fd."status"::text IN (${live})
      AND fd."doc_type"::text IN ('FACTURA', 'BOLETA')
      AND fd."archived_at" IS NULL
      AND fd."total_pen"
        - COALESCE((
            SELECT SUM(cp."amount_pen") FROM "customer_payments" cp
            WHERE cp."document_id" = fd."id" AND cp."reversed_at" IS NULL
          ), 0)
        - COALESCE((
            SELECT SUM(nc."total_pen") FROM "fiscal_documents" nc
            WHERE nc."affected_document_id" = fd."id"
              AND nc."status"::text IN (${live})
              AND nc."archived_at" IS NULL
          ), 0) > 0
  `;
  if (pending.length === 0) return [];
  const documents = await prisma.fiscalDocument.findMany({
    where: {
      id: { in: pending.map((r) => r.id) },
      status: { in: LIVE_STATUSES },
      docType: { in: [FiscalDocType.FACTURA, FiscalDocType.BOLETA] },
      // RF-72: sin esto, reimportar un comprobante duplicaba la deuda del cliente — la
      // versión archivada sigue aceptada y volvía a sumar su total.
      archivedAt: null,
    },
    include: COLLECTIBLE_INCLUDE,
  });
  const out: CollectibleDocument[] = [];
  for (const document of documents) {
    const parts = balanceParts(document);
    const balance = toDecimal(parts.balance.toFixed(4));
    // D-377 (arreglo A): un resto de fracciones de céntimo no es deuda.
    if (!hasCollectibleBalance(balance)) continue;
    out.push({ document, balance, paid: parts.paid, credited: parts.credited });
  }
  return out;
}

/**
 * cc54 (D-657): el vencimiento **vigente** de un comprobante con saldo (`YYYY-MM-DD`): el de la NC
 * 13 viva más reciente, o el suyo. Lo usan cobranzas y el reporte de cuentas por cobrar.
 */
export function dueDateOf(document: CollectibleDocumentRow): string | null {
  return effectiveDueDate(
    document.dueDate ? fromDateOnly(document.dueDate) : null,
    document.creditNotes.map((n) => ({
      creditNoteReason: n.creditNoteReason,
      status: n.status,
      dueDate: n.dueDate ? fromDateOnly(n.dueDate) : null,
      issueDate: fromDateOnly(n.issueDate),
      createdAt: n.createdAt.toISOString(),
    })),
  ).dueDate;
}

/** El saldo de un comprobante, con la misma regla compartida que usa el DTO (D-075). */
export function documentBalanceOf(document: {
  status: FiscalDocumentStatus;
  totalPen: Prisma.Decimal;
  payments: { amountPen: Prisma.Decimal; reversedAt: Date | null }[];
  creditNotes: { totalPen: Prisma.Decimal }[];
}): Decimal {
  return balanceParts(document).balance;
}

function balanceParts(document: {
  status: FiscalDocumentStatus;
  totalPen: Prisma.Decimal;
  payments: { amountPen: Prisma.Decimal; reversedAt: Date | null }[];
  creditNotes: { totalPen: Prisma.Decimal }[];
}): { balance: Decimal; paid: Decimal; credited: Decimal } {
  const paid = document.payments
    .filter((p) => p.reversedAt === null)
    .reduce((acc, p) => acc.plus(toDecimal(p.amountPen.toString())), new Decimal(0));
  const credited = document.creditNotes.reduce(
    (acc, n) => acc.plus(toDecimal(n.totalPen.toString())),
    new Decimal(0),
  );
  const balance = toDecimal(
    documentBalance({
      status: document.status,
      totalPen: document.totalPen.toString(),
      paidPen: paid,
      creditedPen: credited,
    }),
  );
  return { balance, paid, credited };
}

/**
 * RF-S3c: de quién es el comprobante. El vendedor de su pedido, el del pedido de su despacho o,
 * si no tiene ninguno, quien lo emitió. Es la regla con la que cobranzas decide quién lo puede
 * cobrar, y la que usa el filtro por vendedor de CxC (D-432).
 */
export function documentOwnerId(document: {
  createdById: string;
  salesOrder: { sellerId: string | null } | null;
  dispatch: { salesOrder: { sellerId: string | null } | null } | null;
}): string {
  return (
    document.salesOrder?.sellerId ?? document.dispatch?.salesOrder?.sellerId ?? document.createdById
  );
}
