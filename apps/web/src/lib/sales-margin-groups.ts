import type { Decimal, SalesMarginOrderDto } from '@ayr/shared';
import { filterReportRows, marginPctOf, sumDecimal } from './report-table';

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
  /** Filas con pedido. */
  orderCount: number;
  /** Filas sin pedido: ventas directas, que se agrupan solas (D-518). */
  directSaleCount: number;
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
  const orderCount = orders.filter((o) => o.salesOrderId !== null).length;
  return {
    count: orders.length,
    orderCount,
    directSaleCount: orders.length - orderCount,
    sales,
    cost: sumDecimal(orders, (o) => o.costPen),
    margin,
    marginPct: marginPctOf(marginBase, margin),
  };
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/**
 * D-518 (provisional): un solo criterio para contar, en la franja, el pie y la columna
 * «Pedidos»: se cuentan los pedidos, y las ventas sin pedido (directas) se nombran aparte.
 * «4 pedidos» o «4 pedidos · 1 venta sin pedido».
 */
export function countLabel(summary: Pick<SalesMarginSummary, 'orderCount' | 'directSaleCount'>) {
  const orders = plural(summary.orderCount, 'pedido', 'pedidos');
  return summary.directSaleCount === 0
    ? orders
    : `${orders} · ${plural(summary.directSaleCount, 'venta sin pedido', 'ventas sin pedido')}`;
}

/**
 * Lo que el buscador mira de una fila: el pedido, sus comprobantes, el cliente, el vendedor y el
 * estado del costo. Es el mismo en la vista por pedido y en «Ver por».
 */
export function salesMarginSearchText(
  order: SalesMarginOrderDto,
  costStatusLabel: string,
): string[] {
  return [
    order.orderCode ?? '',
    ...order.documents.map((d) => d.number ?? ''),
    order.customerName,
    order.sellerName ?? '',
    costStatusLabel,
  ];
}

/**
 * Las filas que coinciden con la búsqueda. En «Ver por» se filtra **antes** de agrupar: así cada
 * grupo y el pie suman solo los pedidos que coinciden.
 */
export function filterSalesMargin(
  orders: readonly SalesMarginOrderDto[],
  search: string,
  costStatusLabel: (order: SalesMarginOrderDto) => string = () => '',
): SalesMarginOrderDto[] {
  return filterReportRows(
    orders,
    [{ key: 'all', searchText: (o) => salesMarginSearchText(o, costStatusLabel(o)) }],
    search,
  );
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
