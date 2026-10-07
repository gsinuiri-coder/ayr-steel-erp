import {
  AGING_BUCKETS,
  toDecimal,
  type AgingBucket,
  type CoilMonthReportRowDto,
  type CoilWasteRowDto,
  type Decimal,
  type ProductionSummaryOrderDto,
  type ReceivablesAgingCustomerDto,
  type SalesMaterialFiguresDto,
} from '@ayr/shared';
import { sumDecimal } from './report-table';

/**
 * cc32 (corte 2): el total al pie de las tablas de los reportes, sobre las filas **a la vista**
 * (con la búsqueda aplicada). Las cuentas son las mismas que hace el API para su total, con los
 * valores completos (`Decimal`) y sin redondear: el redondeo es solo al mostrarlas.
 *
 * Sin búsqueda, cada vista muestra el total que ya trae el API (`allRows`): las filas llegan
 * redondeadas a su escala y sumarlas puede correr un milésimo contra el total, que el API suma
 * sin redondear. Estas funciones son para cuando la búsqueda deja una parte de las filas.
 */

/** Las filas a la vista son todas las del reporte: no hay búsqueda que las recorte. */
export function allRows(visible: readonly unknown[], all: readonly unknown[]): boolean {
  return visible.length === all.length;
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
