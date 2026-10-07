import type { Decimal, SalesMarginOrderDto } from '@ayr/shared';
import { marginPctOf, sumDecimal } from './report-table';

/**
 * cc32 — «Ver por» de Ventas y margen: agrupa en el navegador las filas que el reporte ya trae.
 * No pide nada nuevo al API ni cambia qué filas entran: agrupa las mismas filas de la tabla
 * (las que suman, `inTotals`), y por eso la suma de los grupos es la suma de la tabla por pedido.
 *
 * Las sumas son exactas (`Decimal`) y se redondean solo al mostrarlas.
 */
export const SALES_MARGIN_VIEWS = ['pedido', 'vendedor', 'cliente'] as const;
export type SalesMarginView = (typeof SALES_MARGIN_VIEWS)[number];

export const SALES_MARGIN_VIEW_LABELS: Record<SalesMarginView, string> = {
  pedido: 'Pedido',
  vendedor: 'Vendedor',
  cliente: 'Cliente',
};

/** La vista pedida por la URL; cualquier otro valor es «Pedido». */
export function parseSalesMarginView(raw: string): SalesMarginView {
  return (SALES_MARGIN_VIEWS as readonly string[]).includes(raw)
    ? (raw as SalesMarginView)
    : 'pedido';
}

/** Lo que suma un conjunto de filas: el pie de la tabla y cada grupo. */
export interface SalesMarginSummary {
  /** Filas sumadas. */
  count: number;
  sales: Decimal;
  /** Suma de los costos conocidos; una fila sin costo no suma. */
  cost: Decimal;
  /** Suma de los márgenes conocidos. */
  margin: Decimal;
  /** Margen sobre la venta de las filas con margen; `null` sin base positiva. */
  marginPct: string | null;
}

export function summarizeSalesMargin(orders: readonly SalesMarginOrderDto[]): SalesMarginSummary {
  const sales = sumDecimal(orders, (o) => o.salesPen);
  const margin = sumDecimal(orders, (o) => o.marginPen);
  // La base del porcentaje es la venta de las filas que tienen margen: una fila sin costo
  // comparable no puede bajar ni subir el porcentaje.
  const marginBase = sumDecimal(orders, (o) => (o.marginPen === null ? null : o.salesPen));
  return {
    count: orders.length,
    sales,
    cost: sumDecimal(orders, (o) => o.costPen),
    margin,
    marginPct: marginPctOf(marginBase, margin),
  };
}

export interface SalesMarginGroup extends SalesMarginSummary {
  key: string;
  /** El vendedor o el cliente, como se ve en la tabla. */
  label: string;
  orders: SalesMarginOrderDto[];
}

/** Nombre de la fila sin vendedor (una venta directa de mostrador puede no tenerlo). */
export const NO_SELLER_LABEL = 'Sin vendedor';

/**
 * Agrupa por vendedor o por cliente. El cliente no trae id en este reporte, así que se agrupa
 * por su nombre. Los grupos salen en el orden en que aparece su primera fila.
 */
export function groupSalesMargin(
  orders: readonly SalesMarginOrderDto[],
  by: Exclude<SalesMarginView, 'pedido'>,
): SalesMarginGroup[] {
  const buckets = new Map<string, { label: string; orders: SalesMarginOrderDto[] }>();
  for (const order of orders) {
    const label = by === 'vendedor' ? (order.sellerName ?? NO_SELLER_LABEL) : order.customerName;
    const key = by === 'vendedor' && order.sellerName === null ? '' : label;
    const bucket = buckets.get(key);
    if (bucket) bucket.orders.push(order);
    else buckets.set(key, { label, orders: [order] });
  }
  return [...buckets.entries()].map(([key, b]) => ({
    key,
    label: b.label,
    orders: b.orders,
    ...summarizeSalesMargin(b.orders),
  }));
}
