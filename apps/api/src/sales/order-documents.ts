import { FiscalDocType, FiscalDocumentStatus, type PrismaClient } from '@prisma/client';
import { LIVE_DOCUMENT_STATUSES, type SalesOrderDocumentLinkDto } from '@ayr/shared';

/**
 * Los tipos que se enlazan desde el pedido: los comprobantes de pago y la nota de crédito. La
 * guía de remisión queda fuera: es del despacho y se ve desde él.
 */
const ORDER_DOCUMENT_TYPES: FiscalDocType[] = [
  FiscalDocType.FACTURA,
  FiscalDocType.BOLETA,
  FiscalDocType.NOTA_CREDITO,
];

/**
 * Correcciones 05 / M4: los comprobantes **vivos** de cada pedido —el mismo corte que el
 * reporte de ventas: `LIVE_DOCUMENT_STATUSES` de `@ayr/shared`, no archivados (RF-72)—, por
 * fecha de emisión y número.
 *
 * **Una sola consulta** para todos los pedidos de la página, sin importar cuántos sean: la lista
 * de pedidos no puede pagar un viaje a la base por fila (`order-documents.spec.ts`).
 */
export async function liveDocumentsByOrder(
  prisma: Pick<PrismaClient, 'fiscalDocument'>,
  orderIds: readonly string[],
): Promise<Map<string, SalesOrderDocumentLinkDto[]>> {
  const out = new Map<string, SalesOrderDocumentLinkDto[]>();
  if (orderIds.length === 0) return out;
  const rows = await prisma.fiscalDocument.findMany({
    where: {
      salesOrderId: { in: [...new Set(orderIds)] },
      docType: { in: ORDER_DOCUMENT_TYPES },
      status: { in: [...LIVE_DOCUMENT_STATUSES] },
      archivedAt: null,
    },
    select: { id: true, number: true, docType: true, issueDate: true, salesOrderId: true },
    orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
  });
  for (const row of rows) {
    if (row.salesOrderId === null) continue;
    const list = out.get(row.salesOrderId) ?? [];
    list.push({
      id: row.id,
      number: row.number,
      docType: row.docType,
      issueDate: row.issueDate.toISOString().slice(0, 10),
    });
    out.set(row.salesOrderId, list);
  }
  return out;
}

/**
 * UAT de cc13: lo mismo para **un** pedido (su detalle), más cuántos comprobantes anulados tiene.
 * Es **la misma consulta** que antes hacía `liveDocumentsByOrder` en el detalle, con `ANNULLED`
 * en el filtro de estado: el detalle no paga ninguna consulta de más, y un pedido sin anulados
 * no dispara la sección «Comprobantes anulados» (`order-documents.spec.ts`).
 */
export async function orderDocuments(
  prisma: Pick<PrismaClient, 'fiscalDocument'>,
  salesOrderId: string,
): Promise<{ live: SalesOrderDocumentLinkDto[]; annulledCount: number }> {
  const rows = await prisma.fiscalDocument.findMany({
    where: {
      salesOrderId,
      docType: { in: ORDER_DOCUMENT_TYPES },
      status: { in: [...LIVE_DOCUMENT_STATUSES, FiscalDocumentStatus.ANNULLED] },
      archivedAt: null,
    },
    select: { id: true, number: true, docType: true, issueDate: true, status: true },
    orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
  });
  const live: SalesOrderDocumentLinkDto[] = [];
  let annulledCount = 0;
  for (const row of rows) {
    if (row.status === FiscalDocumentStatus.ANNULLED) {
      annulledCount += 1;
      continue;
    }
    live.push({
      id: row.id,
      number: row.number,
      docType: row.docType,
      issueDate: row.issueDate.toISOString().slice(0, 10),
    });
  }
  return { live, annulledCount };
}
