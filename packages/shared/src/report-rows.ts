import { z } from 'zod';
import {
  BUSINESS_LINE_LABELS,
  COIL_STATUS_LABELS,
  coilStateLabel,
  type CoilFilmState,
} from './enums';
import { Decimal, toDecimal } from './decimal';
import {
  coilGroupLabel,
  type CoilMonthReportRowDto,
  type InventoryValuationCoilGroupDto,
  type InventoryValuationProductDto,
  type MarginCostStatus,
  type SalesMarginOrderDto,
} from './schemas/report';
import type { CoilWasteRowDto } from './schemas/coil-waste';
import type {
  ProductionSummaryGroupDto,
  ProductionSummaryOrderDto,
} from './schemas/production-summary';
import {
  AGING_BUCKETS,
  type AgingBucket,
  type ReceivablesAgingCustomerDto,
} from './schemas/receivables-aging';
import {
  SALES_MATERIAL_KIND_LABELS,
  type SalesMaterialFiguresDto,
  type SalesMaterialRowDto,
  type SalesProductRowDto,
} from './schemas/sales-by-material';

/**
 * cc40 — **la búsqueda y el total al pie de los reportes, en un solo lugar.** La pantalla filtra
 * las filas en el navegador y suma el pie sobre las que quedan; el Excel, desde cc40, recibe la
 * misma búsqueda y tiene que traer las mismas filas con el mismo total. Por eso qué mira el
 * buscador de cada reporte y cómo se suma el pie viven aquí, y la web y el API los importan: dos
 * copias son cómo el archivo y la pantalla terminan diciendo cosas distintas.
 *
 * Las sumas son exactas (`Decimal`) y se redondean solo al mostrarlas.
 */

/* --------------------------------------------------------------------- Búsqueda */

/**
 * cc40: la búsqueda de la pantalla, en la URL del Excel. Se valida aparte del filtro del reporte
 * (que no cambia) y solo la usan las rutas de Excel: la consulta JSON trae siempre todas las filas.
 */
export const reportXlsxSearchSchema = z.object({
  search: z.string().max(200).optional(),
});
export type ReportXlsxSearch = z.infer<typeof reportXlsxSearchSchema>;

/** cc40: el reporte de producción busca distinto por orden que por pedido («Ver por»). */
export const PRODUCTION_VIEWS = ['orden', 'pedido'] as const;
export type ProductionView = (typeof PRODUCTION_VIEWS)[number];
export const productionXlsxSearchSchema = reportXlsxSearchSchema.extend({
  ver: z.enum(PRODUCTION_VIEWS).optional(),
});
export type ProductionXlsxSearch = z.infer<typeof productionXlsxSearchSchema>;

/** Sin tildes ni mayúsculas, para que «alamos» encuentre «Álamos» (como `normalize` de «Ir a»). */
export function normalizeSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/** Las palabras de una búsqueda; vacía = sin búsqueda. */
export function searchWords(search: string): string[] {
  return normalizeSearch(search).split(/\s+/).filter(Boolean);
}

/** Si el texto buscable de una fila contiene **cada** palabra de la búsqueda. */
export function matchesSearch(parts: readonly string[], search: string): boolean {
  const words = searchWords(search);
  if (words.length === 0) return true;
  const haystack = normalizeSearch(parts.join(' '));
  return words.every((w) => haystack.includes(w));
}

/** Las filas que coinciden con la búsqueda, en su orden. */
export function filterBySearch<T>(
  rows: readonly T[],
  textOf: (row: T) => readonly string[],
  search: string,
): T[] {
  if (searchWords(search).length === 0) return [...rows];
  return rows.filter((row) => matchesSearch(textOf(row), search));
}

/* ------------------------------------------------- Lo que mira el buscador de cada reporte */

/** Reporte mensual de bobinas (Selladas y Abiertas): código, tipo, color, acabado y estado. */
export function coilMonthRowSearchText(row: CoilMonthReportRowDto, film: CoilFilmState): string[] {
  return [
    row.code,
    row.typeKey,
    row.colorName ?? '',
    row.finishName,
    coilStateLabel({ status: row.status, film }),
  ];
}

