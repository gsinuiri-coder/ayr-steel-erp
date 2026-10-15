import { FiscalDocType, Prisma, type FiscalDocumentStatus } from '@prisma/client';
import { LIVE_DOCUMENT_STATUSES, QTY_CREDIT_NOTE_REASONS } from '@ayr/shared';
import { netInvoicedByItem, type NetInvoiced } from './invoicing-math';

/**
 * D-346 (deuda de D-223): **el único lugar** que responde «cuánto se facturó de cada línea de
 * pedido». Lo usan el guard de facturación (`resolveLines`) y la vista de avance del pedido
 * (`orderProgress`); un tercer `groupBy` suelto reabriría la divergencia que esto cierra.
 *
 * Lo facturado por línea = emitido vivo − acreditado por notas de crédito vivas sobre esa línea
 * (la resta pura vive en `netInvoicedByItem`). Solo cuentan los documentos **vivos** y no
 * archivados: un rechazado nunca existió para SUNAT y un anulado dejó de existir, y una nota de
 * crédito en borrador todavía no acredita nada. Las notas guardan la `salesOrderItemId` de la
 * línea que acreditan (`createCreditNote`), así que se agrupan por la misma clave.
 */
const LIVE: FiscalDocumentStatus[] = [...LIVE_DOCUMENT_STATUSES];
const SUM = { qty: true, subtotalPen: true, igvPen: true, totalPen: true } as const;

export async function invoicedByOrderItem(
  client: Pick<Prisma.TransactionClient, 'fiscalDocumentItem'>,
  itemIds: readonly string[],
  /**
   * Un documento que no debe contarse a sí mismo: la revalidación al emitir (`assertStillAvailable`)
   * pregunta «lo de los demás», con el documento ya bloqueado.
   */
  options: { excludeDocumentId?: string } = {},
): Promise<Map<string, NetInvoiced>> {
  if (itemIds.length === 0) return new Map();
  const ids = [...itemIds];
  const notSelf = options.excludeDocumentId
    ? { documentId: { not: options.excludeDocumentId } }
    : {};
  const ncWhere = { status: { in: LIVE }, docType: FiscalDocType.NOTA_CREDITO, archivedAt: null };
  const qtyReasons = { in: [...QTY_CREDIT_NOTE_REASONS] };
  const [emitted, creditedByQty, creditedByAmount] = await Promise.all([
    client.fiscalDocumentItem.groupBy({
      by: ['salesOrderItemId'],
      where: {
        salesOrderItemId: { in: ids },
        ...notSelf,
        document: {
          status: { in: LIVE },
          docType: { not: FiscalDocType.NOTA_CREDITO },
          archivedAt: null,
        },
      },
      _sum: SUM,
    }),
    // cc54 (D-663): solo los motivos de cantidad devuelven unidades al pedido…
    client.fiscalDocumentItem.groupBy({
      by: ['salesOrderItemId'],
      where: {
        salesOrderItemId: { in: ids },
        ...notSelf,
        document: { ...ncWhere, creditNoteReason: qtyReasons },
      },
      _sum: SUM,
    }),
    // …y una rebaja o una corrección (03, 04, 05, 13) baja solo el importe.
    client.fiscalDocumentItem.groupBy({
      by: ['salesOrderItemId'],
      where: {
        salesOrderItemId: { in: ids },
        ...notSelf,
        document: { ...ncWhere, creditNoteReason: { notIn: [...QTY_CREDIT_NOTE_REASONS] } },
      },
      _sum: SUM,
    }),
  ]);
  return netInvoicedByItem(emitted, mergeCredits(creditedByQty, creditedByAmount));
}

/**
 * cc52 (D-646): lo **devuelto** por una NC de devolución vigente se deshizo como venta: no vuelve a
 * quedar pendiente de facturar (se refacturaría mercadería que ya volvió al almacén). La NC lo restó
 * de lo facturado; el tope de facturación y el avance del pedido lo suman como consumido, solo en
 * cantidad. La anulación del pedido no lo usa: para ella, lo acreditado no factura nada.
 */
export async function withReturnedQty(
  client: Pick<Prisma.TransactionClient, 'salesReturnItem'>,
  net: Map<string, NetInvoiced>,
  itemIds: readonly string[],
): Promise<Map<string, NetInvoiced>> {
  if (itemIds.length === 0) return net;
  const returned = await client.salesReturnItem.findMany({
    where: {
      dispatchItem: { salesOrderItemId: { in: [...itemIds] } },
      salesReturn: { status: 'ACTIVE' },
    },
    select: { qty: true, dispatchItem: { select: { salesOrderItemId: true } } },
  });
  for (const r of returned) {
    const entry = net.get(r.dispatchItem.salesOrderItemId);
    if (entry) entry.qty = entry.qty.plus(r.qty.toString());
  }
  return net;
}

type CreditSumRow = Parameters<typeof netInvoicedByItem>[1][number];

/**
 * cc54 (D-663): lo acreditado por línea de pedido con la cantidad de las NC de cantidad y el importe
 * de todas. Exportada para probarla sin base.
 */
export function mergeCredits(
  byQty: readonly CreditSumRow[],
  byAmount: readonly CreditSumRow[],
): CreditSumRow[] {
  const out = new Map<string | null, CreditSumRow>();
  const add = (a: { toString(): string } | null, b: { toString(): string } | null) =>
    a === null && b === null
      ? null
      : new Prisma.Decimal((a ?? 0).toString()).plus((b ?? 0).toString());
  for (const r of byQty) out.set(r.salesOrderItemId, { ...r, _sum: { ...r._sum } });
  for (const r of byAmount) {
    const prev = out.get(r.salesOrderItemId);
    out.set(r.salesOrderItemId, {
      salesOrderItemId: r.salesOrderItemId,
      _sum: {
        qty: prev ? prev._sum.qty : null,
        subtotalPen: add(prev?._sum.subtotalPen ?? null, r._sum.subtotalPen),
        igvPen: add(prev?._sum.igvPen ?? null, r._sum.igvPen),
        totalPen: add(prev?._sum.totalPen ?? null, r._sum.totalPen),
      },
    });
  }
  return [...out.values()];
}
