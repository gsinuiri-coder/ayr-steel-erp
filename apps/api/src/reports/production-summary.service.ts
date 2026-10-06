import { Injectable } from '@nestjs/common';
import {
  BusinessLine,
  toDateOnly,
  toDecimal,
  type ProductionSummaryDto,
  type ProductionSummaryQuery,
} from '@ayr/shared';
import { toPrismaLineCode } from '../common/business-line-code';
import { PrismaService } from '../prisma/prisma.service';
import {
  assembleProductionSummary,
  type SummaryMovement,
  type SummaryOrder,
  type SummaryReport,
} from './production-summary';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `refId` es texto libre: solo un uuid puede ser el id de un reporte o de una OP. */
function isUuid(value: string | null): value is string {
  return value !== null && UUID.test(value);
}

/**
 * cc29 (M2, D-420, D-464, D-468). Reporte de producción por OP. **Solo lectura.**
 *
 * **Consultas fijas**, sin importar cuántas OPs o bobinas haya: los movimientos del rango (una), y
 * los reportes, las órdenes y los códigos de bobina (una cada una, y ninguna si no hay movimientos).
 * Cuatro como máximo, verificado por test.
 */
@Injectable()
export class ProductionSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async report(query: ProductionSummaryQuery, withCosts: boolean): Promise<ProductionSummaryDto> {
    const businessLine = query.businessLine ?? BusinessLine.METALLIC_ROOFING;
    const base = { from: query.from, to: query.to, businessLine, withCosts };

    // Los movimientos vivos del rango (D-291: ni anulados ni la anulación de otro), de la línea.
    const rows = await this.prisma.inventoryMovement.findMany({
      where: {
        itemType: 'COIL',
        refType: { in: ['PRODUCTION', 'SCRAP'] },
        operationDate: { gte: toDateOnly(query.from), lte: toDateOnly(query.to) },
        businessLine: { code: toPrismaLineCode(businessLine) },
        reversalOfId: null,
        reversals: { none: {} },
      },
      select: { itemId: true, type: true, qty: true, totalCost: true, refType: true, refId: true },
      orderBy: { id: 'asc' },
    });
    const movements: SummaryMovement[] = rows.map((m) => ({
      itemId: m.itemId,
      type: m.type,
      qty: toDecimal(m.qty.toString()),
      totalCost: toDecimal(m.totalCost.toString()),
      refType: m.refType,
      refId: m.refId,
    }));
    if (movements.length === 0) {
      return assembleProductionSummary({
        ...base,
        movements: [],
        reports: new Map(),
        orders: new Map(),
        coilCodes: new Map(),
      });
    }

    const reportIds = [
      ...new Set(
        movements
          .filter((m) => m.refType === 'PRODUCTION')
          .map((m) => m.refId)
          .filter(isUuid),
      ),
    ];
    const reportRows =
      reportIds.length === 0
        ? []
        : await this.prisma.productionReport.findMany({
            where: { id: { in: reportIds } },
            select: {
              id: true,
              productionOrderId: true,
              pieces: true,
              metersM: true,
              theoreticalKg: true,
            },
          });
    // Las OPs: las de los reportes y las del despunte (que apunta a la OP, no a la bobina).
    const orderIds = [
      ...new Set([
        ...reportRows.map((r) => r.productionOrderId),
        ...movements
          .filter((m) => m.refType === 'SCRAP' && m.refId !== m.itemId)
          .map((m) => m.refId)
          .filter(isUuid),
      ]),
    ];
    const coilIds = [...new Set(movements.map((m) => m.itemId))];
    const [orderRows, coilRows] = await Promise.all([
      this.prisma.productionOrder.findMany({
        where: { id: { in: orderIds } },
        select: {
          id: true,
          seq: true,
          status: true,
          productId: true,
          product: { select: { sku: true, name: true, unit: true } },
          reservation: {
            select: {
              salesOrderId: true,
              salesOrder: { select: { seq: true } },
              salesOrderItem: { select: { lineNumber: true } },
            },
          },
        },
      }),
      this.prisma.coil.findMany({
        where: { id: { in: coilIds } },
        select: { id: true, code: true },
      }),
    ]);

    const reports = new Map<string, SummaryReport>(
      reportRows.map((r) => [
        r.id,
        {
          id: r.id,
          productionOrderId: r.productionOrderId,
          pieces: r.pieces,
          metersM: r.metersM === null ? null : toDecimal(r.metersM.toString()),
          theoreticalKg: toDecimal(r.theoreticalKg.toString()),
        },
      ]),
    );
    const orders = new Map<string, SummaryOrder>(
      orderRows.map((o) => [
        o.id,
        {
          id: o.id,
          seq: o.seq,
          status: o.status,
          productId: o.productId,
          productSku: o.product.sku,
          productName: o.product.name,
          productUnit: o.product.unit,
          salesOrderId: o.reservation?.salesOrderId ?? null,
          salesOrderSeq: o.reservation?.salesOrder.seq ?? null,
          lineNumber: o.reservation?.salesOrderItem.lineNumber ?? null,
        },
      ]),
    );
    return assembleProductionSummary({
      ...base,
      movements,
      reports,
      orders,
      coilCodes: new Map(coilRows.map((c) => [c.id, c.code])),
    });
  }
}
