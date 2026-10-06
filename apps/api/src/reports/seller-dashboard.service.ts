import { Injectable } from '@nestjs/common';
import {
  businessToday,
  dashboardMonthRanges,
  fiscalDocumentQuerySchema,
  FiscalDocType,
  LIVE_DOCUMENT_STATUSES,
  QuotationStatus,
  toDateOnly,
  type SellerDashboardDto,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { quotationSellerWhere } from '../auth/seller-scope';
import { fiscalDocumentListWhere } from '../invoicing/fiscal-document-where';
import { PrismaService } from '../prisma/prisma.service';
import { assembleSellerDashboard } from './seller-dashboard';

/**
 * cc27 (M4, D-457, propuesta de D-450). El Panel del vendedor: sus ventas del mes y su conversión
 * de cotización a pedido. **El alcance es el del servidor**, el mismo de sus listas: los
 * comprobantes con `fiscalDocumentListWhere` (los que emitió o los de sus pedidos) y las
 * cotizaciones con `quotationSellerWhere`. Tres consultas, sin costos ni márgenes.
 */
@Injectable()
export class SellerDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async dashboard(
    actor: RequestUser,
    today: string = businessToday(),
  ): Promise<SellerDashboardDto> {
    const month = dashboardMonthRanges(today).current;
    const issueDate = { gte: toDateOnly(month.from), lte: toDateOnly(month.to) };

    // El alcance y el archivado de la lista de comprobantes; el estado se fija aparte: los vivos,
    // como el reporte de ventas y margen. La guía de remisión no es una venta.
    const scope = fiscalDocumentListWhere(fiscalDocumentQuerySchema.parse({}), actor, [
      ...LIVE_DOCUMENT_STATUSES,
    ]);
    const [sales, quotationsIssued, quotationsConverted] = await Promise.all([
      this.prisma.fiscalDocument.groupBy({
        by: ['docType'],
        where: {
          AND: [
            scope,
            {
              status: { in: [...LIVE_DOCUMENT_STATUSES] },
              docType: { not: FiscalDocType.GUIA_REMISION_REMITENTE },
              issueDate,
            },
          ],
        },
        _count: { _all: true },
        _sum: { subtotalPen: true },
      }),
      this.prisma.quotation.count({
        where: {
          ...quotationSellerWhere(actor),
          status: { not: QuotationStatus.DRAFT },
          issueDate,
        },
      }),
      this.prisma.quotation.count({
        where: {
          ...quotationSellerWhere(actor),
          status: { not: QuotationStatus.DRAFT },
          issueDate,
          salesOrders: { some: {} },
        },
      }),
    ]);

    return assembleSellerDashboard({
      month,
      sales: sales.map((g) => ({
        docType: g.docType,
        count: g._count._all,
        subtotalPen: g._sum.subtotalPen?.toString() ?? null,
      })),
      quotationsIssued,
      quotationsConverted,
    });
  }
}
