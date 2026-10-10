import {
  CoilFilmState,
  agingTotalsOf,
  coilMonthRowSearchText,
  coilMonthTotalsOf,
  coilWasteRowSearchText,
  filterBySearch,
  inventoryCoilGroupSearchText,
  inventoryProductSearchText,
  materialFiguresOf,
  productTotalsOf,
  productionGroupSearchText,
  productionOrderSearchText,
  productionTotalsOf,
  receivablesCustomerSearchText,
  salesMaterialRowSearchText,
  salesProductRowSearchText,
  searchWords,
  wasteTotalsOf,
  type CoilMonthReportDto,
  type CoilMonthReportSectionDto,
  type CoilWasteDto,
  type InventoryValuationDto,
  type ProductionSummaryDto,
  type ProductionSummaryGroupDto,
  type ProductionView,
  type ReceivablesAgingDto,
  type SalesByMaterialDto,
  type SalesMaterialKind,
  type Decimal,
} from '@ayr/shared';

/**
 * cc40 (D-588) — **la búsqueda de la pantalla, aplicada al DTO antes de armar el Excel.** Cada
 * función recorta las filas que la pantalla recorta, con el mismo texto buscable
 * (`@ayr/shared`, `report-rows.ts`), y recalcula los totales que la pantalla recalcula al pie con
 * la búsqueda puesta, con las mismas funciones. Lo que la pantalla no busca (resúmenes, franjas,
 * totales por línea, lo no trazable) queda entero.
 *
 * Sin búsqueda, o con una que deja todas las filas, devuelve el DTO tal cual: los totales son los
 * del API, como el pie de la pantalla (`allRows`): las filas llegan redondeadas a su escala y
 * sumarlas podría correr un milésimo.
 */

const searching = (search: string): boolean => searchWords(search).length > 0;
const fixed = (d: Decimal): string => d.toFixed();
const fixedOrNull = (d: Decimal | null): string | null => (d === null ? null : d.toFixed());

/** Reporte mensual de bobinas: las dos tablas (Selladas y Abiertas), con su subtotal. */
export function searchCoilMonth(report: CoilMonthReportDto, search: string): CoilMonthReportDto {
  if (!searching(search)) return report;
  const section = (s: CoilMonthReportSectionDto, film: CoilFilmState) => {
    const rows = filterBySearch(s.rows, (r) => coilMonthRowSearchText(r, film), search);
    if (rows.length === s.rows.length) return s;
    const t = coilMonthTotalsOf(rows);
    return {
      rows,
      totals: {
        openingKg: fixed(t.openingKg),
        weightKg: fixed(t.weightKg),
        closingKg: fixed(t.closingKg),
        // El rol que no ve costos sigue sin verlos aunque no quede ninguna fila.
        closingValuePen: s.totals.closingValuePen === null ? null : fixedOrNull(t.closingValuePen),
      },
    };
  };
  return {
    ...report,
    sealed: section(report.sealed, CoilFilmState.SEALED),
    opened: section(report.opened, CoilFilmState.OPENED),
  };
}

/** Cuentas por cobrar: los clientes que coinciden, con sus comprobantes, y su total. */
export function searchReceivables(
  report: ReceivablesAgingDto,
  search: string,
): ReceivablesAgingDto {
  if (!searching(search)) return report;
  const customers = filterBySearch(report.customers, receivablesCustomerSearchText, search);
  if (customers.length === report.customers.length) return report;
  const t = agingTotalsOf(customers);
  return {
    ...report,
    customers,
    totals: {
      balancePen: fixed(t.balancePen),
      buckets: {
        CURRENT: fixed(t.buckets.CURRENT),
        D1_30: fixed(t.buckets.D1_30),
        D31_60: fixed(t.buckets.D31_60),
        D61_90: fixed(t.buckets.D61_90),
        OVER_90: fixed(t.buckets.OVER_90),
      },
      documentCount: t.documentCount,
      customerCount: customers.length,
    },
  };
}

/**
 * Inventario valorizado: los grupos de bobinas (con sus bobinas) y los productos que coinciden.
 * Los totales por línea no se buscan en la pantalla y quedan enteros.
 */
export function searchInventory(
  report: InventoryValuationDto,
  search: string,
): InventoryValuationDto {
  if (!searching(search)) return report;
  return {
    ...report,
    coilGroups: filterBySearch(report.coilGroups, inventoryCoilGroupSearchText, search),
    products: filterBySearch(report.products, inventoryProductSearchText, search),
  };
}

