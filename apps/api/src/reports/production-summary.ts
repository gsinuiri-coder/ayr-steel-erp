import {
  Decimal,
  productionOrderCode,
  salesOrderCode,
  STANDARD_WASTE_PCT,
  type ProductionSummaryCoilDto,
  type ProductionSummaryDto,
  type ProductionSummaryGroupDto,
  type ProductionSummaryLine,
  type ProductionSummaryOrderDto,
} from '@ayr/shared';

/**
 * cc29 (M2, D-464, D-468). El reporte de producción, armado sin tocar la base: recibe los
 * movimientos vivos del rango y lo que hace falta para nombrarlos, y devuelve el DTO. Vive aparte
 * del servicio para probar las cuentas sin una base (mismo criterio que `coil-waste.ts`).
 */

export interface SummaryMovement {
  itemId: string;
  /** `IN` u `OUT` (lo demás no suma). */
  type: string;
  qty: Decimal;
  totalCost: Decimal;
  /** `PRODUCTION` o `SCRAP`. */
  refType: string;
  refId: string | null;
}

export interface SummaryReport {
  id: string;
  productionOrderId: string;
  pieces: number;
  metersM: Decimal | null;
  theoreticalKg: Decimal;
}

export interface SummaryOrder {
  id: string;
  seq: number;
  status: string;
  productId: string;
  productSku: string;
  productName: string;
  productUnit: string;
  salesOrderId: string | null;
  salesOrderSeq: number | null;
  lineNumber: number | null;
}

interface Figures {
  theoretical: Decimal;
  consumed: Decimal;
  trim: Decimal;
  materialCost: Decimal;
  trimCost: Decimal;
}

const ZERO = new Decimal(0);
const emptyFigures = (): Figures => ({
  theoretical: ZERO,
  consumed: ZERO,
  trim: ZERO,
  materialCost: ZERO,
  trimCost: ZERO,
});

