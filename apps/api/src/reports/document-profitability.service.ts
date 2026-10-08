import { Injectable, NotFoundException } from '@nestjs/common';
import { FiscalDocType, Prisma } from '@prisma/client';
import {
  FISCAL_DOCUMENT_STATUS_LABELS,
  LIVE_DOCUMENT_STATUSES,
  type DocumentProfitabilityDto,
} from '@ayr/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  assembleDocumentProfitability,
  notApplicable,
  type DeclaredSale,
} from './document-profitability';
import { SalesByMaterialService } from './sales-by-material.service';

interface DeclaredRow {
  sales_order_item_id: string;
  dispatched_qty: Prisma.Decimal;
  costed_qty: Prisma.Decimal;
  cost_pen: Prisma.Decimal;
  without_movement: boolean;
  dispatch_seqs: number[] | null;
}

/**
 * C06 — **Rentabilidad de un comprobante** (solo ADMINISTRADOR). Solo lectura.
 *
 * Presupuesto de consultas **fijo, sin N+1**: el comprobante (1), sus líneas y las de sus notas
 * de crédito (1), los hechos del motor de «Ventas por material» para las líneas de Coberturas
 * Aluzinc (3, solo si hay) y las salidas de sus despachos declarados para el resto (1, solo si
 * hay). Seis como máximo, con una línea o con cien.
 */
@Injectable()
export class DocumentProfitabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly material: SalesByMaterialService,
  ) {}

  async profitability(documentId: string): Promise<DocumentProfitabilityDto> {
    const doc = await this.prisma.fiscalDocument.findUnique({
      where: { id: documentId },
      select: { id: true, number: true, docType: true, status: true, archivedAt: true },
    });
    if (doc === null) throw new NotFoundException('Comprobante no encontrado');
    const header = { id: doc.id, number: doc.number, docType: doc.docType };
    if (doc.docType === FiscalDocType.GUIA_REMISION_REMITENTE) {
      return notApplicable(header, 'Una guía de remisión no es una venta');
    }
    if (doc.archivedAt !== null) {
      return notApplicable(header, 'El comprobante está archivado: no suma a la rentabilidad');
    }
    if (!LIVE_DOCUMENT_STATUSES.includes(doc.status)) {
      return notApplicable(
        header,
        `El comprobante está ${FISCAL_DOCUMENT_STATUS_LABELS[doc.status].toLowerCase()}: no es una venta viva`,
      );
    }

    const rows = await this.material.documentLines(documentId);
    const engineItems = rows
      .filter((r) => r.in_engine)
      .map((r) => r.sales_order_item_id)
      .filter((v): v is string => v !== null);
    const needsDispatch =
      doc.docType !== FiscalDocType.NOTA_CREDITO && rows.some((r) => !r.is_credit && !r.in_engine);
    const [engine, declared] = await Promise.all([
      this.material.engineFacts(engineItems),
      needsDispatch ? this.declaredSales(documentId) : Promise.resolve([]),
    ]);

    return assembleDocumentProfitability({
      document: header,
      rows,
      engine,
      declared: new Map(
        declared.map((d): [string, DeclaredSale] => [
          d.sales_order_item_id,
          {
            dispatchedQty: d.dispatched_qty.toString(),
            costedQty: d.costed_qty.toString(),
            costPen: d.cost_pen.toString(),
            withoutMovement: d.without_movement,
            dispatchSeqs: [...(d.dispatch_seqs ?? [])].sort((a, b) => a - b),
          },
        ]),
      ),
      hasDeclaredDispatch: declared.some(
        (d) => d.dispatch_seqs !== null && d.dispatch_seqs.length > 0,
      ),
    });
  }

  /**
   * Las salidas de kardex (`SALE`) de los despachos **declarados** del comprobante
   * (`Dispatch.invoiceId`, D-205/D-213), por línea de pedido: lo despachado vigente y su costo,
   * neto de reversas (la reversa es un `IN` con el mismo `refId` que resta, como D-242).
   * cc34 (N7): `costed_qty` es lo despachado vigente que salió **con** movimiento: el costo es de
   * esa cantidad, no de todo lo despachado.
   */
  private declaredSales(documentId: string): Promise<DeclaredRow[]> {
    return this.prisma.$queryRaw<DeclaredRow[]>`
      SELECT
        di."sales_order_item_id",
        COALESCE(SUM(CASE WHEN d."status" = 'ISSUED' THEN di."qty" ELSE 0 END), 0) AS "dispatched_qty",
        COALESCE(SUM(CASE WHEN d."status" = 'ISSUED' AND di."movement_id" IS NOT NULL THEN di."qty" ELSE 0 END), 0)
          AS "costed_qty",
        COALESCE(SUM(mv."cost"), 0) AS "cost_pen",
        COALESCE(BOOL_OR(d."status" = 'ISSUED' AND di."movement_id" IS NULL), false) AS "without_movement",
        ARRAY_AGG(DISTINCT d."seq") FILTER (WHERE d."status" = 'ISSUED') AS "dispatch_seqs"
      FROM "dispatches" d
      JOIN "dispatch_items" di ON di."dispatch_id" = d."id"
      LEFT JOIN LATERAL (
        SELECT SUM(CASE WHEN m."type" = 'OUT' THEN m."total_cost" ELSE -m."total_cost" END) AS "cost"
        FROM "inventory_movements" m
        WHERE m."ref_type" = 'SALE'
          AND m."ref_id" = d."id"::text
          AND COALESCE(m."reversal_of_id", m."id") = di."movement_id"
      ) mv ON true
      WHERE d."invoice_id" = ${documentId}::uuid
      GROUP BY di."sales_order_item_id"
    `;
  }
}
