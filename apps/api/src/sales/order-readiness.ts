import type { Prisma } from '@prisma/client';
import { Decimal, toDecimal, type OrderStage, type SalesOrderStatus } from '@ayr/shared';

export const ORDER_READINESS = [
  'SIN_PRODUCCION',
  'EN_PRODUCCION',
  'LISTO',
  'LISTO_CON_FALTANTE',
] as const;
export type OrderReadiness = (typeof ORDER_READINESS)[number];

export interface ReadinessOrder {
  status: 'DRAFT' | 'IN_PROGRESS' | 'CLOSED' | 'CANCELLED';
  orderedMl: string;
  reportedMl: string;
}

/** Estado derivado RF-S3c: sólo OP vivas, Decimal y sin persistir una columna/enum. */
export function deriveOrderReadiness(orders: ReadinessOrder[]): {
  status: OrderReadiness;
  orderedMl: string;
  reportedMl: string;
  missingMl: string;
} {
  const live = orders.filter((order) => order.status !== 'CANCELLED');
  if (live.length === 0)
    return {
      status: 'SIN_PRODUCCION',
      orderedMl: '0.000',
      reportedMl: '0.000',
      missingMl: '0.000',
    };
  const orderedMl = live.reduce(
    (total, order) => total.plus(toDecimal(order.orderedMl)),
    new Decimal(0),
  );
  const reportedMl = live.reduce(
    (total, order) => total.plus(toDecimal(order.reportedMl)),
    new Decimal(0),
  );
  const missingMl = Decimal.max(new Decimal(0), orderedMl.minus(reportedMl));
  if (live.some((order) => order.status !== 'CLOSED')) {
    return {
      status: 'EN_PRODUCCION',
      orderedMl: orderedMl.toFixed(3),
      reportedMl: reportedMl.toFixed(3),
      missingMl: missingMl.toFixed(3),
    };
  }
  return {
    status: missingMl.gt(0) ? 'LISTO_CON_FALTANTE' : 'LISTO',
    orderedMl: orderedMl.toFixed(3),
    reportedMl: reportedMl.toFixed(3),
    missingMl: missingMl.toFixed(3),
  };
}

/**
 * D-277: el estado del pedido que se **muestra** y se filtra. El persistido `IN_PRODUCTION`
 * lo pone la primera producción (D-060) y ninguna operación lo quita al cerrar las OP, así que
 * un pedido con todo producido seguía «En producción» hasta despacharse. «Listo» no se guarda
 * (§3.4, sin estado derivado almacenado): sale del estado persistido más `readiness`.
 *
 * Lo despachado manda sobre lo producido; el comprobante no mueve ninguno de los dos.
 */
export function deriveOrderStage(status: SalesOrderStatus, readiness: OrderReadiness): OrderStage {
  if (
    (status === 'CONFIRMED' || status === 'IN_PRODUCTION') &&
    (readiness === 'LISTO' || readiness === 'LISTO_CON_FALTANTE')
  ) {
    return 'READY';
  }
  return status;
}

/** La misma regla que `deriveOrderReadiness` da por LISTO, como filtro de la lista. */
const READY_CONDITIONS: Prisma.SalesOrderWhereInput[] = [
  { reservations: { some: { productionOrders: { some: { status: { not: 'CANCELLED' } } } } } },
  {
    NOT: {
      reservations: {
        some: { productionOrders: { some: { status: { in: ['DRAFT', 'IN_PROGRESS'] } } } },
      },
    },
  },
];

export function orderStageWhere(stage: OrderStage): Prisma.SalesOrderWhereInput {
  switch (stage) {
    case 'READY':
      return { status: { in: ['CONFIRMED', 'IN_PRODUCTION'] }, AND: READY_CONDITIONS };
    case 'CONFIRMED':
    case 'IN_PRODUCTION':
      return { status: stage, NOT: { AND: READY_CONDITIONS } };
    default:
      return { status: stage };
  }
}
