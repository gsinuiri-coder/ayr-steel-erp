import {
  Decimal,
  salesOrderCode,
  toDecimal,
  toFixedString,
  type SalesByProductDto,
  type SalesProductRowDto,
  type SalesProductUntraceableDto,
  type SalesProductUntraceableReason,
} from '@ayr/shared';

/**
 * cc24 (D-417) — «Ventas por material» de Coberturas (UPVC) y Reventa: una fila por producto.
 * Sin consultas: aritmética sobre las lecturas de `SalesByMaterialService`, probada sin base.
 *
 * **El costo es el de «Ventas y margen», agrupado por producto**: las salidas de kardex
 * (`refType='SALE'`, netas de reversas) de los despachos que **declaran** el comprobante
 * (`Dispatch.invoiceId`, D-205/D-213). Lo que no se puede atribuir así va a «No trazable» con
 * su motivo y nunca se estima.
 */

/** Una línea de comprobante del rango, con su signo (una nota de crédito resta). */
export interface ProductInvoiceLine {
  documentId: string;
  documentNumber: string | null;
  docType: string;
  issueDate: string;
  orderSeq: number | null;
  productId: string;
  sku: string;
  name: string;
  unit: string;
  qty: string;
  salesPen: string;
  /**
   * D-413: una bobina vendida entera cuya bobina es de Coberturas Aluzinc o de Drywall. Su venta
   * vive en la pestaña de esa línea; acá solo cuenta en el cuadre.
   */
  shownElsewhere: boolean;
}

/** Lo despachado contra un comprobante, por producto (despachos vigentes). */
export interface DeclaredDispatch {
  /** Cantidad despachada vigente, en la unidad de venta. */
  qty: string;
  /** Costo de kardex neto (salidas menos sus reversas). */
  costPen: string;
  /** D-285: algún ítem vigente salió sin movimiento de kardex. */
  untraceable: boolean;
}

export const declaredKey = (documentId: string, productId: string): string =>
  `${documentId}|${productId}`;

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

export interface ProductAssembly {
  products: SalesByProductDto;
  /** Venta de todas las líneas del producto de la línea (filas + no trazable + bobinas de otra pestaña). */
  lineSales: Decimal;
  /** D-413: venta de las bobinas enteras que se muestran en Coberturas Aluzinc o Drywall. */
  shownElsewhereSales: Decimal;
  untraceableSales: Decimal;
}

