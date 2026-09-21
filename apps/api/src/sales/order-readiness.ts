import { Decimal, toDecimal, type OrderReadinessDto } from '@ayr/shared';

export interface ReadinessOrder {
  status: 'DRAFT' | 'IN_PROGRESS' | 'CLOSED' | 'CANCELLED';
  orderedMl: string;
  reportedMl: string;
}

/** Estado derivado RF-S3c: sólo OP vivas, Decimal y sin persistir una columna/enum. */
export function deriveOrderReadiness(orders: ReadinessOrder[]): OrderReadinessDto {
  const live = orders.filter((order) => order.status !== 'CANCELLED');
  if (live.length === 0) return { status: 'SIN_PRODUCCION', orderedMl: '0.000', reportedMl: '0.000', missingMl: '0.000' };
  const orderedMl = live.reduce((total, order) => total.plus(toDecimal(order.orderedMl)), new Decimal(0));
  const reportedMl = live.reduce((total, order) => total.plus(toDecimal(order.reportedMl)), new Decimal(0));
  const missingMl = Decimal.max(new Decimal(0), orderedMl.minus(reportedMl));
  if (live.some((order) => order.status !== 'CLOSED')) {
    return { status: 'EN_PRODUCCION', orderedMl: orderedMl.toFixed(3), reportedMl: reportedMl.toFixed(3), missingMl: missingMl.toFixed(3) };
  }
  return {
    status: missingMl.gt(0) ? 'LISTO_CON_FALTANTE' : 'LISTO',
    orderedMl: orderedMl.toFixed(3),
    reportedMl: reportedMl.toFixed(3),
    missingMl: missingMl.toFixed(3),
  };
}
