import {
  Decimal,
  toDecimal,
  type UndispatchedAtCloseDto,
  type UndispatchedAtCloseRowDto,
  type UndispatchedAtCloseStatus,
} from '@ayr/shared';

/**
 * cc56 (D-670) — el armado puro de «Facturado y no despachado al cierre», sobre lo que ya calcula
 * Ventas y margen (venta y costo por comprobante, D-667) y las fechas de los despachos declarados.
 * No recalcula ningún costo: el «costo estimado» es el mismo número que el reporte del período.
 */

export interface CloseDocument {
  id: string;
  number: string;
  issueDate: string;
  customerName: string;
  salesPen: string;
  costPen: string | null;
}

export interface CloseDispatch {
  invoiceId: string;
  dispatchDate: string;
}

export function undispatchedAtClose(input: {
  from: string;
  to: string;
  documents: readonly CloseDocument[];
  dispatches: readonly CloseDispatch[];
}): UndispatchedAtCloseDto {
  const byInvoice = new Map<string, string[]>();
  for (const d of input.dispatches) {
    byInvoice.set(d.invoiceId, [...(byInvoice.get(d.invoiceId) ?? []), d.dispatchDate]);
  }
  const rows: UndispatchedAtCloseRowDto[] = [];
  for (const doc of input.documents) {
    const dates = [...(byInvoice.get(doc.id) ?? [])].sort((a, b) => a.localeCompare(b));
    const after = dates.filter((d) => d > input.to);
    if (dates.length > 0 && after.length === 0) continue;
    let status: UndispatchedAtCloseStatus = 'SIN_SALIDA';
    if (dates.length > 0) status = after.length === dates.length ? 'DESPACHADO_DESPUES' : 'PARCIAL';
    rows.push({
      documentId: doc.id,
      number: doc.number,
      issueDate: doc.issueDate,
      customerName: doc.customerName,
      salesPen: doc.salesPen,
      estimatedCostPen: status === 'SIN_SALIDA' ? null : doc.costPen,
      dispatchDates: dates,
      status,
    });
  }
  rows.sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.number.localeCompare(b.number));
  const zero = new Decimal(0);
  const withCost = rows.filter((r) => r.estimatedCostPen !== null);
  return {
    from: input.from,
    to: input.to,
    rows,
    totals: {
      count: rows.length,
      salesPen: rows.reduce((acc, r) => acc.plus(toDecimal(r.salesPen)), zero).toFixed(4),
      estimatedCostPen: withCost
        .reduce((acc, r) => acc.plus(toDecimal(r.estimatedCostPen ?? '0')), zero)
        .toFixed(4),
      withoutCostCount: rows.length - withCost.length,
    },
  };
}