export function assembleProductionSummary(input: {
  from: string;
  to: string;
  businessLine: ProductionSummaryLine;
  withCosts: boolean;
  movements: readonly SummaryMovement[];
  reports: ReadonlyMap<string, SummaryReport>;
  orders: ReadonlyMap<string, SummaryOrder>;
  coilCodes: ReadonlyMap<string, string>;
}): ProductionSummaryDto {
  interface OrderAcc {
    figures: Figures;
    reportIds: Set<string>;
    coils: Map<string, { consumed: Decimal; trim: Decimal }>;
  }
  const byOrder = new Map<string, OrderAcc>();
  const accFor = (orderId: string): OrderAcc => {
    let acc = byOrder.get(orderId);
    if (acc === undefined) {
      acc = { figures: emptyFigures(), reportIds: new Set(), coils: new Map() };
      byOrder.set(orderId, acc);
    }
    return acc;
  };
  const coilFor = (acc: OrderAcc, coilId: string) => {
    let coil = acc.coils.get(coilId);
    if (coil === undefined) {
      coil = { consumed: ZERO, trim: ZERO };
      acc.coils.set(coilId, coil);
    }
    return coil;
  };

  let unattributed = ZERO;
  for (const m of input.movements) {
    const kg = signed(m, m.qty);
    const cost = signed(m, m.totalCost);
    if (m.refType === 'PRODUCTION') {
      const report = m.refId === null ? undefined : input.reports.get(m.refId);
      if (report === undefined || !input.orders.has(report.productionOrderId)) {
        unattributed = unattributed.plus(kg);
        continue;
      }
      const acc = accFor(report.productionOrderId);
      acc.reportIds.add(report.id);
      acc.figures.consumed = acc.figures.consumed.plus(kg);
      acc.figures.materialCost = acc.figures.materialCost.plus(cost);
      const coil = coilFor(acc, m.itemId);
      coil.consumed = coil.consumed.plus(kg);
    } else if (m.refType === 'SCRAP') {
      // El despunte apunta a la OP; la merma manual (RF-17) apunta a la bobina y no es de una OP.
      if (m.refId === null || m.refId === m.itemId || !input.orders.has(m.refId)) continue;
      const acc = accFor(m.refId);
      acc.figures.trim = acc.figures.trim.plus(kg);
      acc.figures.trimCost = acc.figures.trimCost.plus(cost);
      const coil = coilFor(acc, m.itemId);
      coil.trim = coil.trim.plus(kg);
    }
  }

  // El teórico es del reporte entero (D-433: no se reparte entre bobinas); cada reporte una vez.
  for (const acc of byOrder.values()) {
    for (const id of acc.reportIds) {
      const report = input.reports.get(id);
      if (report) acc.figures.theoretical = acc.figures.theoretical.plus(report.theoreticalKg);
    }
  }

  const orderDtos: { order: SummaryOrder; dto: ProductionSummaryOrderDto; figures: Figures }[] = [];
  for (const [orderId, acc] of byOrder) {
    const order = input.orders.get(orderId);
    if (order === undefined) continue;
    const reports = [...acc.reportIds]
      .map((id) => input.reports.get(id))
      .filter((r): r is SummaryReport => r !== undefined);
    const byLength = order.productUnit === 'MTR';
    const quantity = byLength
      ? reports.reduce((a, r) => a.plus(r.metersM ?? ZERO), ZERO).toFixed(3)
      : String(reports.reduce((a, r) => a + r.pieces, 0));
    const coils: ProductionSummaryCoilDto[] = [...acc.coils.entries()]
      .map(([coilId, c]) => ({
        coilId,
        code: input.coilCodes.get(coilId) ?? coilId,
        consumedKg: c.consumed.toFixed(3),
        trimKg: c.trim.toFixed(3),
      }))
      .sort((a, b) => a.code.localeCompare(b.code));
    orderDtos.push({
      order,
      figures: acc.figures,
      dto: {
        productionOrderId: order.id,
        code: productionOrderCode(order.seq),
        status: order.status,
        salesOrderId: order.salesOrderId,
        salesOrderCode: order.salesOrderSeq === null ? null : salesOrderCode(order.salesOrderSeq),
        lineNumber: order.lineNumber,
        productId: order.productId,
        productSku: order.productSku,
        productName: order.productName,
        quantity,
        quantityUnit: byLength ? 'm' : 'pzs',
        reportCount: reports.length,
        ...figuresDto(acc.figures, input.withCosts),
        coils,
      },
    });
  }

  // Por pedido (su correlativo) y, dentro, por línea y OP; las corridas sin pedido al final.
  orderDtos.sort(
    (a, b) =>
      (a.order.salesOrderSeq ?? Number.MAX_SAFE_INTEGER) -
        (b.order.salesOrderSeq ?? Number.MAX_SAFE_INTEGER) ||
      (a.order.lineNumber ?? 0) - (b.order.lineNumber ?? 0) ||
      a.order.seq - b.order.seq,
  );
  const buckets: { group: ProductionSummaryGroupDto; figures: Figures }[] = [];
  for (const item of orderDtos) {
    const last = buckets.at(-1);
    if (last?.group.salesOrderId === item.order.salesOrderId) {
      last.group.orders.push(item.dto);
      last.figures = add(last.figures, item.figures);
    } else {
      buckets.push({
        group: {
          salesOrderId: item.order.salesOrderId,
          salesOrderCode: item.dto.salesOrderCode,
          orders: [item.dto],
          subtotal: figuresDto(emptyFigures(), input.withCosts),
        },
        figures: item.figures,
      });
    }
  }
  const groups = buckets.map(({ group, figures }) => ({
    ...group,
    subtotal: figuresDto(figures, input.withCosts),
  }));

  const total = orderDtos.reduce((a, o) => add(a, o.figures), emptyFigures());
  return {
    from: input.from,
    to: input.to,
    businessLine: input.businessLine,
    standardPct: STANDARD_WASTE_PCT,
    withCosts: input.withCosts,
    groups,
    totals: {
      orderCount: orderDtos.length,
      ...figuresDto(total, input.withCosts),
      unattributedKg: unattributed.toFixed(3),
    },
  };
}

function figuresDto(f: Figures, withCosts: boolean) {
  const pct = f.theoretical.isZero()
    ? null
    : f.consumed.minus(f.theoretical).plus(f.trim).div(f.theoretical).times(100).toFixed(2);
  return {
    theoreticalKg: f.theoretical.toFixed(3),
    consumedKg: f.consumed.toFixed(3),
    trimKg: f.trim.toFixed(3),
    wastePct: pct,
    overStandard: pct !== null && new Decimal(pct).gt(STANDARD_WASTE_PCT),
    materialCostPen: withCosts ? f.materialCost.toFixed(4) : null,
    trimCostPen: withCosts ? f.trimCost.toFixed(4) : null,
  };
}

function add(a: Figures, b: Figures): Figures {
  return {
    theoretical: a.theoretical.plus(b.theoretical),
    consumed: a.consumed.plus(b.consumed),
    trim: a.trim.plus(b.trim),
    materialCost: a.materialCost.plus(b.materialCost),
    trimCost: a.trimCost.plus(b.trimCost),
  };
}

/** Una salida suma y una entrada resta. */
function signed(m: SummaryMovement, value: Decimal): Decimal {
  if (m.type === 'OUT') return value;
  if (m.type === 'IN') return value.negated();
  return ZERO;
}
