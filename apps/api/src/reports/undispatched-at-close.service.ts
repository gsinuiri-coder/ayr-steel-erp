import { Injectable } from '@nestjs/common';
import { DispatchStatus, FiscalDocType } from '@prisma/client';
import {
  fromDateOnly,
  LIVE_DOCUMENT_STATUSES,
  toDateOnly,
  type UndispatchedAtCloseDto,
  type UndispatchedAtCloseQuery,
} from '@ayr/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SalesMarginService } from './sales-margin.service';
import { undispatchedAtClose, type CloseDocument } from './undispatched-at-close';

/**
 * cc56 (D-670) — «Facturado y no despachado al cierre». Los comprobantes del período salen de
 * **Ventas y margen** (la misma venta y el mismo costo, D-667); lo pendiente se mide por cantidades
 * en sus líneas de pedido: lo facturado hasta el cierre contra lo despachado hasta el cierre
 * (despachos vivos, declarados o no). Solo lee: tres consultas además de Ventas y margen.
 */
@Injectable()
export class UndispatchedAtCloseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly salesMargin: SalesMarginService,
  ) {}

  async report(query: UndispatchedAtCloseQuery): Promise<UndispatchedAtCloseDto> {
    const margin = await this.salesMargin.salesMargin({ from: query.from, to: query.to });
    const documents: CloseDocument[] = margin.orders.flatMap((order) =>
      order.documents
        .filter((d) => d.docType === 'FACTURA' || d.docType === 'BOLETA')
        .map((d) => ({
          id: d.id,
          number: d.number ?? '(sin número)',
          issueDate: d.issueDate,
          customerName: order.customerName,
          salesPen: d.salesPen,
          costPen: d.costPen,
        })),
    );
    const empty = { from: query.from, to: query.to, documents, lines: [], dispatches: [] };
    if (documents.length === 0) return undispatchedAtClose(empty);

    const own = await this.prisma.fiscalDocumentItem.findMany({
      where: { documentId: { in: documents.map((d) => d.id) }, salesOrderItemId: { not: null } },
      select: { salesOrderItemId: true },
    });
    const itemIds = [
      ...new Set(own.flatMap((l) => (l.salesOrderItemId ? [l.salesOrderItemId] : []))),
    ];
    if (itemIds.length === 0) return undispatchedAtClose(empty);

    const [lines, dispatches] = await Promise.all([
      // Todo lo facturado de esas líneas de pedido hasta el cierre, también en meses anteriores.
      this.prisma.fiscalDocumentItem.findMany({
        where: {
          salesOrderItemId: { in: itemIds },
          document: {
            docType: { in: [FiscalDocType.FACTURA, FiscalDocType.BOLETA] },
            status: { in: [...LIVE_DOCUMENT_STATUSES] },
            archivedAt: null,
            issueDate: { lte: toDateOnly(query.to) },
          },
        },
        select: {
          documentId: true,
          salesOrderItemId: true,
          qty: true,
          subtotalPen: true,
          document: { select: { issueDate: true, number: true } },
        },
      }),
      this.prisma.dispatchItem.findMany({
        where: { salesOrderItemId: { in: itemIds }, dispatch: { status: DispatchStatus.ISSUED } },
        select: { salesOrderItemId: true, qty: true, dispatch: { select: { dispatchDate: true } } },
      }),
    ]);
    return undispatchedAtClose({
      from: query.from,
      to: query.to,
      documents,
      lines: lines.flatMap((l) =>
        l.salesOrderItemId
          ? [
              {
                documentId: l.documentId,
                issueDate: fromDateOnly(l.document.issueDate),
                number: l.document.number ?? '',
                salesOrderItemId: l.salesOrderItemId,
                qty: l.qty.toString(),
                subtotalPen: l.subtotalPen.toString(),
              },
            ]
          : [],
      ),
      dispatches: dispatches.map((d) => ({
        salesOrderItemId: d.salesOrderItemId,
        qty: d.qty.toString(),
        dispatchDate: fromDateOnly(d.dispatch.dispatchDate),
      })),
    });
  }
}
