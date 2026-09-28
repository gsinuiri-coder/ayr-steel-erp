import {
  Decimal,
  FINISH_KIND_LABELS,
  kgPerMeter,
  salesOrderCode,
  toDecimal,
  toFixedString,
  type FinishKind,
  type SalesByMaterialDto,
  type SalesByMaterialQuery,
  type SalesMaterialCoilDto,
  type SalesMaterialFiguresDto,
  type SalesMaterialKind,
  type SalesMaterialRowDto,
  type SalesMaterialUntraceableDto,
  type SalesMaterialUntraceableReason,
  SALES_MATERIAL_KINDS,
} from '@ayr/shared';

/**
 * D-354 — armado de «Ventas por material». Sin consultas: todo lo que sigue es aritmética
 * sobre las cuatro lecturas de `SalesByMaterialService`, y por eso se prueba sin base.
 */

/** Geometría de lo que se convierte a kilos: ancho, espesor y densidad del acabado. */
export interface Geometry {
  widthMm: string | null;
  thicknessMm: string | null;
  densityFactor: string | null;
}

/** Una línea de comprobante del rango (consulta 1), ya con su signo (una NC resta). */
export interface InvoiceLine {
  documentId: string;
  documentNumber: string | null;
  issueDate: string;
  orderSeq: number | null;
  salesOrderItemId: string | null;
  sku: string;
  /** `null` = producto de la línea sin subtipo: cuenta en el cuadre y no en las filas. */
  kind: SalesMaterialKind | null;
  /** Unidad de venta del producto (`MTR`, `NIU`, `KGM`). */
  unit: string;
  /** Cantidad en la unidad de venta, con signo. */
  qty: string;
  /** Sin IGV, con signo. */
  salesPen: string;
  /** Largo del SKU de una plancha, en mm. */
  lengthMm: string | null;
  /** Geometría del producto; en una bobina entera, la de la bobina. */
  geometry: Geometry;
  thicknessMm: string;
  colorLabel: string;
}

/** Lo que dice cada línea de pedido de sí misma (consultas 2 y 3). */
export interface OrderLineFacts {
  /** Facturado neto de toda la vida de la línea, en unidad de venta. */
  invoicedQty: string;
  /** Producido neto por sus OP, en unidad de venta (reportes revertidos restados). */
  producedQty: string;
  /** OP no anuladas de la línea. */
  orderCount: number;
  /** Despachado neto (despachos vigentes), en unidad de venta. */
  dispatchedQty: string;
}

/** Kilos y costo netos de una bobina para una línea de pedido (consulta 4). */
export interface CoilUsage {
  salesOrderItemId: string;
  coilId: string;
  code: string;
  thicknessMm: string;
  colorLabel: string;
  kg: string;
  costPen: string;
}

export interface AssembleInput {
  query: SalesByMaterialQuery;
  lines: InvoiceLine[];
  facts: Map<string, OrderLineFacts>;
  usage: CoilUsage[];
}

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

/** Etiqueta de color de una fila: el color comercial, o el tipo de acabado si no lleva color. */
export function colorLabelOf(colorName: string | null, finishKind: FinishKind | null): string {
  if (colorName !== null) return colorName;
  return finishKind === null ? 'Sin color' : FINISH_KIND_LABELS[finishKind];
}

/**
 * Metros lineales de una cantidad vendida, **según la unidad de venta** y no según el subtipo
 * (regla dura 13: «por metro» es una pregunta por la unidad). `null` cuando la unidad no tiene
 * conversión a metros —una plancha vendida en kilos, una en piezas sin largo en el SKU, una
 * bobina sin geometría—: esa línea va a «No trazable» en vez de sumar un cero que parece dato.
 */
export function metersOf(
  line: Pick<InvoiceLine, 'kind' | 'unit' | 'qty' | 'lengthMm' | 'geometry'>,
): Decimal | null {
  const qty = toDecimal(line.qty);
  if (line.kind === 'BOBINA') {
    // Bobina entera: se vende en kilos; su ML es el teórico de esos kilos con su geometría.
    const perMeter = kgPerMeterOf(line.geometry);
    return perMeter === null ? null : qty.div(perMeter);
  }
  if (line.unit === 'MTR') return qty;
  if (line.unit === 'NIU' && line.lengthMm !== null) {
    return qty.times(toDecimal(line.lengthMm)).div(1000);
  }
  return null;
}

