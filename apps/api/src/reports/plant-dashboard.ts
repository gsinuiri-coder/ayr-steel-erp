import {
  CoilKind,
  CoilStatus,
  Decimal,
  LOW_COIL_THRESHOLD_PCT,
  type CoilDto,
  type CoilWasteDto,
  type DashboardRange,
  type PlantDashboardDto,
  type ProductionOrderListItemDto,
  type ProductionQueueEntryDto,
} from '@ayr/shared';

/** Cuántas órdenes de la cola muestra el Panel; el resto está en `/planta`. */
export const PLANT_QUEUE_PREVIEW = 6;

/**
 * cc26 (D-440, M5). Arma el Panel del supervisor de planta con lo que devuelven las lecturas de
 * planta, tal cual: la cola de `/planta`, las órdenes vivas con sus bobinas montadas, la merma
 * por pestaña (solo su consumo) y la lista de bobinas. Lo único que se decide aquí es qué bobina
 * está «por terminarse» (D-448): su saldo del kardex sobre su peso, contra el umbral.
 */
export function assemblePlantDashboard(input: {
  asOf: string;
  week: DashboardRange;
  queue: ProductionQueueEntryDto[];
  liveOrders: ProductionOrderListItemDto[];
  wasteToday: CoilWasteDto[];
  wasteWeek: CoilWasteDto[];
  openCoils: CoilDto[];
}): PlantDashboardDto {
  const mountedBy = new Map<string, { orderId: string; code: string }[]>();
  for (const order of input.liveOrders) {
    for (const coilCode of order.mountedCoilCodes) {
      const list = mountedBy.get(coilCode) ?? [];
      list.push({ orderId: order.id, code: order.code });
      mountedBy.set(coilCode, list);
    }
  }

  const threshold = new Decimal(LOW_COIL_THRESHOLD_PCT);
  const lowCoils = input.openCoils
    .filter((c) => c.kind === CoilKind.COIL && c.status === CoilStatus.OPEN)
    .filter((c) => new Decimal(c.weightKg).gt(0) && new Decimal(c.availableKg).gt(0))
    .map((c) => ({
      coil: c,
      pct: new Decimal(c.availableKg).div(c.weightKg).times(100),
    }))
    .filter((x) => x.pct.lte(threshold))
    .sort((a, b) => a.pct.comparedTo(b.pct) || a.coil.code.localeCompare(b.coil.code))
    .map(({ coil, pct }) => ({
      id: coil.id,
      code: coil.code,
      businessLine: coil.businessLine,
      colorName: coil.colorName,
      availableKg: coil.availableKg,
      weightKg: coil.weightKg,
      remainingPct: pct.toFixed(1),
      mounted: mountedBy.has(coil.code),
    }));

  return {
    asOf: input.asOf,
    week: input.week,
    queue: {
      count: input.queue.length,
      overdueCount: input.queue.filter((q) => q.overdue).length,
      priorityCount: input.queue.filter((q) => q.priority).length,
      next: input.queue.slice(0, PLANT_QUEUE_PREVIEW).map((q) => ({
        orderId: q.orderId,
        code: q.code,
        customerName: q.customerName,
        productName: q.productName,
        planMeters: q.planMeters,
        promisedDeliveryDate: q.promisedDeliveryDate,
        overdue: q.overdue,
        priority: q.priority,
      })),
    },
    mounted: [...mountedBy.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([coilCode, orders]) => ({ coilCode, orders })),
    production: input.wasteWeek.map((week) => {
      const today = input.wasteToday.find((t) => t.businessLine === week.businessLine);
      return {
        businessLine: week.businessLine,
        todayKg: today?.totals.consumedKg ?? '0.000',
        todayCoilCount: today?.totals.coilCount ?? 0,
        weekKg: week.totals.consumedKg,
        weekCoilCount: week.totals.coilCount,
      };
    }),
    lowCoils,
  };
}
