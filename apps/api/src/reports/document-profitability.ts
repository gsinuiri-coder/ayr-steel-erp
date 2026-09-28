import {
  Decimal,
  SALES_MATERIAL_UNTRACEABLE_LABELS,
  dispatchCode,
  toDecimal,
  toFixedString,
  type DocumentProfitCostBasis,
  type DocumentProfitFiguresDto,
  type DocumentProfitLineDto,
  type DocumentProfitLineStatus,
  type DocumentProfitabilityDto,
  type SalesMaterialKind,
} from '@ayr/shared';
import {
  addAcc,
  emptyAcc,
  metersOf,
  per,
  traceLine,
  usageByOrderLine,
  type Accumulator,
} from './sales-by-material';
import { toInvoiceLine, type DocumentLineRow, type EngineFacts } from './sales-by-material.service';

/**
 * C06 — armado de la rentabilidad de un comprobante. Sin consultas: todo lo que sigue es
 * aritmética sobre las lecturas de `DocumentProfitabilityService`, y por eso se prueba sin base.
 *
 * Las líneas de Coberturas Aluzinc pasan por `traceLine`, **la misma función** que suma «Ventas
 * por material»: el comprobante aporta a ese reporte exactamente su `materialTotal`.
 */

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

/** Lo despachado y costeado de una línea de pedido en los despachos **declarados** del comprobante. */
export interface DeclaredSale {
  /** Cantidad despachada neta (despachos vigentes), en unidad de venta. */
  dispatchedQty: string;
  /** Costo de las salidas `SALE`, neto de reversas. */
  costPen: string;
  /** Alguna línea despachada vigente sin salida de kardex (lo entregado antes del inventario inicial, D-278). */
  withoutMovement: boolean;
  /** Correlativos de los despachos vigentes. */
  dispatchSeqs: number[];
}

export interface AssembleProfitabilityInput {
  document: { id: string; number: string | null; docType: string };
  rows: DocumentLineRow[];
  engine: EngineFacts;
  /** Por línea de pedido. */
  declared: Map<string, DeclaredSale>;
  /** El comprobante tiene al menos un despacho declarado vigente. */
  hasDeclaredDispatch: boolean;
}

/** Lo que suma una fila o un total, y si sus cocientes por kilo o por metro tienen sentido. */
interface Sum {
  acc: Accumulator;
  /** Todas las partes costeadas tienen kilos (las del motor): por kilo significa algo. */
  kg: boolean;
  /** Todas las partes costeadas tienen metros. */
  meters: boolean;
  /** Hubo alguna parte costeada. */
  any: boolean;
}

const emptySum = (): Sum => ({ acc: emptyAcc(), kg: true, meters: true, any: false });

function addSum(into: Sum, from: Sum): void {
  if (!from.any) return;
  addAcc(into.acc, from.acc);
  into.kg = into.kg && from.kg;
  into.meters = into.meters && from.meters;
  into.any = true;
}

function toFigures(sum: Sum): DocumentProfitFiguresDto {
  const { acc } = sum;
  const profit = acc.sales.minus(acc.cost);
  const kg = sum.any && sum.kg;
  const meters = sum.any && sum.meters;
  const unitKnown = acc.unit !== null && acc.unit !== 'MIXED';
  return {
    salesPen: toFixedString(acc.sales, 'MONEY'),
    costPen: toFixedString(acc.cost, 'MONEY'),
    profitPen: toFixedString(profit, 'MONEY'),
    // D-244: con venta ≤ 0 el porcentaje no existe (o se lee como el mejor margen del período).
    marginPct: acc.sales.gt(0) ? profit.div(acc.sales).times(100).toFixed(2) : null,
    metersSold: meters ? toFixedString(acc.meters, 'KG') : null,
    theoreticalKg: kg ? toFixedString(acc.theoreticalKg, 'KG') : null,
    realKg: kg ? toFixedString(acc.realKg, 'KG') : null,
    pricePerKgPen: kg ? per(acc.sales, acc.realKg) : null,
    costPerKgPen: kg ? per(acc.cost, acc.realKg) : null,
    marginPerKgPen: kg ? per(profit, acc.realKg) : null,
    pricePerMeterPen: meters ? per(acc.sales, acc.meters) : null,
    costPerMeterPen: meters ? per(acc.cost, acc.meters) : null,
    marginPerMeterPen: meters ? per(profit, acc.meters) : null,
    costPerUnitPen: sum.any && unitKnown ? per(acc.cost, acc.qty) : null,
  };
}

const ROOFING_TO_KIND: Record<string, SalesMaterialKind> = {
  A_MEDIDA: 'COBERTURA',
  ACCESORIO: 'ACCESORIO',
  PLANCHA: 'PLANCHA',
};

interface LineResult {
  dto: DocumentProfitLineDto;
  sum: Sum;
  engine: boolean;
}

function baseDto(
  row: DocumentLineRow,
): Omit<
  DocumentProfitLineDto,
  | keyof DocumentProfitFiguresDto
  | 'uncostedSalesPen'
  | 'costBasis'
  | 'costBasisDetail'
  | 'status'
  | 'note'