function kgPerMeterOf(g: Geometry): Decimal | null {
  if (g.widthMm === null || g.thicknessMm === null || g.densityFactor === null) return null;
  const value = kgPerMeter({
    widthMm: g.widthMm,
    thicknessMm: g.thicknessMm,
    densityFactor: g.densityFactor,
  });
  return value.isZero() ? null : value;
}

interface Accumulator {
  meters: Decimal;
  theoreticalKg: Decimal;
  realKg: Decimal;
  sales: Decimal;
  cost: Decimal;
}

const emptyAcc = (): Accumulator => ({
  meters: ZERO,
  theoreticalKg: ZERO,
  realKg: ZERO,
  sales: ZERO,
  cost: ZERO,
});

function addAcc(into: Accumulator, from: Accumulator): void {
  into.meters = into.meters.plus(from.meters);
  into.theoreticalKg = into.theoreticalKg.plus(from.theoreticalKg);
  into.realKg = into.realKg.plus(from.realKg);
  into.sales = into.sales.plus(from.sales);
  into.cost = into.cost.plus(from.cost);
}

export function figures(acc: Accumulator): SalesMaterialFiguresDto {
  const yieldKg = acc.theoreticalKg.minus(acc.realKg);
  const hasReal = !acc.realKg.isZero();
  const costPerKg = hasReal ? acc.cost.div(acc.realKg) : null;
  const pricePerKg = hasReal ? acc.sales.div(acc.realKg) : null;
  return {
    metersSold: toFixedString(acc.meters, 'KG'),
    theoreticalKg: toFixedString(acc.theoreticalKg, 'KG'),
    realKg: toFixedString(acc.realKg, 'KG'),
    yieldKg: toFixedString(yieldKg, 'KG'),
    yieldPct: acc.theoreticalKg.isZero()
      ? null
      : yieldKg.div(acc.theoreticalKg).times(100).toFixed(2),
    salesPen: toFixedString(acc.sales, 'MONEY'),
    costPen: toFixedString(acc.cost, 'MONEY'),
    profitPen: toFixedString(acc.sales.minus(acc.cost), 'MONEY'),
    costPerKgPen: costPerKg === null ? null : toFixedString(costPerKg, 'MONEY'),
    pricePerKgPen: pricePerKg === null ? null : toFixedString(pricePerKg, 'MONEY'),
    marginPerKgPen:
      costPerKg === null || pricePerKg === null
        ? null
        : toFixedString(pricePerKg.minus(costPerKg), 'MONEY'),
  };
}

/**
 * Qué parte de una línea facturada se puede trazar, y por qué no el resto.
 *
 * La base es lo que la línea **produjo** (o, en una bobina entera, lo que **despachó**): el
 * material que consumió esa producción es el de toda la base, así que a lo facturado le toca
 * `facturado ÷ base` de ese consumo. Si se facturó más de lo que hay de base, solo
 * `base ÷ facturado total` de cada comprobante se traza —la misma fracción en todos, sin orden
 * de llegada— y el resto es «producción parcial». Así la suma de todos los meses de una línea es
 * exactamente su consumo cuando lo facturado cubre lo producido, y nunca lo supera.
 */
export function traceFraction(
  kind: SalesMaterialKind,
  facts: OrderLineFacts | undefined,
  baseQty: Decimal,
): { fraction: Decimal; reason: SalesMaterialUntraceableReason | null } {
  if (baseQty.lte(0)) {
    if (kind === 'BOBINA') return { fraction: ZERO, reason: 'SIN_DESPACHO' };
    const dispatched = facts === undefined ? ZERO : toDecimal(facts.dispatchedQty);
    const stock = facts?.orderCount === 0 && dispatched.gt(0);
    return { fraction: ZERO, reason: stock ? 'DESDE_STOCK' : 'SIN_PRODUCCION' };
  }
  const invoiced = facts === undefined ? ZERO : toDecimal(facts.invoicedQty);
  if (invoiced.gt(baseQty)) {
    return {
      fraction: baseQty.div(invoiced),
      reason: kind === 'BOBINA' ? 'SIN_DESPACHO' : 'PRODUCCION_PARCIAL',
    };
  }
  return { fraction: ONE, reason: null };
}

