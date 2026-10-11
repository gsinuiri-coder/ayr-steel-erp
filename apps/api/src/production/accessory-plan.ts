import { ProductionOrderStatus, ProductionReportStatus, type Prisma } from '@prisma/client';
import { Decimal, toDecimal } from '@ayr/shared';

/**
 * D-605 (cc45): el «plan» de una orden de accesorio. Un accesorio no lleva plan de largos
 * (D-343): lo que pide son los metros de la línea del pedido. Desde D-604 una línea puede tener
 * más de una orden —una cerrada y otra nueva por la diferencia cuando se sube la cantidad—, así
 * que el plan de cada orden son los metros de la línea **menos lo que registraron las otras
 * órdenes no anuladas de la misma línea**. Con una sola orden es exactamente lo de antes. Una
 * orden **cerrada** se mide contra lo que fabricó si eso es menos: cerró exacta contra su plan
 * (D-573), y una orden nueva por la diferencia no le cambia el plan después.
 *
 * Una consulta para todas las órdenes que se piden, y ninguna si no hay accesorios.
 */
export interface AccessoryPlanInput {
  orderId: string;
  salesOrderItemId: string;
  lineQty: Decimal;
  /** La orden está cerrada: su plan no pasa de lo que ella misma registró. */
  closed?: boolean;
}

export async function accessoryPlans(
  db: Pick<Prisma.TransactionClient, 'productionReport'>,
  orders: readonly AccessoryPlanInput[],
): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>();
  if (orders.length === 0) return out;
  const lineIds = [...new Set(orders.map((o) => o.salesOrderItemId))];
  const reports = await db.productionReport.findMany({
    where: {
      status: ProductionReportStatus.ACTIVE,
      productionOrder: {
        status: { not: ProductionOrderStatus.CANCELLED },
        reservation: { salesOrderItemId: { in: lineIds } },
      },
    },
    select: {
      productionOrderId: true,
      metersM: true,
      productionOrder: { select: { reservation: { select: { salesOrderItemId: true } } } },
    },
  });
  const metersOf = (rows: typeof reports) =>
    rows.reduce(
      (acc, r) => (r.metersM === null ? acc : acc.plus(toDecimal(r.metersM.toString()))),
      new Decimal(0),
    );
  for (const order of orders) {
    const line = reports.filter(
      (r) => r.productionOrder.reservation?.salesOrderItemId === order.salesOrderItemId,
    );
    const own = metersOf(line.filter((r) => r.productionOrderId === order.orderId));
    const others = metersOf(line.filter((r) => r.productionOrderId !== order.orderId));
    const plan = Decimal.max(order.lineQty.minus(others), new Decimal(0));
    out.set(order.orderId, order.closed === true ? Decimal.min(plan, own) : plan);
  }
  return out;
}

/** El plan de una sola orden de accesorio, dentro de la transacción del llamador. */
export async function accessoryPlanMeters(
  tx: Prisma.TransactionClient,
  orderId: string,
  reservationId: string,
): Promise<Decimal> {
  const reservation = await tx.reservation.findUniqueOrThrow({
    where: { id: reservationId },
    select: { salesOrderItemId: true, salesOrderItem: { select: { qty: true } } },
  });
  const plans = await accessoryPlans(tx, [
    {
      orderId,
      salesOrderItemId: reservation.salesOrderItemId,
      lineQty: toDecimal(reservation.salesOrderItem.qty.toString()),
    },
  ]);
  return plans.get(orderId) ?? new Decimal(0);
}
