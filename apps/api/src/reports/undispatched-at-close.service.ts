import { Injectable } from '@nestjs/common';
import { DispatchStatus } from '@prisma/client';
import {
  fromDateOnly,
  type UndispatchedAtCloseDto,
  type UndispatchedAtCloseQuery,
} from '@ayr/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SalesMarginService } from './sales-margin.service';
import { undispatchedAtClose, type CloseDocument } from './undispatched-at-close';

/**
 * cc56 (D-670) — «Facturado y no despachado al cierre». Toma los comprobantes del período de
 * **Ventas y margen** (la misma venta y el mismo costo, D-667) y los despachos declarados vivos de
 * cada uno (D-205); deja los que salen después del cierre o todavía no salieron. Solo lee.
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
    const dispatches = await this.prisma.dispatch.findMany({
      where: { invoiceId: { in: documents.map((d) => d.id) }, status: DispatchStatus.ISSUED },
      select: { invoiceId: true, dispatchDate: true },
    });
    return undispatchedAtClose({
      from: query.from,
      to: query.to,
      documents,
      dispatches: dispatches.flatMap((d) =>
        d.invoiceId ? [{ invoiceId: d.invoiceId, dispatchDate: fromDateOnly(d.dispatchDate) }] : [],
      ),
    });
  }
}