export function assembleSalesByMaterial(input: AssembleInput): SalesByMaterialDto {
  const { query, lines, facts, usage } = input;

  const usageByLine = new Map<string, CoilUsage[]>();
  for (const u of usage) {
    const found = usageByLine.get(u.salesOrderItemId) ?? [];
    found.push(u);
    usageByLine.set(u.salesOrderItemId, found);
  }

  // El cuadre se calcula antes de filtrar: responde a «Ventas y margen», que no filtra.
  let roofingSales = ZERO;
  let coilSales = ZERO;
  let unclassifiedSales = ZERO;
  for (const line of lines) {
    const sales = toDecimal(line.salesPen);
    if (line.kind === 'BOBINA') coilSales = coilSales.plus(sales);
    else roofingSales = roofingSales.plus(sales);
    if (line.kind === null) unclassifiedSales = unclassifiedSales.plus(sales);
  }

  const visible = lines.filter(
    (l): l is InvoiceLine & { kind: SalesMaterialKind } =>
      l.kind !== null &&
      (query.kind === undefined || l.kind === query.kind) &&
      (query.thicknessMm === undefined ||
        toDecimal(l.thicknessMm).equals(toDecimal(query.thicknessMm))) &&
      (query.color === undefined ||
        l.colorLabel.localeCompare(query.color, 'es', { sensitivity: 'base' }) === 0),
  );

  interface RowState {
    kind: SalesMaterialKind;
    thicknessMm: string;
    colorLabel: string;
    acc: Accumulator;
    lineCount: number;
    coils: Map<
      string,
      { dto: Omit<SalesMaterialCoilDto, 'kg' | 'costPen'>; kg: Decimal; cost: Decimal }
    >;
  }
  const rows = new Map<string, RowState>();
  const untraceable: SalesMaterialUntraceableDto[] = [];
  let untraceableSales = ZERO;

  for (const line of visible) {
    const convertible = metersOf(line);
    const meters = convertible ?? ZERO;
    const perMeter = kgPerMeterOf(line.geometry);
    // En una bobina entera el teórico son sus propios kilos: su ML se sacó de ellos.
    const theoretical =
      line.kind === 'BOBINA'
        ? toDecimal(line.qty)
        : perMeter === null
          ? ZERO
          : meters.times(perMeter);
    const sales = toDecimal(line.salesPen);

    const pushUntraceable = (reason: SalesMaterialUntraceableReason, share: Decimal): void => {
      const part = sales.times(share);
      untraceableSales = untraceableSales.plus(part);
      untraceable.push({
        kind: line.kind,
        thicknessMm: line.thicknessMm,
        colorLabel: line.colorLabel,
        reason,
        documentId: line.documentId,
        documentNumber: line.documentNumber,
        issueDate: line.issueDate,
        orderCode: line.orderSeq === null ? null : salesOrderCode(line.orderSeq),
        sku: line.sku,
        metersSold: toFixedString(meters.times(share), 'KG'),
        salesPen: toFixedString(part, 'MONEY'),
      });
    };

    // Sin metros no hay ML, teórico ni una base de producción en la misma unidad: se declara.
    if (convertible === null) {
      pushUntraceable('SIN_METRO', ONE);
      continue;
    }
    if (line.salesOrderItemId === null) {
      pushUntraceable('SIN_PEDIDO', ONE);
      continue;
    }
    const lineFacts = facts.get(line.salesOrderItemId);
    const lineUsage = usageByLine.get(line.salesOrderItemId) ?? [];
    // Base del prorrateo: lo producido; en una bobina entera, los kilos que salieron de ella.
    const baseQty =
      line.kind === 'BOBINA'
        ? lineUsage.reduce((acc, u) => acc.plus(toDecimal(u.kg)), ZERO)
        : lineFacts === undefined
          ? ZERO
          : toDecimal(lineFacts.producedQty);

    const { fraction, reason } = traceFraction(line.kind, lineFacts, baseQty);
    if (reason !== null) pushUntraceable(reason, ONE.minus(fraction));
    if (fraction.isZero()) continue;

    // Parte de la base que le toca a esta línea del comprobante.
    const share = toDecimal(line.qty).times(fraction).div(baseQty);
    const key = `${line.kind}|${toDecimal(line.thicknessMm).toFixed(2)}|${line.colorLabel}`;
    const row: RowState = rows.get(key) ?? {
      kind: line.kind,
      thicknessMm: toDecimal(line.thicknessMm).toFixed(2),
      colorLabel: line.colorLabel,
      acc: emptyAcc(),
      lineCount: 0,
      coils: new Map(),
    };
    row.lineCount += 1;
    const acc: Accumulator = {
      meters: meters.times(fraction),
      theoreticalKg: theoretical.times(fraction),
      realKg: ZERO,
      sales: sales.times(fraction),
      cost: ZERO,
    };
    for (const u of lineUsage) {
      const kg = toDecimal(u.kg).times(share);
      const cost = toDecimal(u.costPen).times(share);
      acc.realKg = acc.realKg.plus(kg);
      acc.cost = acc.cost.plus(cost);
      const coil = row.coils.get(u.coilId) ?? {
        dto: {
          coilId: u.coilId,
          code: u.code,
          thicknessMm: u.thicknessMm,
          colorLabel: u.colorLabel,
        },
        kg: ZERO,
        cost: ZERO,
      };
      coil.kg = coil.kg.plus(kg);
      coil.cost = coil.cost.plus(cost);
      row.coils.set(u.coilId, coil);
    }
    addAcc(row.acc, acc);
    rows.set(key, row);
  }

  const kindOrder = (k: SalesMaterialKind): number => SALES_MATERIAL_KINDS.indexOf(k);
  const sorted = [...rows.values()].sort(
    (a, b) =>
      kindOrder(a.kind) - kindOrder(b.kind) ||
      toDecimal(a.thicknessMm).comparedTo(toDecimal(b.thicknessMm)) ||
      a.colorLabel.localeCompare(b.colorLabel, 'es'),
  );

  const subtotalAcc = new Map<SalesMaterialKind, Accumulator>();
  const totalAcc = emptyAcc();
  const rowDtos: SalesMaterialRowDto[] = sorted.map((r) => {
    const sub = subtotalAcc.get(r.kind) ?? emptyAcc();
    addAcc(sub, r.acc);
    subtotalAcc.set(r.kind, sub);
    addAcc(totalAcc, r.acc);
    return {
      kind: r.kind,
      thicknessMm: r.thicknessMm,
      colorLabel: r.colorLabel,
      lineCount: r.lineCount,
      ...figures(r.acc),
      coils: [...r.coils.values()]
        .sort((a, b) => a.dto.code.localeCompare(b.dto.code))
        .map((c) => ({
          ...c.dto,
          kg: toFixedString(c.kg, 'KG'),
          costPen: toFixedString(c.cost, 'MONEY'),
        })),
    };
  });

  return {
    from: query.from,
    to: query.to,
    rows: rowDtos,
    subtotals: SALES_MATERIAL_KINDS.filter((k) => subtotalAcc.has(k)).map((kind) => ({
      kind,
      ...figures(subtotalAcc.get(kind) ?? emptyAcc()),
    })),
    total: figures(totalAcc),
    untraceable: untraceable.sort(
      (a, b) =>
        a.issueDate.localeCompare(b.issueDate) ||
        (a.documentNumber ?? '').localeCompare(b.documentNumber ?? ''),
    ),
    untraceableSalesPen: toFixedString(untraceableSales, 'MONEY'),
    reconciliation: {
      roofingSalesPen: toFixedString(roofingSales, 'MONEY'),
      coilSalesPen: toFixedString(coilSales, 'MONEY'),
      unclassifiedSalesPen: toFixedString(unclassifiedSales, 'MONEY'),
    },
  };
}