/** Cuentas por cobrar: el cliente, su documento y, de sus comprobantes, número, pedido y vendedor. */
export function receivablesCustomerSearchText(customer: ReceivablesAgingCustomerDto): string[] {
  return [
    customer.customerName,
    customer.customerDocNumber,
    ...customer.documents.flatMap((d) => [
      d.number ?? '',
      d.salesOrderCode ?? '',
      d.sellerName ?? '',
    ]),
  ];
}

/** Inventario valorizado, grupo de bobinas: la línea, el color, sus acabados y sus bobinas. */
export function inventoryCoilGroupSearchText(group: InventoryValuationCoilGroupDto): string[] {
  return [
    BUSINESS_LINE_LABELS[group.businessLine],
    coilGroupLabel(group),
    ...group.finishes.flatMap((f) => [f.finishName, f.finishCode, f.ral ?? '']),
    ...group.coils.map((c) => c.code),
  ];
}

/** Inventario valorizado, producto: SKU, descripción y línea. */
export function inventoryProductSearchText(product: InventoryValuationProductDto): string[] {
  return [product.sku, product.name, BUSINESS_LINE_LABELS[product.businessLine]];
}

/** Merma por bobina: la bobina, su tipo, color y acabado, sus órdenes y el estado. */
export function coilWasteRowSearchText(row: CoilWasteRowDto): string[] {
  return [
    row.code,
    row.typeKey,
    row.colorName ?? '',
    row.finishName,
    ...row.productions.map((p) => p.productionOrderCode ?? ''),
    COIL_STATUS_LABELS[row.status],
  ];
}

/** Lo que dice la pantalla de una orden o un grupo sin pedido (corridas a stock). */
export const PRODUCTION_NO_ORDER_LABEL = 'Sin pedido (a stock)';

/** Reporte de producción, «Ver por» Orden: la OP, sus bobinas, el pedido y el producto. */
export function productionOrderSearchText(order: ProductionSummaryOrderDto): string[] {
  return [
    order.code,
    ...order.coils.map((c) => c.code),
    order.salesOrderCode ?? PRODUCTION_NO_ORDER_LABEL,
    order.productSku,
    order.productName,
  ];
}

/** Reporte de producción, «Ver por» Pedido: el pedido y, de sus órdenes, código y producto. */
export function productionGroupSearchText(group: ProductionSummaryGroupDto): string[] {
  return [
    group.salesOrderCode ?? PRODUCTION_NO_ORDER_LABEL,
    ...group.orders.flatMap((o) => [o.code, o.productSku, o.productName]),
  ];
}

/** El estado del costo de un pedido en «Ventas y margen», como lo muestra la pantalla. */
export const MARGIN_COST_STATUS_LABELS: Record<MarginCostStatus, string> = {
  COMPLETO: 'Completo',
  PARCIAL: 'Costo parcial',
  NO_COMPARABLE: 'No comparable',
  NO_RASTREABLE: 'Costo no rastreable',
};

/**
 * Ventas y margen: el pedido, sus comprobantes, el cliente, el vendedor y el estado del costo. Es
 * el mismo en la vista por pedido y en «Ver por» (que filtra antes de agrupar).
 */
export function salesMarginSearchText(order: SalesMarginOrderDto): string[] {
  return [
    order.orderCode ?? '',
    ...order.documents.map((d) => d.number ?? ''),
    order.customerName,
    order.sellerName ?? '',
    MARGIN_COST_STATUS_LABELS[order.costStatus],
  ];
}

/** Ventas por material: tipo, espesor (con y sin «mm»), color y las bobinas de la fila. */
export function salesMaterialRowSearchText(row: SalesMaterialRowDto): string[] {
  return [
    SALES_MATERIAL_KIND_LABELS[row.kind],
    row.thicknessMm,
    `${row.thicknessMm} mm`,
    row.colorLabel,
    ...row.coils.map((c) => c.code),
  ];
}

