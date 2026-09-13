import {
  businessToday,
  compareQueueRank,
  isOverdue,
  ProductionOrderKind,
  ProductionOrderStatus,
  toDecimal,
  type ProductionOrderListItemDto,
  type ProductionQueueEntryDto,
  type QueueRankable,
  type RoofingBatchOrderDto,
} from '@ayr/shared';

/**
 * F8-S3b/M2: `/planta` entra por **pedido**, no por OP. Este módulo arma los grupos de la
 * primera vista a partir de las mismas tres lecturas que ya hacía la pantalla (el batch de
 * coberturas, las órdenes de perfiles abiertas y la cola), sin endpoint nuevo.
 *
 * El orden **no inventa un criterio**: cada pedido se representa por su orden más urgente
 * según `compareQueueRank` (D-189) y los pedidos se comparan con ese mismo ranking. Así la
 * lista de pedidos y la cola de un pedido nunca pueden discrepar sobre qué va primero.
 */

/** Valor de `?pedido=` para las órdenes que no nacieron de un pedido (corridas a stock). */
export const WITHOUT_SALES_ORDER = 'sin-pedido';

export interface PedidoGroup {
  /** `salesOrderId`, o `WITHOUT_SALES_ORDER`. */
  key: string;
  salesOrderId: string | null;
  salesOrderCode: string | null;
  customerName: string | null;
  promisedDeliveryDate: string | null;
  roofing: RoofingBatchOrderDto[];
  drywall: ProductionOrderListItemDto[];
  /** Las órdenes de coberturas no iniciadas del pedido, en el orden de la cola. */
  queue: ProductionQueueEntryDto[];
  /** Órdenes de coberturas vivas con prioridad manual, de cuántas vivas. */
  prioritized: number;
  overdue: boolean;
  /** La orden más urgente: la que decide dónde va el pedido en la lista. */
  lead: QueueRankable;
  counts: { total: number; covered: number; inProgress: number; notStarted: number };
  /** ML reportados y del plan, sumados sobre las órdenes de coberturas abiertas. */
  reportedMeters: string;
  planMeters: string;
  productSkus: string[];
}

/** El listado de perfiles no trae el correlativo: sale del código (`OP-000123`). */
export function seqOf(code: string): number {
  const digits = /(\d+)$/.exec(code)?.[1];
  return digits === undefined ? Number.MAX_SAFE_INTEGER : Number(digits);
}

function roofingCovered(order: RoofingBatchOrderDto): boolean {
  return order.planItems.length > 0 && toDecimal(order.remainingMeters).lte(0);
}

export function groupByPedido(
  roofing: readonly RoofingBatchOrderDto[],
  drywall: readonly ProductionOrderListItemDto[],
  queue: readonly ProductionQueueEntryDto[],
  today: string = businessToday(),
): PedidoGroup[] {
  const groups = new Map<string, PedidoGroup>();
  const groupOf = (
    salesOrderId: string | null,
    salesOrderCode: string | null,
    customerName: string | null,
    promisedDeliveryDate: string | null,
  ): PedidoGroup => {
    const key = salesOrderId ?? WITHOUT_SALES_ORDER;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        key,
        salesOrderId,
        salesOrderCode,
        customerName,
        promisedDeliveryDate,
        roofing: [],
        drywall: [],
        queue: [],
        prioritized: 0,
        overdue: false,
        lead: { priority: false, promisedDeliveryDate: null, seq: Number.MAX_SAFE_INTEGER },
        counts: { total: 0, covered: 0, inProgress: 0, notStarted: 0 },
        reportedMeters: '0',
        planMeters: '0',
        productSkus: [],
      };
      groups.set(key, group);
    }
    return group;
  };

  const queued = new Set(queue.map((e) => e.orderId));
  const ranks = new Map<string, QueueRankable[]>();
  const rank = (key: string, r: QueueRankable) => {
    ranks.set(key, [...(ranks.get(key) ?? []), r]);
  };

  for (const o of roofing) {
    const g = groupOf(o.salesOrderId, o.salesOrderCode, o.customerName, o.promisedDeliveryDate);
    g.roofing.push(o);
    rank(g.key, o);
  }
  for (const o of drywall) {
    if (o.kind !== ProductionOrderKind.DRYWALL) continue;
    const g = groupOf(o.salesOrderId, o.salesOrderCode, o.customerName, o.promisedDeliveryDate);
    g.drywall.push(o);
    rank(g.key, {
      priority: o.priority,
      promisedDeliveryDate: o.promisedDeliveryDate,
      seq: seqOf(o.code),
    });
  }
  for (const e of queue) {
    groups.get(e.salesOrderId ?? WITHOUT_SALES_ORDER)?.queue.push(e);
  }

  for (const g of groups.values()) {
    const sorted = [...(ranks.get(g.key) ?? [])].sort((a, b) => compareQueueRank(a, b, today));
    if (sorted[0]) g.lead = sorted[0];
    g.overdue = isOverdue(g.promisedDeliveryDate, today);
    g.prioritized = g.roofing.filter((o) => o.priority).length;
    let reported = toDecimal('0');
    let plan = toDecimal('0');
    const skus = new Set<string>();
    for (const o of g.roofing) {
      reported = reported.plus(toDecimal(o.reportedMeters));
      plan = plan.plus(toDecimal(o.planMeters));
      skus.add(o.productSku);
      if (roofingCovered(o)) g.counts.covered += 1;
      else if (queued.has(o.orderId)) g.counts.notStarted += 1;
      else g.counts.inProgress += 1;
    }
    for (const o of g.drywall) {
      skus.add(o.productSku);
      if (o.status === ProductionOrderStatus.DRAFT) g.counts.notStarted += 1;
      else g.counts.inProgress += 1;
    }
    g.counts.total = g.roofing.length + g.drywall.length;
    g.reportedMeters = reported.toFixed(3);
    g.planMeters = plan.toFixed(3);
    g.productSkus = [...skus].sort();
  }

  // Las corridas sin pedido van al final: no hay cliente esperando ni fecha prometida.
  return [...groups.values()].sort((a, b) => {
    if ((a.salesOrderId === null) !== (b.salesOrderId === null)) {
      return a.salesOrderId === null ? 1 : -1;
    }
    return compareQueueRank(a.lead, b.lead, today);
  });
}
