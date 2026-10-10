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
  type SalesByMaterialLine,
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
  /** cc40 (D-589): el pedido del comprobante, para enlazarlo desde «No trazable». */
  orderId: string | null;
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
  /** Largo del SKU de una plancha o un perfil, en mm. */
  lengthMm: string | null;
  /**
   * cc24 (D-414): kilos por pieza del perfil de Drywall (`products.piece_weight_kg`, D-139). Es
   * su peso teórico, porque Drywall no rola metros. `null` en lo demás.
   */
  pieceWeightKg: string | null;
  /** Geometría del producto; en una bobina entera, la de la bobina. */
  geometry: Geometry;
  thicknessMm: string;
  colorLabel: string;
  /** Razón social del cliente del comprobante (nivel 2 del desglose, D-370). */
  customerName: string;
  /** cc39 (D-581): su id. */
  customerId: string;
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
  typeKey: string;
  /** cc39 (D-582): el nombre del acabado de la bobina. */
  finishName: string;
  thicknessMm: string;
  colorLabel: string;
  kg: string;
  costPen: string;
  /** Geometría de **la bobina** (D-369): ancho y densidad cruda de su acabado. */
  widthMm: string;
  densityFactor: string;
  /**
   * Metros lineales que los reportes vigentes de la línea rolaron de esta bobina (cada reporte
   * de coberturas sale de un solo rollo). `0` en una bobina vendida entera o si solo aportó
   * despunte.
   */
  meters: string;
  /** Costo promedio por kg del saldo de kardex de la bobina; `null` sin saldo registrado. */
  avgCostPen: string | null;
}

/**
 * D-369 — kilos teóricos de unos metros con la geometría de la bobina y la densidad **cruda**
 * del acabado: `ancho × espesor × largo × densidad`, sin el 1 % de merma normal que
 * `standardDensityFactor` (D-165) le suma a los kilos que planta descuenta. Es el criterio del
 * cliente: el teórico sale de los datos de la bobina, no del ancho y espesor nominales del SKU.
 */
export function coilTheoreticalKg(
  meters: Decimal,
  coil: Pick<CoilUsage, 'widthMm' | 'thicknessMm' | 'densityFactor'>,
): Decimal {
  return meters
    .times(toDecimal(coil.widthMm))
    .times(toDecimal(coil.thicknessMm))
    .times(toDecimal(coil.densityFactor))
    .div(1000);
}