export function assembleSalesByProduct(
  lines: ProductInvoiceLine[],
  declared: Map<string, DeclaredDispatch>,
): ProductAssembly {
  let lineSales = ZERO;
  let shownElsewhereSales = ZERO;
  let untraceableSales = ZERO;
  const untraceable: SalesProductUntraceableDto[] = [];

  const pushUntraceable = (
    line: ProductInvoiceLine,
    reason: SalesProductUntraceableReason,
    qty: Decimal,
    sales: Decimal,
  ): void => {
    untraceableSales = untraceableSales.plus(sales);
    untraceable.push({
      reason,
      documentId: line.documentId,
      documentNumber: line.documentNumber,
      issueDate: line.issueDate,
      orderCode: line.orderSeq === null ? null : salesOrderCode(line.orderSeq),
      sku: line.sku,
      unit: line.unit,
      qty: toFixedString(qty, 'KG'),
      salesPen: toFixedString(sales, 'MONEY'),
    });
  };

  // Las líneas de un mismo producto en un mismo comprobante se comparan juntas contra lo que
  // sus despachos declarados sacaron: el despacho no apunta a una línea del comprobante.
  interface Group {
    first: ProductInvoiceLine;
    qty: Decimal;
    sales: Decimal;
    count: number;
  }
  const groups = new Map<string, Group>();
  for (const line of lines) {
    const sales = toDecimal(line.salesPen);
    lineSales = lineSales.plus(sales);
    if (line.shownElsewhere) {
      shownElsewhereSales = shownElsewhereSales.plus(sales);
      continue;
    }
    if (line.docType === 'NOTA_CREDITO') {
      pushUntraceable(line, 'NOTA_CREDITO', toDecimal(line.qty), sales);
      continue;
    }
    const key = declaredKey(line.documentId, line.productId);
    const group = groups.get(key) ?? { first: line, qty: ZERO, sales: ZERO, count: 0 };
    group.qty = group.qty.plus(toDecimal(line.qty));
    group.sales = group.sales.plus(sales);
    group.count += 1;
    groups.set(key, group);
  }

  interface RowState {
    sku: string;
    name: string;
    unit: string;
    qty: Decimal;
    sales: Decimal;
    cost: Decimal;
    lineCount: number;
  }
  const rows = new Map<string, RowState>();

  for (const [key, g] of groups) {
    const facts = declared.get(key);
    if (facts?.untraceable === true) {
      pushUntraceable(g.first, 'SIN_SALIDA_KARDEX', g.qty, g.sales);
      continue;
    }
    const dispatched = facts === undefined ? ZERO : toDecimal(facts.qty);
    if (facts === undefined || dispatched.lte(0) || g.qty.lte(0)) {
      pushUntraceable(g.first, 'SIN_DESPACHO_DECLARADO', g.qty, g.sales);
      continue;
    }
    // Se traza lo despachado, hasta lo facturado. Si se despachó de más contra el comprobante,
    // le toca a lo facturado su parte del costo de esa salida (la misma regla de D-354).
    const fraction = Decimal.min(ONE, dispatched.div(g.qty));
    const costShare = dispatched.gt(g.qty) ? g.qty.div(dispatched) : ONE;
    const cost = toDecimal(facts.costPen).times(costShare);
    // La parte trazada se redondea a la escala de dinero y la no trazable es el resto exacto:
    // así filas + no trazable suman la venta de la línea sin la diferencia de 0,0001 que deja
    // redondear las dos mitades por separado (autorrevisión de cc24, P3).
    const tracedSales = toDecimal(toFixedString(g.sales.times(fraction), 'MONEY'));
    if (fraction.lt(ONE)) {
      pushUntraceable(
        g.first,
        'DESPACHO_PARCIAL',
        g.qty.times(ONE.minus(fraction)),
        g.sales.minus(tracedSales),
      );
    }
    const row = rows.get(g.first.sku) ?? {
      sku: g.first.sku,
      name: g.first.name,
      unit: g.first.unit,
      qty: ZERO,
      sales: ZERO,
      cost: ZERO,
      lineCount: 0,
    };
    row.qty = row.qty.plus(g.qty.times(fraction));
    row.sales = row.sales.plus(tracedSales);
    row.cost = row.cost.plus(cost);
    row.lineCount += g.count;
    rows.set(g.first.sku, row);
  }

  let totalSales = ZERO;
  let totalCost = ZERO;
  const rowDtos: SalesProductRowDto[] = [...rows.values()]
    .sort((a, b) => a.sku.localeCompare(b.sku, 'es'))
    .map((r) => {
      totalSales = totalSales.plus(r.sales);
      totalCost = totalCost.plus(r.cost);
      return {
        sku: r.sku,
        name: r.name,
        unit: r.unit,
        qty: toFixedString(r.qty, 'KG'),
        salesPen: toFixedString(r.sales, 'MONEY'),
        costPen: toFixedString(r.cost, 'MONEY'),
        profitPen: toFixedString(r.sales.minus(r.cost), 'MONEY'),
        costPerUnitPen: r.qty.isZero() ? null : toFixedString(r.cost.div(r.qty), 'MONEY'),
        lineCount: r.lineCount,
      };
    });

  return {
    products: {
      rows: rowDtos,
      total: {
        salesPen: toFixedString(totalSales, 'MONEY'),
        costPen: toFixedString(totalCost, 'MONEY'),
        profitPen: toFixedString(totalSales.minus(totalCost), 'MONEY'),
      },
      untraceable: untraceable.sort(
        (a, b) =>
          a.issueDate.localeCompare(b.issueDate) ||
          (a.documentNumber ?? '').localeCompare(b.documentNumber ?? ''),
      ),
    },
    lineSales,
    shownElsewhereSales,
    untraceableSales,
  };
}
