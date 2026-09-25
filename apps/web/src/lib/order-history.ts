import {
  toDecimal,
  type ProductionOrderListItemDto,
  type ProductionOrderStatus,
} from '@ayr/shared';

/**
 * D-291: el historial de órdenes de producción se lee **por pedido**: una fila por pedido con
 * sus órdenes adentro. Esto agrupa las órdenes que ya trae `GET /production` (el listado
 * entrega las de un pedido juntas y por correlativo descendente) y deriva lo que la fila del
 * pedido muestra. Nada de esto se guarda: sale de las órdenes al leer (§3.4).
 */
export interface HistoryGroup {
  key: string;
  salesOrderId: string | null;
  salesOrderCode: string | null;
  customerName: string | null;
  /** Día de negocio de la orden más reciente del grupo (`YYYY-MM-DD`). */
  date: string;
  orders: ProductionOrderListItemDto[];
  closedCount: number;
  /** ML que el plan de corte encarga y ML ya reportados; `null` si ninguna orden es de coberturas. */
  planMeters: string | null;
  reportedMeters: string | null;
  status: ProductionOrderStatus;
}

export function groupHistoryByOrder(rows: readonly ProductionOrderListItemDto[]): HistoryGroup[] {
  const byKey = new Map<string, ProductionOrderListItemDto[]>();
  for (const order of rows) {
    const key = order.salesOrderId ?? 'sin-pedido';
    byKey.set(key, [...(byKey.get(key) ?? []), order]);
  }
  return [...byKey.entries()].map(([key, orders]) => {
    const first = orders[0];
    const meterOrders = orders.filter((o) => o.planMeters !== null || o.metersReported !== null);
    return {
      key,
      salesOrderId: first?.salesOrderId ?? null,
      salesOrderCode: first?.salesOrderCode ?? null,
      customerName: first?.customerName ?? null,
      date: orders.map((o) => o.operationDate).reduce((a, b) => (a >= b ? a : b), ''),
      orders,
      closedCount: orders.filter((o) => o.status === 'CLOSED').length,
      planMeters:
        meterOrders.length === 0
          ? null
          : meterOrders
              .reduce((sum, o) => sum.plus(toDecimal(o.planMeters ?? '0')), toDecimal('0'))
              .toFixed(3),
      reportedMeters:
        meterOrders.length === 0
          ? null
          : meterOrders
              .reduce((sum, o) => sum.plus(toDecimal(o.metersReported ?? '0')), toDecimal('0'))
              .toFixed(3),
      status: deriveGroupStatus(orders.map((o) => o.status)),
    };
  });
}

/**
 * El estado de un pedido según sus órdenes: manda lo que sigue vivo. Con alguna en proceso, «En
 * proceso»; con alguna en borrador y ninguna en proceso, «Borrador» (todavía sin arrancar); si
 * todas terminaron —cerradas, con o sin anuladas mezcladas— «Cerrada»; si todas se anularon,
 * «Anulada».
 */
export function deriveGroupStatus(
  statuses: readonly ProductionOrderStatus[],
): ProductionOrderStatus {
  if (statuses.includes('IN_PROGRESS')) return 'IN_PROGRESS';
  if (statuses.includes('DRAFT')) return 'DRAFT';
  if (statuses.includes('CLOSED')) return 'CLOSED';
  return 'CANCELLED';
}
