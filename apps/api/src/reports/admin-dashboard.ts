import {
  AGING_BUCKETS,
  Decimal,
  toFixedString,
  type AdminDashboardDto,
  type CoilWasteDto,
  type DashboardRange,
  type InventoryValuationDto,
  type ReceivablesAgingDto,
  type SalesMarginDto,
} from '@ayr/shared';

/**
 * cc26 (D-440). Arma el Panel del administrador **con los DTO de los reportes, tal cual**: cada
 * cifra es un campo de su reporte para el mismo rango, y lo único que se hace aquí es elegirla.
 * Las dos excepciones son agrupaciones de filas del propio reporte, sin otra regla: lo facturado
 * por día (la venta de cada comprobante del reporte por su fecha de emisión, D-444 provisional) y
 * lo vencido de CxC (sus tramos vencidos, sumados).
 */
export function assembleAdminDashboard(input: {
  asOf: string;
  current: DashboardRange;
  previous: DashboardRange;
  salesCurrent: SalesMarginDto;
  salesPrevious: SalesMarginDto;
  receivables: ReceivablesAgingDto;
  inventory: InventoryValuationDto;
  waste: CoilWasteDto[];
}): AdminDashboardDto {
  const { salesCurrent, receivables, inventory } = input;
  const t = salesCurrent.totals;

  const byDay = new Map<string, Decimal>();
  for (const order of salesCurrent.orders) {
    for (const doc of order.documents) {
      byDay.set(doc.issueDate, (byDay.get(doc.issueDate) ?? ZERO).plus(doc.salesPen));
    }
  }

  const overdue = AGING_BUCKETS.filter((b) => b !== 'CURRENT').reduce(
    (acc, b) => acc.plus(receivables.totals.buckets[b]),
    ZERO,
  );

  return {
    asOf: input.asOf,
    current: input.current,
    previous: input.previous,
    sales: {
      salesPen: t.salesPen,
      noCostSalesPen: t.noCostSalesPen,
      costPen: t.costPen,
      marginPen: t.marginPen,
      marginPct: t.marginPct,
      partialOrderCount: t.partialOrderCount,
      excludedOrderCount: t.excludedOrderCount,
      excludedSalesPen: t.excludedSalesPen,
      untraceableOrderCount: t.untraceableOrderCount,
      untraceableSalesPen: t.untraceableSalesPen,
    },
    previousSalesPen: input.salesPrevious.totals.salesPen,
    salesByDay: [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, salesPen: toFixedString(v, 'MONEY') })),
    salesByLine: salesCurrent.totalsByLine.map((l) => ({
      businessLine: l.businessLine,
      salesPen: l.salesPen,
      marginPen: l.marginPen,
      marginPct: l.marginPct,
    })),
    receivables: {
      balancePen: receivables.totals.balancePen,
      overduePen: toFixedString(overdue, 'MONEY'),
      buckets: receivables.totals.buckets,
      documentCount: receivables.totals.documentCount,
      customerCount: receivables.totals.customerCount,
    },
    inventory: {
      totalValuePen: inventory.totals.totalValuePen,
      coilValuePen: inventory.totals.coilValuePen,
      productValuePen: inventory.totals.productValuePen,
    },
    outOfTolerance: input.waste.map((w) => {
      const flagged = w.rows.filter((r) => r.productions.some((p) => p.outOfTolerance !== null));
      // D-465 (SM-1 de cc29): un reporte de drywall sale de varios flejes y aparece en la fila de
      // cada uno; se cuenta una vez por reporte.
      const reports = new Set(
        flagged.flatMap((r) =>
          r.productions
            .filter((p) => p.outOfTolerance !== null)
            .map((p, i) => p.reportId ?? `${r.coilId}:${String(i)}`),
        ),
      );
      return {
        businessLine: w.businessLine,
        productionCount: reports.size,
        coilCount: flagged.length,
      };
    }),
  };
}

const ZERO = new Decimal(0);