export interface AssembleInput {
  query: SalesByMaterialQuery;
  /** cc24: la pestaña ya resuelta (sin ella, Coberturas Aluzinc). */
  businessLine: SalesByMaterialLine;
  lines: InvoiceLine[];
  facts: Map<string, OrderLineFacts>;
  usage: CoilUsage[];
  /** D-407: venta del rango sin producto (sin línea de negocio), con signo. */
  noLineSalesPen: string;
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

export function kgPerMeterOf(g: Geometry): Decimal | null {
  if (g.widthMm === null || g.thicknessMm === null || g.densityFactor === null) return null;
  const value = kgPerMeter({
    widthMm: g.widthMm,
    thicknessMm: g.thicknessMm,
    densityFactor: g.densityFactor,
  });
  return value.isZero() ? null : value;
}

export interface Accumulator {
  meters: Decimal;
  theoreticalKg: Decimal;
  realKg: Decimal;
  sales: Decimal;
  cost: Decimal;
  /** Cantidad en la unidad de venta (C06: costo promedio por unidad). */
  qty: Decimal;
  /**
   * La unidad de venta de lo acumulado; `null` si todavía no hay nada, `'MIXED'` si se
   * mezclan unidades (un subtotal o el total): ahí el costo por unidad no significa nada.
   */
  unit: string | null;
}

export const emptyAcc = (): Accumulator => ({
  meters: ZERO,
  theoreticalKg: ZERO,
  realKg: ZERO,
  sales: ZERO,
  cost: ZERO,
  qty: ZERO,
  unit: null,
});

export function addAcc(into: Accumulator, from: Accumulator): void {
  into.meters = into.meters.plus(from.meters);
  into.theoreticalKg = into.theoreticalKg.plus(from.theoreticalKg);
  into.realKg = into.realKg.plus(from.realKg);
  into.sales = into.sales.plus(from.sales);
  into.cost = into.cost.plus(from.cost);
  into.qty = into.qty.plus(from.qty);
  if (from.unit !== null) {
    into.unit = into.unit === null || into.unit === from.unit ? from.unit : 'MIXED';
  }
}

/** Un cociente que solo existe con divisor distinto de 0; si no, `null` («—» en pantalla y Excel). */
export function per(value: Decimal, divisor: Decimal): string | null {
  return divisor.isZero() ? null : toFixedString(value.div(divisor), 'MONEY');
}

export function figures(acc: Accumulator): SalesMaterialFiguresDto {
  const yieldKg = acc.theoreticalKg.minus(acc.realKg);
  const hasReal = !acc.realKg.isZero();
  const costPerKg = hasReal ? acc.cost.div(acc.realKg) : null;
  const pricePerKg = hasReal ? acc.sales.div(acc.realKg) : null;
  const unitKnown = acc.unit !== null && acc.unit !== 'MIXED';
  return {
    // C06: por metro lineal y por unidad de venta. Sin metros o sin cantidad, `null`.
    pricePerMeterPen: per(acc.sales, acc.meters),
    costPerMeterPen: per(acc.cost, acc.meters),
    marginPerMeterPen: per(acc.sales.minus(acc.cost), acc.meters),
    unit: unitKnown ? acc.unit : null,
    qty: unitKnown ? toFixedString(acc.qty, 'KG') : null,
    costPerUnitPen: unitKnown ? per(acc.cost, acc.qty) : null,
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

/** Lo que una bobina puso en una línea del comprobante (su parte del consumo de la línea). */
export interface TracedCoil {
  coilId: string;
  code: string;
  typeKey: string;
  finishName: string;
  thicknessMm: string;
  colorLabel: string;
  kg: Decimal;
  cost: Decimal;
  meters: Decimal;
  theoreticalKg: Decimal;
  avgCostPen: string | null;
}

/** El costeo de **una** línea de comprobante con el motor de D-354. */
export interface LineTrace {
  /** Lo trazado de la línea (`null` si no se trazó nada). */
  traced: Accumulator | null;
  /** Las bobinas de lo trazado. */
  coils: TracedCoil[];
  /** La parte no trazable, con su motivo (puede haber una junto a lo trazado). */
  untraceable: SalesMaterialUntraceableDto[];
}

/**
 * **El cuerpo del motor, por línea** (C06): «Ventas por material» lo suma por tipo × espesor ×
 * color, y la rentabilidad de cada comprobante lo muestra línea por línea. Es la misma función
 * para los dos, así que el comprobante aporta a «Ventas por material» exactamente lo que dice su
 * sección de rentabilidad (el cuadre que fija el test).
 */
export function traceLine(
  line: InvoiceLine & { kind: SalesMaterialKind },
  facts: Map<string, OrderLineFacts>,
  usageByLine: Map<string, CoilUsage[]>,
): LineTrace {
  const out: LineTrace = { traced: null, coils: [], untraceable: [] };
  const convertible = metersOf(line);
  const meters = convertible ?? ZERO;
  const sales = toDecimal(line.salesPen);

  const pushUntraceable = (reason: SalesMaterialUntraceableReason, share: Decimal): void => {
    out.untraceable.push({
      kind: line.kind,
      thicknessMm: line.thicknessMm,
      colorLabel: line.colorLabel,
      reason,
      documentId: line.documentId,
      documentNumber: line.documentNumber,
      issueDate: line.issueDate,
      salesOrderId: line.orderId,
      orderCode: line.orderSeq === null ? null : salesOrderCode(line.orderSeq),
      sku: line.sku,
      metersSold: toFixedString(meters.times(share), 'KG'),
      salesPen: toFixedString(sales.times(share), 'MONEY'),
    });
  };

  // Sin metros no hay ML, teórico ni una base de producción en la misma unidad: se declara.
  if (convertible === null) {
    pushUntraceable('SIN_METRO', ONE);
    return out;
  }
  if (line.salesOrderItemId === null) {
    pushUntraceable('SIN_PEDIDO', ONE);
    return out;
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
  if (fraction.isZero()) return out;

  // Parte de la base que le toca a esta línea del comprobante.
  const share = toDecimal(line.qty).times(fraction).div(baseQty);
  // cc24 (D-414): el perfil de Drywall no rola metros (el reporte no lleva `meters_m` ni
  // largos), así que sus metros y su teórico se reparten entre las bobinas por sus kilos, como
  // en la bobina entera. El teórico es piezas × kilos por pieza del catálogo (D-139).
  const usageKg = lineUsage.reduce((acc, u) => acc.plus(toDecimal(u.kg)), ZERO);
  const perfilTheoreticalKg =
    line.kind === 'PERFIL' && line.pieceWeightKg !== null
      ? toDecimal(line.qty).times(fraction).times(toDecimal(line.pieceWeightKg))
      : ZERO;
  const acc: Accumulator = {
    meters: meters.times(fraction),
    theoreticalKg: ZERO,
    realKg: ZERO,
    sales: sales.times(fraction),
    cost: ZERO,
    qty: toDecimal(line.qty).times(fraction),
    unit: line.unit,
  };
  for (const u of lineUsage) {
    const kg = toDecimal(u.kg).times(share);
    const cost = toDecimal(u.costPen).times(share);
    // D-369: el teórico es el de las bobinas, no el del SKU. En una bobina entera son sus
    // propios kilos (su ML se sacó de ellos); en lo producido, los metros que se rolaron de
    // cada una con su geometría y la densidad cruda.
    const kgShare = usageKg.isZero() ? ZERO : toDecimal(u.kg).div(usageKg);
    const coilMeters =
      line.kind === 'BOBINA'
        ? meters.times(fraction).times(toDecimal(u.kg)).div(baseQty)
        : line.kind === 'PERFIL'
          ? meters.times(fraction).times(kgShare)
          : toDecimal(u.meters).times(share);
    const theoreticalKg =
      line.kind === 'BOBINA'
        ? kg
        : line.kind === 'PERFIL'
          ? perfilTheoreticalKg.times(kgShare)
          : coilTheoreticalKg(coilMeters, u);
    acc.realKg = acc.realKg.plus(kg);
    acc.cost = acc.cost.plus(cost);
    acc.theoreticalKg = acc.theoreticalKg.plus(theoreticalKg);
    out.coils.push({
      coilId: u.coilId,
      code: u.code,
      typeKey: u.typeKey,
      finishName: u.finishName,
      thicknessMm: u.thicknessMm,
      colorLabel: u.colorLabel,
      kg,
      cost,
      meters: coilMeters,
      theoreticalKg,
      avgCostPen: u.avgCostPen,
    });
  }
  out.traced = acc;
  return out;
}

/** Las filas de consumo agrupadas por línea de pedido (la forma que `traceLine` lee). */
export function usageByOrderLine(usage: CoilUsage[]): Map<string, CoilUsage[]> {
  const byLine = new Map<string, CoilUsage[]>();
  for (const u of usage) {
    const found = byLine.get(u.salesOrderItemId) ?? [];
    found.push(u);
    byLine.set(u.salesOrderItemId, found);
  }
  return byLine;
}

export function assembleSalesByMaterial(input: AssembleInput): SalesByMaterialDto {
  const { query, businessLine, lines, facts, usage, noLineSalesPen } = input;

  const usageByLine = usageByOrderLine(usage);

  // El cuadre se calcula antes de filtrar: responde a «Ventas y margen», que no filtra.
  let lineSales = ZERO;
  let coilSales = ZERO;
  let unclassifiedSales = ZERO;
  for (const line of lines) {
    const sales = toDecimal(line.salesPen);
    if (line.kind === 'BOBINA') coilSales = coilSales.plus(sales);
    else lineSales = lineSales.plus(sales);
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

  interface DocState {
    documentId: string;
    documentNumber: string | null;
    issueDate: string;
    customerId: string;
    customerName: string;
    kg: Decimal;
    meters: Decimal;
  }
  interface CoilState {
    dto: Pick<
      SalesMaterialCoilDto,
      'coilId' | 'code' | 'typeKey' | 'finishName' | 'thicknessMm' | 'colorLabel' | 'avgCostPen'
    >;
    kg: Decimal;
    cost: Decimal;
    meters: Decimal;
    theoreticalKg: Decimal;
    documents: Map<string, DocState>;
  }
  interface RowState {
    kind: SalesMaterialKind;
    thicknessMm: string;
    colorLabel: string;
    acc: Accumulator;
    lineCount: number;
    coils: Map<string, CoilState>;
  }
  const rows = new Map<string, RowState>();
  const untraceable: SalesMaterialUntraceableDto[] = [];
  let untraceableSales = ZERO;

  for (const line of visible) {
    const trace = traceLine(line, facts, usageByLine);
    for (const u of trace.untraceable) {
      untraceableSales = untraceableSales.plus(toDecimal(u.salesPen));
      untraceable.push(u);
    }
    if (trace.traced === null) continue;

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
    for (const u of trace.coils) {
      const coil: CoilState = row.coils.get(u.coilId) ?? {
        dto: {
          coilId: u.coilId,
          code: u.code,
          typeKey: u.typeKey,
          finishName: u.finishName,
          thicknessMm: u.thicknessMm,
          colorLabel: u.colorLabel,
          avgCostPen: u.avgCostPen,
        },
        kg: ZERO,
        cost: ZERO,
        meters: ZERO,
        theoreticalKg: ZERO,
        documents: new Map(),
      };
      coil.kg = coil.kg.plus(u.kg);
      coil.cost = coil.cost.plus(u.cost);
      coil.meters = coil.meters.plus(u.meters);
      coil.theoreticalKg = coil.theoreticalKg.plus(u.theoreticalKg);
      const doc: DocState = coil.documents.get(line.documentId) ?? {
        documentId: line.documentId,
        documentNumber: line.documentNumber,
        issueDate: line.issueDate,
        customerId: line.customerId,
        customerName: line.customerName,
        kg: ZERO,
        meters: ZERO,
      };
      doc.kg = doc.kg.plus(u.kg);
      doc.meters = doc.meters.plus(u.meters);
      coil.documents.set(line.documentId, doc);
      row.coils.set(u.coilId, coil);
    }
    addAcc(row.acc, trace.traced);
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
          theoreticalKg: toFixedString(c.theoreticalKg, 'KG'),
          meters: toFixedString(c.meters, 'KG'),
          costPen: toFixedString(c.cost, 'MONEY'),
          documents: [...c.documents.values()]
            .sort(
              (a, b) =>
                a.issueDate.localeCompare(b.issueDate) ||
                (a.documentNumber ?? '').localeCompare(b.documentNumber ?? ''),
            )
            .map((d) => ({
              documentId: d.documentId,
              documentNumber: d.documentNumber,
              issueDate: d.issueDate,
              customerId: d.customerId,
              customerName: d.customerName,
              kg: toFixedString(d.kg, 'KG'),
              meters: toFixedString(d.meters, 'KG'),
            })),
        })),
    };
  });

  return {
    from: query.from,
    to: query.to,
    businessLine,
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
      lineSalesPen: toFixedString(lineSales, 'MONEY'),
      coilSalesPen: toFixedString(coilSales, 'MONEY'),
      unclassifiedSalesPen: toFixedString(unclassifiedSales, 'MONEY'),
    },
    noLineSalesPen: toFixedString(toDecimal(noLineSalesPen), 'MONEY'),
    products: null,
  };
}
