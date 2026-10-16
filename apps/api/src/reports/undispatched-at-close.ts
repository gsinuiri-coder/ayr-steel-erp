import {
  Decimal,
  toDecimal,
  type UndispatchedAtCloseDto,
  type UndispatchedAtCloseRowDto,
  type UndispatchedAtCloseStatus,
} from '@ayr/shared';

/**
 * cc56 (D-670) — el armado puro de «Facturado y no despachado al cierre», **por cantidades**.
 *
 * Por línea de pedido: lo facturado hasta el cierre (comprobantes vivos emitidos hasta esa fecha)
 * menos lo despachado hasta el cierre (despachos vivos, declarados o no: D-205 no obliga a declarar).
 * Lo que falta se reparte entre las líneas facturadas **desde la más reciente hacia atrás**: los
 * despachos cubren primero lo facturado antes. Un comprobante del período entra si alguna de sus
 * líneas queda con algo pendiente al cierre; las líneas sin línea de pedido (un servicio, un ajuste)
 * no se despachan y no cuentan.
 *
 * No recalcula costos: el «costo estimado» es el costo con que Ventas y margen cuenta el comprobante
 * (D-667), en la proporción que queda pendiente (pesada por el subtotal de sus líneas).
 */

export interface CloseDocument {
  id: string;
  number: string;
  issueDate: string;
  customerName: string;
  salesPen: string;
  costPen: string | null;
}

/** Una línea de comprobante vivo con línea de pedido, emitido hasta el cierre. */
export interface CloseInvoiceLine {
  documentId: string;
  issueDate: string;
  /** Desempate estable entre comprobantes del mismo día. */
  number: string;
  salesOrderItemId: string;
  qty: string;
  subtotalPen: string;
}

/** Una línea de despacho vivo. */
export interface CloseDispatchLine {
  salesOrderItemId: string;
  qty: string;
  dispatchDate: string;
}

const ZERO = new Decimal(0);

export function undispatchedAtClose(input: {
  from: string;
  to: string;
  documents: readonly CloseDocument[];
  lines: readonly CloseInvoiceLine[];
  dispatches: readonly CloseDispatchLine[];
}): UndispatchedAtCloseDto {
  const lines = input.lines.filter((l) => l.issueDate <= input.to);
  // Lo despachado hasta el cierre y las fechas de salida posteriores, por línea de pedido.
  const outUpTo = new Map<string, Decimal>();
  const laterDates = new Map<string, Set<string>>();
  for (const d of input.dispatches) {
    if (d.dispatchDate <= input.to) {
      outUpTo.set(
        d.salesOrderItemId,
        (outUpTo.get(d.salesOrderItemId) ?? ZERO).plus(toDecimal(d.qty)),
      );
    } else {
      const set = laterDates.get(d.salesOrderItemId) ?? new Set<string>();
      set.add(d.dispatchDate);
      laterDates.set(d.salesOrderItemId, set);
    }
  }
  // Lo pendiente de cada línea facturada: se reparte desde la más reciente.
  const pendingOfLine = new Map<CloseInvoiceLine, Decimal>();
  const byItem = new Map<string, CloseInvoiceLine[]>();
  for (const l of lines)
    byItem.set(l.salesOrderItemId, [...(byItem.get(l.salesOrderItemId) ?? []), l]);
  for (const [item, itemLines] of byItem) {
    const invoiced = itemLines.reduce((acc, l) => acc.plus(toDecimal(l.qty)), ZERO);
    let pending = Decimal.max(invoiced.minus(outUpTo.get(item) ?? ZERO), ZERO);
    const newestFirst = [...itemLines].sort(
      (a, b) => b.issueDate.localeCompare(a.issueDate) || b.number.localeCompare(a.number),
    );
    for (const l of newestFirst) {
      const take = Decimal.min(pending, toDecimal(l.qty));
      pendingOfLine.set(l, take);
      pending = pending.minus(take);
    }
  }

  const rows: UndispatchedAtCloseRowDto[] = [];
  for (const doc of input.documents) {
    const own = lines.filter((l) => l.documentId === doc.id);
    const subtotal = own.reduce((acc, l) => acc.plus(toDecimal(l.subtotalPen)), ZERO);
    let pendingValue = ZERO;
    let pendingQtyLines = 0;
    let fullyPending = true;
    const dates = new Set<string>();
    for (const l of own) {
      const p = pendingOfLine.get(l) ?? ZERO;
      const qty = toDecimal(l.qty);
      if (p.gt(0)) {
        pendingQtyLines += 1;
        if (!qty.isZero())
          pendingValue = pendingValue.plus(toDecimal(l.subtotalPen).times(p).div(qty));
        for (const d of laterDates.get(l.salesOrderItemId) ?? []) dates.add(d);
      }
      if (p.lt(qty)) fullyPending = false;
    }
    if (pendingQtyLines === 0) continue;
    let status: UndispatchedAtCloseStatus = 'PARCIAL';
    if (fullyPending) status = dates.size > 0 ? 'DESPACHADO_DESPUES' : 'SIN_SALIDA';
    const share = subtotal.isZero()
      ? new Decimal(1)
      : Decimal.min(pendingValue.div(subtotal), new Decimal(1));
    rows.push({
      documentId: doc.id,
      number: doc.number,
      issueDate: doc.issueDate,
      customerName: doc.customerName,
      salesPen: doc.salesPen,
      estimatedCostPen:
        doc.costPen === null ? null : toDecimal(doc.costPen).times(share).toFixed(4),
      dispatchDates: [...dates].sort((a, b) => a.localeCompare(b)),
      status,
    });
  }
  rows.sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.number.localeCompare(b.number));
  const withCost = rows.filter((r) => r.estimatedCostPen !== null);
  return {
    from: input.from,
    to: input.to,
    rows,
    totals: {
      count: rows.length,
      salesPen: rows.reduce((acc, r) => acc.plus(toDecimal(r.salesPen)), ZERO).toFixed(4),
      estimatedCostPen: withCost
        .reduce((acc, r) => acc.plus(toDecimal(r.estimatedCostPen ?? '0')), ZERO)
        .toFixed(4),
      withoutCostCount: rows.length - withCost.length,
    },
  };
}
