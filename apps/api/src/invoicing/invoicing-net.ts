import { FiscalDocType, type FiscalDocumentStatus, type Prisma } from '@prisma/client';
import { LIVE_DOCUMENT_STATUSES } from '@ayr/shared';
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
  const [emitted, credited] = await Promise.all([
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
    client.fiscalDocumentItem.groupBy({
      by: ['salesOrderItemId'],
      where: {
        salesOrderItemId: { in: ids },
        ...notSelf,
        document: { status: { in: LIVE }, docType: FiscalDocType.NOTA_CREDITO, archivedAt: null },
      },
      _sum: SUM,
    }),
  ]);
  return netInvoicedByItem(emitted, credited);
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