> {
  return {
    itemId: row.item_id,
    documentId: row.document_id,
    documentNumber: row.number,
    lineNumber: row.line_number,
    sku: row.sku,
    description: row.description,
    qty: toFixedString(toDecimal(row.qty.toString()), 'KG'),
    unit: row.unit,
    lineSalesPen: toFixedString(toDecimal(row.subtotal_pen.toString()), 'MONEY'),
  };
}

function finish(
  row: DocumentLineRow,
  sum: Sum,
  extra: {
    costBasis: DocumentProfitCostBasis | null;
    costBasisDetail: string | null;
    status: DocumentProfitLineStatus;
    note: string | null;
  },
): DocumentProfitLineDto {
  const lineSales = toDecimal(row.subtotal_pen.toString());
  return {
    ...baseDto(row),
    ...toFigures(sum),
    uncostedSalesPen: toFixedString(lineSales.minus(sum.any ? sum.acc.sales : ZERO), 'MONEY'),
    ...extra,
  };
}

/** Una línea de Coberturas Aluzinc: el motor de «Ventas por material», tal cual. */
function engineLine(
  row: DocumentLineRow,
  engine: EngineFacts,
  usageByLine: ReturnType<typeof usageByOrderLine>,
): LineResult {
  const line = toInvoiceLine({ ...row, sku: row.sku ?? '', unit: row.unit ?? '' });
  const kind =
    line.kind ?? (row.roofing_kind === null ? null : (ROOFING_TO_KIND[row.roofing_kind] ?? null));
  if (kind === null) {
    // Cuenta en el cuadre de «Ventas por material» y no en sus filas (`unclassifiedSalesPen`).
    return {
      engine: true,
      sum: emptySum(),
      dto: finish(row, emptySum(), {
        costBasis: 'COIL_KG',
        costBasisDetail: null,
        status: 'UNTRACEABLE',
        note: 'Producto de Coberturas Aluzinc sin subtipo: no se puede trazar',
      }),
    };
  }
  const trace = traceLine({ ...line, kind }, engine.facts, usageByLine);
  const sum: Sum =
    trace.traced === null ? emptySum() : { acc: trace.traced, kg: true, meters: true, any: true };
  const reasons = [...new Set(trace.untraceable.map((u) => u.reason))];
  const status: DocumentProfitLineStatus =
    trace.traced === null
      ? reasons.every((r) => r === 'SIN_PRODUCCION' || r === 'SIN_DESPACHO')
        ? 'NO_COST_YET'
        : 'UNTRACEABLE'
      : reasons.length > 0
        ? 'PARTIAL'
        : 'COMPLETE';
  const coils = trace.coils.map((c) => `${c.code} (${toFixedString(c.kg, 'KG')} kg)`).join(', ');
  return {
    engine: true,
    sum,
    dto: finish(row, sum, {
      costBasis: 'COIL_KG',
      costBasisDetail: coils === '' ? null : coils,
      status,
      note:
        reasons.length === 0
          ? null
          : reasons.map((r) => SALES_MATERIAL_UNTRACEABLE_LABELS[r]).join('; '),
    }),
  };
}

/**
 * Una línea que no es de Coberturas Aluzinc: la salida `SALE` de los despachos declarados del
 * comprobante para su línea de pedido (D-242), nunca el despacho del pedido (D-205).
 */
function dispatchLine(
  row: DocumentLineRow,
  input: AssembleProfitabilityInput,
  invoicedByItem: Map<string, Decimal>,
): LineResult {
  const none = (status: DocumentProfitLineStatus, note: string): LineResult => ({
    engine: false,
    sum: emptySum(),
    dto: finish(row, emptySum(), {
      costBasis: 'DISPATCH_SALE',
      costBasisDetail: null,
      status,
      note,
    }),
  });
  if (row.line_code === 'services') {
    return none('NO_COST', 'Servicio: no lleva inventario, no tiene costo de kardex');
  }
  const orderItem = row.own_order_item_id ?? row.sales_order_item_id;
  if (orderItem === null) return none('UNTRACEABLE', SALES_MATERIAL_UNTRACEABLE_LABELS.SIN_PEDIDO);
  if (!input.hasDeclaredDispatch) {
    return none('NO_COST_YET', 'Sin despacho declarado en este comprobante (D-205)');
  }
  const sale = input.declared.get(orderItem);
  const dispatched = sale === undefined ? ZERO : toDecimal(sale.dispatchedQty);
  if (sale === undefined || dispatched.lte(0)) {
    return none('NO_COST_YET', 'El despacho declarado no incluye esta línea todavía');
  }
  const cost = toDecimal(sale.costPen);
  if (sale.withoutMovement && cost.isZero()) {
    return none('NO_COST', 'Entregado antes del inventario inicial: sin salida de kardex (D-278)');
  }

  const qty = toDecimal(row.qty.toString());
  const invoicedTotal = invoicedByItem.get(orderItem) ?? qty;
  // Lo que se costea de la línea: todo, si lo despachado cubre lo facturado de la línea de
  // pedido en este comprobante; si no, la misma fracción en cada línea que la comparta.
  const ratio = invoicedTotal.lte(0) ? ZERO : Decimal.min(ONE, dispatched.div(invoicedTotal));
  const tracedQty = qty.times(ratio);
  const sales = toDecimal(row.subtotal_pen.toString());
  const meters = metersOf({
    kind: null,
    unit: row.unit ?? '',
    qty: tracedQty.toString(),
    lengthMm: row.length_mm === null ? null : row.length_mm.toString(),
    geometry: { widthMm: null, thicknessMm: null, densityFactor: null },
  });
  const sum: Sum = {
    acc: {
      ...emptyAcc(),
      meters: meters ?? ZERO,
      sales: sales.times(ratio),
      // La salida sale al promedio del ítem (D-028): cada unidad despachada cuesta lo mismo.
      cost: cost.times(tracedQty).div(dispatched),
      qty: tracedQty,
      unit: row.unit,
    },
    kg: false,
    meters: meters !== null,
    any: true,
  };
  const partial = ratio.lt(ONE);
  return {
    engine: false,
    sum,
    dto: finish(row, sum, {
      costBasis: 'DISPATCH_SALE',
      costBasisDetail: sale.dispatchSeqs.map((s) => dispatchCode(s)).join(', '),
      status: partial ? 'PARTIAL' : 'COMPLETE',
      note: partial
        ? `Despachado ${toFixedString(dispatched, 'KG')} de ${toFixedString(invoicedTotal, 'KG')}: el resto, sin costo aún`
        : null,
    }),
  };
}

