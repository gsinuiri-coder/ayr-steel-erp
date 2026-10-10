import { filterBySearch, salesMarginSearchText, type SalesMarginOrderDto } from '@ayr/shared';

/**
 * cc32 — «Ver por» de Ventas y margen: agrupa en el navegador las filas que el reporte ya trae.
 * No pide nada nuevo al API ni cambia qué filas entran: agrupa las mismas filas de la tabla
 * (las que suman, `inTotals`), y por eso la suma de los grupos es la suma de la tabla por pedido.
 *
 * cc40: el resumen, el agrupado (por id, D-586) y el texto buscable viven en `@ayr/shared`
 * (`report-rows.ts`): el Excel de «Por pedido» suma su total con la misma función que el pie.
 *
 * Las sumas son exactas (`Decimal`) y se redondean solo al mostrarlas.
 */
export {
  NO_SELLER_LABEL,
  groupSalesMargin,
  salesMarginCountLabel as countLabel,
  salesMarginSearchText,
  summarizeSalesMargin,
  type SalesMarginGroup,
  type SalesMarginSummary,
} from '@ayr/shared';

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

/**
 * Las filas que coinciden con la búsqueda. En «Ver por» se filtra **antes** de agrupar: así cada
 * grupo y el pie suman solo los pedidos que coinciden.
 */
export function filterSalesMargin(
  orders: readonly SalesMarginOrderDto[],
  search: string,
): SalesMarginOrderDto[] {
  return filterBySearch(orders, salesMarginSearchText, search);
}