/** Ventas por producto (Coberturas UPVC, Reventa): SKU y nombre. */
export function salesProductRowSearchText(row: SalesProductRowDto): string[] {
  return [row.sku, row.name];
}

/* ------------------------------------------------------------------- Totales al pie */

/** La suma exacta de una columna; un valor `null` (sin dato) no suma. */
export function sumDecimal<T>(rows: readonly T[], value: (row: T) => string | null): Decimal {
  let total = new Decimal(0);
  for (const row of rows) {
    const v = value(row);
    if (v !== null) total = total.plus(toDecimal(v));
  }
  return total;
}

/**
 * Margen sobre venta (§7) en puntos, con dos decimales como el API, o `null` sin base positiva
 * (el mismo criterio del API: con base cero o negativa el porcentaje se calla).
 */
export function marginPctOf(sales: Decimal, margin: Decimal): string | null {
  if (sales.lte(0)) return null;
  return margin.div(sales).times(100).toFixed(2);
}

/** Lo que suman unas filas de «Ventas y margen»: el pie de la tabla, cada grupo y el Excel. */
export interface SalesMarginSummary {
  /** Filas sumadas. */
  count: number;
  /** Filas con pedido. */
  orderCount: number;
  /** Filas sin pedido: ventas directas, que se agrupan solas (D-518). */
  directSaleCount: number;
  /** La venta de las filas: la del pedido, una vez; sus comprobantes ya están dentro. */
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
export function salesMarginCountLabel(
  summary: Pick<SalesMarginSummary, 'orderCount' | 'directSaleCount'>,
): string {
  const orders = plural(summary.orderCount, 'pedido', 'pedidos');
  return summary.directSaleCount === 0
    ? orders
    : `${orders} · ${plural(summary.directSaleCount, 'venta sin pedido', 'ventas sin pedido')}`;
}

/** Un cociente que solo existe con divisor distinto de 0 (`per` del API). */
function per(value: Decimal, divisor: Decimal): string | null {
  return divisor.isZero() ? null : value.div(divisor).toFixed();
}

/**
 * Ventas por material: las cifras de un conjunto de filas, como `figures()` del API
 * (`sales-by-material.ts`). Los cocientes salen de las sumas, nunca de promediar cocientes.
 */
export function materialFiguresOf(
  rows: readonly SalesMaterialFiguresDto[],
): SalesMaterialFiguresDto {
  const meters = sumDecimal(rows, (r) => r.metersSold);
  const theoretical = sumDecimal(rows, (r) => r.theoreticalKg);
  const real = sumDecimal(rows, (r) => r.realKg);
  const sales = sumDecimal(rows, (r) => r.salesPen);
  const cost = sumDecimal(rows, (r) => r.costPen);
  const yieldKg = theoretical.minus(real);
  const hasReal = !real.isZero();
  const costPerKg = hasReal ? cost.div(real) : null;
  const pricePerKg = hasReal ? sales.div(real) : null;
  // Una fila sin unidad ya mezcla unidades; dos filas con unidades distintas, también.
  const units = new Set(rows.map((r) => r.unit));
  const unit = units.size === 1 ? (rows[0]?.unit ?? null) : null;
  const qty = unit === null ? null : sumDecimal(rows, (r) => r.qty);
  return {
    metersSold: meters.toFixed(),
    theoreticalKg: theoretical.toFixed(),
    realKg: real.toFixed(),
    yieldKg: yieldKg.toFixed(),
    yieldPct: theoretical.isZero() ? null : yieldKg.div(theoretical).times(100).toFixed(2),
    salesPen: sales.toFixed(),
    costPen: cost.toFixed(),
    profitPen: sales.minus(cost).toFixed(),
    costPerKgPen: costPerKg === null ? null : costPerKg.toFixed(),
    pricePerKgPen: pricePerKg === null ? null : pricePerKg.toFixed(),
    marginPerKgPen:
      costPerKg === null || pricePerKg === null ? null : pricePerKg.minus(costPerKg).toFixed(),
    pricePerMeterPen: per(sales, meters),
    costPerMeterPen: per(cost, meters),
    marginPerMeterPen: per(sales.minus(cost), meters),
    unit,
    qty: qty === null ? null : qty.toFixed(),
    costPerUnitPen: qty === null ? null : per(cost, qty),
  };
}

/** Ventas por producto: venta, costo y utilidad de unas filas. */
export function productTotalsOf(rows: readonly SalesProductRowDto[]): {
  salesPen: Decimal;
  costPen: Decimal;
  profitPen: Decimal;
} {
  return {
    salesPen: sumDecimal(rows, (r) => r.salesPen),
    costPen: sumDecimal(rows, (r) => r.costPen),
    profitPen: sumDecimal(rows, (r) => r.profitPen),
  };
}

/** D-434: pasa la tolerancia sobre el estándar (`overStandard` del API). */
function over(pct: string | null, standardPct: string): boolean {
  return pct !== null && toDecimal(pct).gt(toDecimal(standardPct));
}

export interface WasteTotals {
  coilCount: number;
  consumedKg: Decimal;
  trimKg: Decimal;
  closeAdjustmentKg: Decimal;
  manualScrapKg: Decimal;
  comparableCoilCount: number;
  comparableConsumedKg: Decimal;
  theoreticalKg: Decimal;
  differenceKg: Decimal;
  wasteKg: Decimal;
  wastePct: string | null;
  overStandard: boolean;
}

/**
 * Merma por bobina: los totales de unas bobinas, como el API (`coil-waste.ts`). El teórico, la
 * diferencia y la merma son solo de las bobinas con teórico completo: sumar el de una incompleta
 * sería estimar la parte que falta.
 */
export function wasteTotalsOf(rows: readonly CoilWasteRowDto[], standardPct: string): WasteTotals {
  const comparable = rows.filter((r) => r.theoreticalKg !== null);
  const theoretical = sumDecimal(comparable, (r) => r.theoreticalKg);
  const waste = sumDecimal(comparable, (r) => r.wasteKg);
  const pct =
    comparable.length === 0 || theoretical.isZero()
      ? null
      : waste.div(theoretical).times(100).toFixed(2);
  return {
    coilCount: rows.length,
    consumedKg: sumDecimal(rows, (r) => r.consumedKg),
    trimKg: sumDecimal(rows, (r) => r.trimKg),
    closeAdjustmentKg: sumDecimal(rows, (r) => r.closeAdjustmentKg),
    manualScrapKg: sumDecimal(rows, (r) => r.manualScrapKg),
    comparableCoilCount: comparable.length,
    comparableConsumedKg: sumDecimal(comparable, (r) => r.consumedKg),
    theoreticalKg: theoretical,
    differenceKg: sumDecimal(comparable, (r) => r.differenceKg),
    wasteKg: waste,
    wastePct: pct,
    overStandard: over(pct, standardPct),
  };
}

export interface ProductionTotals {
  theoreticalKg: Decimal;
  consumedKg: Decimal;
  trimKg: Decimal;
  wastePct: string | null;
  overStandard: boolean;
  /** `null` para quien no ve costos. */
  materialCostPen: Decimal | null;
  trimCostPen: Decimal | null;
}

/**
 * Reporte de producción: las cifras de unas órdenes, como `figuresDto` del API
 * (`production-summary.ts`): % = (salido − teórico + despunte) ÷ teórico.
 */
export function productionTotalsOf(
  rows: readonly Pick<
    ProductionSummaryOrderDto,
    'theoreticalKg' | 'consumedKg' | 'trimKg' | 'materialCostPen' | 'trimCostPen'
  >[],
  standardPct: string,
): ProductionTotals {
  const theoretical = sumDecimal(rows, (r) => r.theoreticalKg);
  const consumed = sumDecimal(rows, (r) => r.consumedKg);
  const trim = sumDecimal(rows, (r) => r.trimKg);
  const pct = theoretical.isZero()
    ? null
    : consumed.minus(theoretical).plus(trim).div(theoretical).times(100).toFixed(2);
  const withCosts = rows.every((r) => r.materialCostPen !== null);
  return {
    theoreticalKg: theoretical,
    consumedKg: consumed,
    trimKg: trim,
    wastePct: pct,
    overStandard: over(pct, standardPct),
    materialCostPen: withCosts ? sumDecimal(rows, (r) => r.materialCostPen) : null,
    trimCostPen: withCosts ? sumDecimal(rows, (r) => r.trimCostPen) : null,
  };
}

/** Cuentas por cobrar: el saldo de cada tramo, los comprobantes y el saldo de unos clientes. */
export function agingTotalsOf(rows: readonly ReceivablesAgingCustomerDto[]): {
  documentCount: number;
  balancePen: Decimal;
  buckets: Record<AgingBucket, Decimal>;
} {
  const buckets = Object.fromEntries(
    AGING_BUCKETS.map((b) => [b, sumDecimal(rows, (r) => r.buckets[b])]),
  ) as Record<AgingBucket, Decimal>;
  return {
    documentCount: rows.reduce((n, r) => n + r.documentCount, 0),
    balancePen: sumDecimal(rows, (r) => r.balancePen),
    buckets,
  };
}

/** Reporte mensual de bobinas: el subtotal de unas bobinas (kilos y, si se ven, valor). */
export function coilMonthTotalsOf(rows: readonly CoilMonthReportRowDto[]): {
  openingKg: Decimal;
  weightKg: Decimal;
  closingKg: Decimal;
  closingValuePen: Decimal | null;
} {
  const withCosts = rows.every((r) => r.closingValuePen !== null);
  return {
    openingKg: sumDecimal(rows, (r) => r.openingKg),
    weightKg: sumDecimal(rows, (r) => r.weightKg),
    closingKg: sumDecimal(rows, (r) => r.closingKg),
    closingValuePen: withCosts ? sumDecimal(rows, (r) => r.closingValuePen) : null,
  };
}

/* ------------------------------------------------- «Ver por» de Ventas y margen */

/** Nombre del grupo sin vendedor (una venta directa de mostrador puede no tenerlo). */
export const NO_SELLER_LABEL = 'Sin vendedor';

export interface SalesMarginGroup extends SalesMarginSummary {
  /** El id del vendedor o del cliente; `''` es el grupo sin vendedor. */
  key: string;
  /** El vendedor o el cliente, como se ve en la tabla. */
  label: string;
  /** cc40: el RUC/DNI del cliente, para enlazar a su ficha (D-172); `null` por vendedor. */
  customerDocNumber: string | null;
  orders: SalesMarginOrderDto[];
}

/**
 * cc40 (D-586): agrupa por vendedor o por cliente **por su id** (`sellerId`, `customerId`,
 * D-581), no por el nombre: dos clientes que se llaman igual son dos grupos. Los grupos salen en
 * el orden en que aparece su primera fila; la suma de los grupos es la suma de las filas.
 */
export function groupSalesMargin(
  orders: readonly SalesMarginOrderDto[],
  by: 'vendedor' | 'cliente',
): SalesMarginGroup[] {
  const buckets = new Map<
    string,
    { label: string; customerDocNumber: string | null; orders: SalesMarginOrderDto[] }
  >();
  for (const order of orders) {
    const key = by === 'vendedor' ? (order.sellerId ?? '') : order.customerId;
    const bucket = buckets.get(key);
    if (bucket) bucket.orders.push(order);
    else
      buckets.set(key, {
        label: by === 'vendedor' ? (order.sellerName ?? NO_SELLER_LABEL) : order.customerName,
        customerDocNumber: by === 'cliente' ? order.customerDocNumber : null,
        orders: [order],
      });
  }
  return [...buckets.entries()].map(([key, b]) => ({
    key,
    label: b.label,
    customerDocNumber: b.customerDocNumber,
    orders: b.orders,
    ...summarizeSalesMargin(b.orders),
  }));
}