export function assembleDocumentProfitability(
  input: AssembleProfitabilityInput,
): DocumentProfitabilityDto {
  const usageByLine = usageByOrderLine(input.engine.usage);
  const own = input.rows.filter((r) => !r.is_credit);
  const credit = input.rows.filter((r) => r.is_credit);

  // Lo facturado de cada línea de pedido en este comprobante, fuera del motor: dos líneas que
  // comparten la línea de pedido se reparten lo despachado.
  const invoicedByItem = new Map<string, Decimal>();
  for (const r of own) {
    const item = r.own_order_item_id ?? r.sales_order_item_id;
    if (r.in_engine || item === null) continue;
    invoicedByItem.set(item, (invoicedByItem.get(item) ?? ZERO).plus(toDecimal(r.qty.toString())));
  }

  const ownResults = own.map((row) =>
    row.in_engine
      ? engineLine(row, input.engine, usageByLine)
      : dispatchLine(row, input, invoicedByItem),
  );
  const creditResults = credit.map((row): LineResult => {
    if (row.in_engine) return engineLine(row, input.engine, usageByLine);
    return {
      engine: false,
      sum: emptySum(),
      dto: finish(row, emptySum(), {
        costBasis: null,
        costBasisDetail: null,
        status: 'NO_COST',
        note: 'Nota de crédito: el costo de lo devuelto vuelve por la reversa del despacho',
      }),
    };
  });

  const total = emptySum();
  const material = emptySum();
  let uncosted = ZERO;
  for (const r of ownResults) {
    addSum(total, r.sum);
    if (r.engine) addSum(material, r.sum);
    uncosted = uncosted.plus(toDecimal(r.dto.uncostedSalesPen));
  }

  let credited: DocumentProfitabilityDto['credited'] = null;
  let net: DocumentProfitabilityDto['net'] = null;
  if (creditResults.length > 0) {
    const creditTotal = emptySum();
    let creditUncosted = ZERO;
    for (const r of creditResults) {
      addSum(creditTotal, r.sum);
      creditUncosted = creditUncosted.plus(toDecimal(r.dto.uncostedSalesPen));
    }
    const notes = new Map<string, string | null>();
    for (const r of credit) notes.set(r.document_id, r.number);
    credited = {
      notes: [...notes].map(([id, number]) => ({ id, number })),
      lines: creditResults.map((r) => r.dto),
      total: toFigures(creditTotal),
      uncostedSalesPen: toFixedString(creditUncosted, 'MONEY'),
    };
    const netSum = emptySum();
    addSum(netSum, total);
    addSum(netSum, creditTotal);
    net = toFigures(netSum);
  }

  return {
    documentId: input.document.id,
    documentNumber: input.document.number,
    docType: input.document.docType,
    applies: true,
    notApplicableReason: null,
    lines: ownResults.map((r) => r.dto),
    total: toFigures(total),
    uncostedSalesPen: toFixedString(uncosted, 'MONEY'),
    materialTotal: toFigures(material),
    credited,
    net,
  };
}

/** Un comprobante que no es una venta viva: la sección lo dice y no calcula nada. */
export function notApplicable(
  document: { id: string; number: string | null; docType: string },
  reason: string,
): DocumentProfitabilityDto {
  const zero = toFigures(emptySum());
  return {
    documentId: document.id,
    documentNumber: document.number,
    docType: document.docType,
    applies: false,
    notApplicableReason: reason,
    lines: [],
    total: zero,
    uncostedSalesPen: '0.0000',
    materialTotal: zero,
    credited: null,
    net: null,
  };
}
