import {
  Decimal,
  productionOrderCode,
  STANDARD_WASTE_PCT,
  toFixedString,
  type CoilKind,
  type CoilWasteLine,
  type CoilStatus,
  type CoilWasteDto,
  type CoilWasteProductionDto,
  type CoilWasteRowDto,
  type MissingTheoreticalReason,
} from '@ayr/shared';

/**
 * cc25 (D-424, D-425, D-429..D-431, D-433). Arma el reporte de merma por bobina sobre lo que el
 * servicio ya leyó del kardex. Función pura: no consulta nada, así que el cuadre con el kardex se
 * prueba sin base.
 *
 * Los movimientos llegan **vivos** (ni anulados ni la anulación de otro, el criterio de D-291) y
 * ya cortados por rango y línea. Nada se escribe: el reporte solo lee.
 */

export interface WasteMovement {
  itemId: string;
  type: 'IN' | 'OUT' | 'ADJUST';
  qty: Decimal;
  refType: 'PRODUCTION' | 'SCRAP' | 'CLOSE_ADJUSTMENT';
  refId: string | null;
  operationDate: string;
}

export interface WasteCoil {
  code: string;
  kind: CoilKind;
  typeKey: string;
  colorName: string | null;
  widthMm: string;
  status: CoilStatus;
}

export interface WasteReport {
  theoreticalKg: Decimal;
  productionOrderId: string;
  orderSeq: number;
  operationDate: string;
}

export interface WasteToleranceOverride {
  label: string;
  excessPct: string;
}

export function assembleCoilWaste(input: {
  from: string;
  to: string;
  businessLine: CoilWasteLine;
  movements: readonly WasteMovement[];
  coils: ReadonlyMap<string, WasteCoil>;
  reports: ReadonlyMap<string, WasteReport>;
  overrides: ReadonlyMap<string, WasteToleranceOverride>;
  /** Bobinas con una venta entera viva (D-424): no entran. */
  soldCoilIds: ReadonlySet<string>;
}): CoilWasteDto {
  const { movements, coils, reports, overrides, soldCoilIds } = input;

  // D-425: entra la bobina con producción en el rango.
  const productionCoilIds = new Set(
    movements.filter((m) => m.refType === 'PRODUCTION').map((m) => m.itemId),
  );

  // Lo que cada reporte sacó en total, de todas sus bobinas: es lo que decide si su teórico se
  // puede atribuir bobina por bobina sin repartir (D-433).
  const outByReport = new Map<string, { total: Decimal; coils: Set<string> }>();
  for (const m of movements) {
    if (m.refType !== 'PRODUCTION' || m.refId === null) continue;
    const acc = outByReport.get(m.refId) ?? { total: new Decimal(0), coils: new Set<string>() };
    acc.total = acc.total.plus(signedOut(m));
    acc.coils.add(m.itemId);
    outByReport.set(m.refId, acc);
  }

  const sold = { count: 0, consumed: new Decimal(0), codes: [] as string[] };
  const rows: CoilWasteRowDto[] = [];
  const totals = {
    consumed: new Decimal(0),
    trim: new Decimal(0),
    closeAdjustment: new Decimal(0),
    manual: new Decimal(0),
    comparableCount: 0,
    comparableConsumed: new Decimal(0),
    theoretical: new Decimal(0),
    difference: new Decimal(0),
    waste: new Decimal(0),
  };

  const byCoil = groupBy(
    movements.filter((m) => productionCoilIds.has(m.itemId)),
    (m) => m.itemId,
  );

  for (const [coilId, coilMovements] of byCoil) {
    const coil = coils.get(coilId);
    const production = coilMovements.filter((m) => m.refType === 'PRODUCTION');
    const consumed = sum(production.map(signedOut));
    if (soldCoilIds.has(coilId) || coil === undefined) {
      // D-424: la bobina vendida entera no entra; se declara.
      sold.count += 1;
      sold.consumed = sold.consumed.plus(consumed);
      sold.codes.push(coil?.code ?? coilId);
      continue;
    }

    // Despunte del cierre de la OP (refId = la orden) y merma manual de RF-17 (refId = la
    // bobina): las dos son `SCRAP`; lo que las separa es a qué apunta.
    const scrap = coilMovements.filter((m) => m.refType === 'SCRAP');
    const trim = sum(scrap.filter((m) => m.refId !== coilId).map(signedOut));
    const manual = sum(scrap.filter((m) => m.refId === coilId).map(signedOut));
    const closeAdjustment = sum(
      coilMovements.filter((m) => m.refType === 'CLOSE_ADJUSTMENT').map(signedOut),
    );

    const productions = productionsOf(production, reports, outByReport, overrides);
    const complete = productions.every((p) => p.theoreticalKg !== null);
    const theoretical = complete
      ? sum(productions.map((p) => new Decimal(p.theoreticalKg ?? '0')))
      : null;
    const difference = theoretical === null ? null : consumed.minus(theoretical);
    const waste = difference === null ? null : difference.plus(trim).plus(closeAdjustment);
    const pct = wastePct(waste, theoretical);

    rows.push({
      coilId,
      code: coil.code,
      kind: coil.kind,
      typeKey: coil.typeKey,
      colorName: coil.colorName,
      widthMm: coil.widthMm,
      status: coil.status,
      consumedKg: kg(consumed),
      theoreticalKg: theoretical === null ? null : kg(theoretical),
      differenceKg: difference === null ? null : kg(difference),
      trimKg: kg(trim),
      closeAdjustmentKg: kg(closeAdjustment),
      wasteKg: waste === null ? null : kg(waste),
      wastePct: pct,
      overStandard: pct !== null && new Decimal(pct).gt(STANDARD_WASTE_PCT),
      manualScrapKg: kg(manual),
      productions,
    });

    totals.consumed = totals.consumed.plus(consumed);
    totals.trim = totals.trim.plus(trim);
    totals.closeAdjustment = totals.closeAdjustment.plus(closeAdjustment);
    totals.manual = totals.manual.plus(manual);
    if (theoretical !== null && difference !== null && waste !== null) {
      totals.comparableCount += 1;
      totals.comparableConsumed = totals.comparableConsumed.plus(consumed);
      totals.theoretical = totals.theoretical.plus(theoretical);
      totals.difference = totals.difference.plus(difference);
      totals.waste = totals.waste.plus(waste);
    }
  }

  rows.sort((a, b) => a.code.localeCompare(b.code));
  sold.codes.sort((a, b) => a.localeCompare(b));

  return {
    from: input.from,
    to: input.to,
    businessLine: input.businessLine,
    standardPct: STANDARD_WASTE_PCT,
    rows,
    totals: {
      coilCount: rows.length,
      consumedKg: kg(totals.consumed),
      trimKg: kg(totals.trim),
      closeAdjustmentKg: kg(totals.closeAdjustment),
      manualScrapKg: kg(totals.manual),
      comparableCoilCount: totals.comparableCount,
      comparableConsumedKg: kg(totals.comparableConsumed),
      theoreticalKg: kg(totals.theoretical),
      differenceKg: kg(totals.difference),
      wasteKg: kg(totals.waste),
      wastePct: wastePct(totals.waste, totals.comparableCount === 0 ? null : totals.theoretical),
    },
    soldWhole: { count: sold.count, consumedKg: kg(sold.consumed), codes: sold.codes },
  };
}