/** Merma por bobina: las bobinas que coinciden y su total, como el pie de la pantalla. */
export function searchCoilWaste(report: CoilWasteDto, search: string): CoilWasteDto {
  if (!searching(search)) return report;
  const rows = filterBySearch(report.rows, coilWasteRowSearchText, search);
  if (rows.length === report.rows.length) return report;
  const t = wasteTotalsOf(rows, report.standardPct);
  return {
    ...report,
    rows,
    totals: {
      coilCount: t.coilCount,
      consumedKg: fixed(t.consumedKg),
      trimKg: fixed(t.trimKg),
      closeAdjustmentKg: fixed(t.closeAdjustmentKg),
      manualScrapKg: fixed(t.manualScrapKg),
      comparableCoilCount: t.comparableCoilCount,
      comparableConsumedKg: fixed(t.comparableConsumedKg),
      theoreticalKg: fixed(t.theoreticalKg),
      differenceKg: fixed(t.differenceKg),
      wasteKg: fixed(t.wasteKg),
      wastePct: t.wastePct,
      overStandard: t.overStandard,
    },
  };
}

/**
 * Reporte de producción. La pantalla busca por orden o por pedido según «Ver por»: por pedido se
 * quedan los pedidos enteros que coinciden (su subtotal no cambia); por orden, las órdenes que
 * coinciden, agrupadas en su pedido con el subtotal de lo que quedó. El total es el de las
 * órdenes que quedan, como el pie. Lo salido sin reporte de planta no es de ninguna fila y no
 * suma con búsqueda.
 */
export function searchProduction(
  report: ProductionSummaryDto,
  search: string,
  view: ProductionView = 'orden',
): ProductionSummaryDto {
  if (!searching(search)) return report;
  const figures = (orders: ProductionSummaryGroupDto['orders']) => {
    const t = productionTotalsOf(orders, report.standardPct);
    return {
      theoreticalKg: fixed(t.theoreticalKg),
      consumedKg: fixed(t.consumedKg),
      trimKg: fixed(t.trimKg),
      wastePct: t.wastePct,
      overStandard: t.overStandard,
      materialCostPen: report.withCosts ? fixedOrNull(t.materialCostPen) : null,
      trimCostPen: report.withCosts ? fixedOrNull(t.trimCostPen) : null,
    };
  };
  const groups =
    view === 'pedido'
      ? filterBySearch(report.groups, productionGroupSearchText, search)
      : report.groups
          .map((g) => {
            const orders = filterBySearch(g.orders, productionOrderSearchText, search);
            return orders.length === g.orders.length
              ? g
              : { ...g, orders, subtotal: figures(orders) };
          })
          .filter((g) => g.orders.length > 0);
  const orders = groups.flatMap((g) => g.orders);
  if (orders.length === report.groups.reduce((n, g) => n + g.orders.length, 0)) return report;
  return {
    ...report,
    groups,
    totals: { orderCount: orders.length, ...figures(orders), unattributedKg: '0' },
  };
}

/**
 * Ventas por material. Por material: las filas que coinciden, con el subtotal de su tipo y el
 * total recalculados sobre ellas (un tipo sin filas no lleva subtotal). Por producto: los
 * productos que coinciden y su total. Lo no trazable y el cuadre no se buscan en la pantalla.
 */
export function searchSalesByMaterial(
  report: SalesByMaterialDto,
  search: string,
): SalesByMaterialDto {
  if (!searching(search)) return report;
  if (report.products !== null) {
    const rows = filterBySearch(report.products.rows, salesProductRowSearchText, search);
    if (rows.length === report.products.rows.length) return report;
    const t = productTotalsOf(rows);
    return {
      ...report,
      products: {
        ...report.products,
        rows,
        total: {
          salesPen: fixed(t.salesPen),
          costPen: fixed(t.costPen),
          profitPen: fixed(t.profitPen),
        },
      },
    };
  }
  const rows = filterBySearch(report.rows, salesMaterialRowSearchText, search);
  if (rows.length === report.rows.length) return report;
  const kinds = new Set<SalesMaterialKind>(rows.map((r) => r.kind));
  return {
    ...report,
    rows,
    subtotals: report.subtotals
      .filter((s) => kinds.has(s.kind))
      .map((s) => ({ ...s, ...materialFiguresOf(rows.filter((r) => r.kind === s.kind)) })),
    total: materialFiguresOf(rows),
  };
}