/**
 * Una producción por reporte que sacó de la bobina, con su teórico atribuido (D-433):
 * - el reporte salió de una sola bobina: su teórico entero;
 * - salió de varias y lo que sacó en total es su teórico: lo que sacó de esta, que es
 *   exactamente su parte del teórico (el reparto ya está en el kardex, no se calcula);
 * - si no, no se reparte: se declara.
 */
function productionsOf(
  production: readonly WasteMovement[],
  reports: ReadonlyMap<string, WasteReport>,
  outByReport: ReadonlyMap<string, { total: Decimal; coils: Set<string> }>,
  overrides: ReadonlyMap<string, WasteToleranceOverride>,
): CoilWasteProductionDto[] {
  const byReport = groupBy(production, (m) => m.refId ?? `sin-reporte:${m.operationDate}`);
  const out: CoilWasteProductionDto[] = [];
  for (const [key, ms] of byReport) {
    const consumed = sum(ms.map(signedOut));
    const reportId = ms[0]?.refId ?? null;
    const report = reportId === null ? undefined : reports.get(reportId);
    const operationDate = report?.operationDate ?? ms[0]?.operationDate ?? '';
    let theoretical: Decimal | null = null;
    let missing: MissingTheoreticalReason | null = null;
    if (report === undefined) {
      missing = 'NO_REPORT';
    } else if (report.theoreticalKg.isZero()) {
      missing = 'ZERO_THEORETICAL';
    } else {
      const reportOut = outByReport.get(key);
      if (reportOut === undefined || reportOut.coils.size <= 1) {
        theoretical = report.theoreticalKg;
      } else if (reportOut.total.eq(report.theoreticalKg)) {
        theoretical = consumed;
      } else {
        missing = 'SPLIT_NOT_THEORETICAL';
      }
    }
    out.push({
      reportId: report === undefined ? null : reportId,
      productionOrderId: report?.productionOrderId ?? null,
      productionOrderCode: report === undefined ? null : productionOrderCode(report.orderSeq),
      operationDate,
      consumedKg: kg(consumed),
      theoreticalKg: theoretical === null ? null : kg(theoretical),
      missingTheoretical: missing,
      outOfTolerance: reportId === null ? null : (overrides.get(reportId) ?? null),
    });
  }
  return out.sort(
    (a, b) =>
      a.operationDate.localeCompare(b.operationDate) ||
      (a.productionOrderCode ?? '').localeCompare(b.productionOrderCode ?? ''),
  );
}

/** D-430: merma ÷ teórico, en porcentaje con dos decimales; sin teórico (o cero), `null`. */
function wastePct(waste: Decimal | null, theoretical: Decimal | null): string | null {
  if (waste === null || theoretical === null || theoretical.isZero()) return null;
  return waste.div(theoretical).times(100).toFixed(2);
}

/** Una salida suma y una entrada resta (el ajuste de cierre puede ir en los dos sentidos). */
function signedOut(m: WasteMovement): Decimal {
  if (m.type === 'OUT') return m.qty;
  if (m.type === 'IN') return m.qty.negated();
  return new Decimal(0);
}

function sum(values: readonly Decimal[]): Decimal {
  return values.reduce((acc, v) => acc.plus(v), new Decimal(0));
}

function kg(v: Decimal): string {
  return toFixedString(v, 'KG');
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}
