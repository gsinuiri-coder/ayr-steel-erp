import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  Decimal,
  salesOrderCode,
  toDateOnly,
  toDecimal,
  toFixedString,
  type MarginCostStatus,
  type SalesMarginDocumentDto,
  type SalesMarginDto,
  type SalesMarginLineTotalDto,
  type SalesMarginOrderDto,
  type SalesMarginQuery,
} from '@ayr/shared';
import { fromDbLineCode } from '../common/business-line-code';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Estados en los que un comprobante **ya es una venta**.
 *
 * `ISSUED` y `SEND_ERROR` cuentan porque el correlativo ya está tomado y el documento
 * existe para la empresa aunque el PSE todavía no conteste (D-073); `VOID_PENDING` también,
 * porque la baja está pedida pero no aceptada y hasta que SUNAT la acepte la venta sigue
 * viva. Quedan afuera `DRAFT` (no existe), `REJECTED` (terminal: se reemite con otro
 * correlativo, D-072), `VOIDED` y `ANNULLED` (D-110).
 */
const LIVE_STATUSES = ['ISSUED', 'ACCEPTED', 'SEND_ERROR', 'VOID_PENDING'] as const;

interface DocumentRow {
  id: string;
  number: string | null;
  doc_type: string;
  status: string;
  origin: string;
  issue_date: Date;
  subtotal_pen: Prisma.Decimal;
  sales_order_id: string | null;
  order_seq: number | null;
  customer_name: string;
  seller_name: string | null;
}

interface OutOfRangeRow {
  sales_order_id: string;
  outside: bigint;
}

interface CostRow {
  sales_order_id: string;
  invoice_id: string | null;
  business_line_code: string;
  cost_pen: Prisma.Decimal;
}

interface OpMaterialRow {
  sales_order_id: string;
  material_pen: Prisma.Decimal;
}

interface SalesByLineRow {
  document_id: string;
  business_line_code: string | null;
  subtotal_pen: Prisma.Decimal;
}

interface PendingDispatchRow {
  sales_order_id: string;
  pending: boolean;
}

/**
 * Ventas y margen por rango de fechas (RF-S4a/M2). Solo lectura, solo ADMINISTRADOR.
 *
 * **De dónde sale cada número**, porque es lo único que hace auditable a un reporte de
 * margen:
 *
 * - *Venta*: `fiscal_documents.subtotal_pen` —sin IGV, la verdad interna del negocio (§7)—
 *   de los comprobantes vivos con `issue_date` en el rango. Las notas de crédito restan.
 * - *Costo*: los movimientos de kardex `refType='SALE'` de los despachos del pedido, que es
 *   donde el costo de lo vendido ya está valorizado al promedio ponderado, igual para el
 *   producto fabricado, la plancha de catálogo y la bobina de reventa. Las reversas de
 *   despacho son movimientos inversos con el mismo `refType`/`refId`, así que se netean
 *   solas sin un caso especial.
 * - *Material de OPs*: columna aparte, informativa. **No** es el costo de esta venta: una OP
 *   puede producir de más (el excedente queda como stock libre) y un pedido servido desde
 *   stock no tiene OPs propias.
 *
 * Presupuesto de consultas: **seis, fijas**, sin importar cuántos pedidos, comprobantes,
 * líneas o despachos entren en el rango.
 */
@Injectable()
export class SalesMarginService {
  constructor(private readonly prisma: PrismaService) {}

  async salesMargin(query: SalesMarginQuery): Promise<SalesMarginDto> {
    const from = toDateOnly(query.from);
    const to = toDateOnly(query.to);
    const live = Prisma.join([...LIVE_STATUSES]);

    // 1. Los comprobantes del rango. La guía de remisión no es una venta y no entra.
    const documents = await this.prisma.$queryRaw<DocumentRow[]>`
      SELECT
        fd."id",
        fd."number",
        fd."doc_type"::text AS "doc_type",
        fd."status"::text   AS "status",
        fd."origin"::text   AS "origin",
        fd."issue_date",
        fd."subtotal_pen",
        fd."sales_order_id",
        so."seq"  AS "order_seq",
        cu."name" AS "customer_name",
        u."name"  AS "seller_name"
      FROM "fiscal_documents" fd
      JOIN "customers" cu ON cu."id" = fd."customer_id"
      LEFT JOIN "sales_orders" so ON so."id" = fd."sales_order_id"
      LEFT JOIN "users" u ON u."id" = so."seller_id"
      WHERE fd."archived_at" IS NULL
        AND fd."doc_type" <> 'GUIA_REMISION_REMITENTE'
        AND fd."status"::text IN (${live})
        AND fd."issue_date" >= ${from}::date
        AND fd."issue_date" <= ${to}::date
      ORDER BY fd."issue_date" ASC, fd."number" ASC
    `;

    const orderIds = [...new Set(documents.map((d) => d.sales_order_id).filter(isString))];
    const documentIds = documents.map((d) => d.id);

    // 2..6 solo tienen sentido si el rango trajo algo. Con el rango vacío se devuelven los
    // totales en cero sin gastar cinco viajes a la base.
    const [outOfRange, costs, opMaterial, salesByLine, pendingDispatch] =
      orderIds.length === 0 && documentIds.length === 0
        ? [[], [], [], [], []]
        : await Promise.all([
            this.outOfRangeCounts(orderIds, from, to, live),
            this.costsByOrder(orderIds),
            this.opMaterialByOrder(orderIds),
            this.salesByLine(documentIds),
            this.pendingDispatchByOrder(orderIds),
          ]);

    return this.assemble({
      query,
      documents,
      outOfRange,
      costs,
      opMaterial,
      salesByLine,
      pendingDispatch,
    });
  }

  /**
   * Cuántos comprobantes vivos tiene cada pedido **fuera** del rango. Es lo que decide si su
   * venta del rango es toda su venta o solo una parte (ver `resolveCostStatus`).
   */
  private outOfRangeCounts(
    orderIds: string[],
    from: Date,
    to: Date,
    live: Prisma.Sql,
  ): Promise<OutOfRangeRow[]> {
    if (orderIds.length === 0) return Promise.resolve([]);
    return this.prisma.$queryRaw<OutOfRangeRow[]>`
      SELECT fd."sales_order_id", COUNT(*) AS "outside"
      FROM "fiscal_documents" fd
      WHERE fd."sales_order_id" = ANY(${orderIds}::uuid[])
        AND fd."archived_at" IS NULL
        AND fd."doc_type" <> 'GUIA_REMISION_REMITENTE'
        AND fd."status"::text IN (${live})
        AND (fd."issue_date" < ${from}::date OR fd."issue_date" > ${to}::date)
      GROUP BY fd."sales_order_id"
    `;
  }

  /**
   * Costo de lo vendido por pedido, abierto por comprobante declarado y por línea de
   * negocio en una sola pasada.
   *
   * El signo sigue al kardex: un `OUT` es valor que salió del almacén y por lo tanto costo;
   * la reversa de ese despacho es un `IN` con el mismo `total_cost` y lo devuelve. Un
   * `ADJUST` bajo `refType='SALE'` no existe hoy, y se firma al revés que el `OUT` para que
   * el día que exista siga cerrando contra el valorizado en vez de sumarse dos veces.
   */
  private costsByOrder(orderIds: string[]): Promise<CostRow[]> {
    if (orderIds.length === 0) return Promise.resolve([]);
    return this.prisma.$queryRaw<CostRow[]>`
      SELECT
        d."sales_order_id",
        d."invoice_id",
        bl."code"::text AS "business_line_code",
        COALESCE(SUM(
          CASE m."type"
            WHEN 'OUT' THEN m."total_cost"
            WHEN 'IN'  THEN -m."total_cost"
            ELSE -m."total_cost"
          END
        ), 0) AS "cost_pen"
      FROM "inventory_movements" m
      JOIN "dispatches" d ON d."id"::text = m."ref_id"
      JOIN "business_lines" bl ON bl."id" = m."business_line_id"
      WHERE m."ref_type" = 'SALE'
        AND d."sales_order_id" = ANY(${orderIds}::uuid[])
      GROUP BY d."sales_order_id", d."invoice_id", bl."code"
    `;
  }

  /**
   * Material que consumieron las OPs del pedido. Columna de planta: se muestra al lado del
   * costo para que se vea la diferencia, no para reemplazarlo.
   *
   * Solo el consumo de bobina (`item_type='COIL'`); la entrada de producto terminado del
   * mismo reporte lleva el mismo `refType` y sumarla contaría el material dos veces.
   */
  private opMaterialByOrder(orderIds: string[]): Promise<OpMaterialRow[]> {
    if (orderIds.length === 0) return Promise.resolve([]);
    return this.prisma.$queryRaw<OpMaterialRow[]>`
      SELECT
        r."sales_order_id",
        COALESCE(SUM(
          CASE m."type" WHEN 'OUT' THEN m."total_cost" WHEN 'IN' THEN -m."total_cost" ELSE 0 END
        ), 0) AS "material_pen"
      FROM "inventory_movements" m
      JOIN "production_reports" pr ON pr."id"::text = m."ref_id"
      JOIN "production_orders" po ON po."id" = pr."production_order_id"
      JOIN "reservations" r ON r."id" = po."reservation_id"
      WHERE m."ref_type" = 'PRODUCTION'
        AND m."item_type" = 'COIL'
        AND r."sales_order_id" = ANY(${orderIds}::uuid[])
      GROUP BY r."sales_order_id"
    `;
  }

  /**
   * Venta por línea de negocio, al grano de la línea del comprobante. La línea sale del
   * producto; una línea libre (un servicio, un ajuste de nota de crédito) no tiene producto
   * y cae en el grupo «sin línea» en vez de repartirse por ahí.
   */
  private salesByLine(documentIds: string[]): Promise<SalesByLineRow[]> {
    if (documentIds.length === 0) return Promise.resolve([]);
    return this.prisma.$queryRaw<SalesByLineRow[]>`
      SELECT
        fdi."document_id",
        bl."code"::text AS "business_line_code",
        COALESCE(SUM(fdi."subtotal_pen"), 0) AS "subtotal_pen"
      FROM "fiscal_document_items" fdi
      LEFT JOIN "products" p ON p."id" = fdi."product_id"
      LEFT JOIN "business_lines" bl ON bl."id" = p."business_line_id"
      WHERE fdi."document_id" = ANY(${documentIds}::uuid[])
      GROUP BY fdi."document_id", bl."code"
    `;
  }

  /**
   * Qué pedidos tienen líneas facturadas que todavía no salieron del almacén: ahí el costo
   * es un piso y el margen un techo, y la fila se marca «costo parcial».
   *
   * La comparación es **por línea de pedido y en la unidad de venta**, que es la única en la
   * que las dos cantidades hablan de lo mismo: sumar cantidades de líneas distintas mezcla
   * piezas con metros y no significa nada. Los despachos revertidos no cuentan como salida.
   */
  private pendingDispatchByOrder(orderIds: string[]): Promise<PendingDispatchRow[]> {
    if (orderIds.length === 0) return Promise.resolve([]);
    return this.prisma.$queryRaw<PendingDispatchRow[]>`
      SELECT
        soi."sales_order_id",
        BOOL_OR(COALESCE(inv."qty", 0) > COALESCE(disp."qty", 0)) AS "pending"
      FROM "sales_order_items" soi
      LEFT JOIN (
        SELECT
          fdi."sales_order_item_id" AS "id",
          SUM(CASE WHEN fd."doc_type" = 'NOTA_CREDITO' THEN -fdi."qty" ELSE fdi."qty" END) AS "qty"
        FROM "fiscal_document_items" fdi
        JOIN "fiscal_documents" fd ON fd."id" = fdi."document_id"
        WHERE fd."archived_at" IS NULL
          AND fd."status"::text IN ('ISSUED', 'ACCEPTED', 'SEND_ERROR', 'VOID_PENDING')
          AND fdi."sales_order_item_id" IS NOT NULL
        GROUP BY fdi."sales_order_item_id"
      ) inv ON inv."id" = soi."id"
      LEFT JOIN (
        SELECT di."sales_order_item_id" AS "id", SUM(di."qty") AS "qty"
        FROM "dispatch_items" di
        JOIN "dispatches" d ON d."id" = di."dispatch_id"
        WHERE d."status" = 'ISSUED'
        GROUP BY di."sales_order_item_id"
      ) disp ON disp."id" = soi."id"
      WHERE soi."sales_order_id" = ANY(${orderIds}::uuid[])
      GROUP BY soi."sales_order_id"
    `;
  }

  /** Arma el DTO. Sin consultas: todo lo que sigue es aritmética sobre las seis lecturas. */
  private assemble(input: {
    query: SalesMarginQuery;
    documents: DocumentRow[];
    outOfRange: OutOfRangeRow[];
    costs: CostRow[];
    opMaterial: OpMaterialRow[];
    salesByLine: SalesByLineRow[];
    pendingDispatch: PendingDispatchRow[];
  }): SalesMarginDto {
    const { query, documents, outOfRange, costs, opMaterial, salesByLine, pendingDispatch } = input;

    const hasOutside = new Set(
      outOfRange.filter((r) => r.outside > 0n).map((r) => r.sales_order_id),
    );
    const isPending = new Set(
      pendingDispatch.filter((r) => r.pending).map((r) => r.sales_order_id),
    );
    const opMaterialByOrder = new Map(
      opMaterial.map((r) => [r.sales_order_id, toDecimal(r.material_pen.toString())]),
    );

    // Las filas de costo se guardan **sin agregar** por pedido, porque el monto del pedido y
    // su apertura por línea tienen que salir del mismo subconjunto de filas. Agregarlas acá
    // obligaba a decidir dos veces cuáles cuentan —una para el total y otra para las líneas—,
    // y las dos decisiones se separaron: el pedido con comprobantes fuera del rango sumaba
    // solo su porción al total y el pedido **entero** a los totales por línea, así que
    // `totals.costPen` y la suma de `totalsByLine` dejaban de coincidir.
    const costRowsByOrder = new Map<string, CostRow[]>();
    const costByDocument = new Map<string, Decimal>();
    for (const row of costs) {
      const rows = costRowsByOrder.get(row.sales_order_id) ?? [];
      rows.push(row);
      costRowsByOrder.set(row.sales_order_id, rows);
      if (row.invoice_id !== null) {
        costByDocument.set(
          row.invoice_id,
          (costByDocument.get(row.invoice_id) ?? ZERO).plus(toDecimal(row.cost_pen.toString())),
        );
      }
    }

    const salesLinesByDocument = new Map<string, SalesByLineRow[]>();
    for (const row of salesByLine) {
      const found = salesLinesByDocument.get(row.document_id) ?? [];
      found.push(row);
      salesLinesByDocument.set(row.document_id, found);
    }

    // Un comprobante sin pedido (venta directa) se agrupa por sí mismo: no hay pedido con el
    // que juntarlo y meterlo en un cajón compartido inventaría una relación que no existe.
    const buckets = new Map<string, DocumentRow[]>();
    for (const doc of documents) {
      const key = doc.sales_order_id ?? `doc:${doc.id}`;
      const found = buckets.get(key) ?? [];
      found.push(doc);
      buckets.set(key, found);
    }

    const orders: SalesMarginOrderDto[] = [];
    const lineTotals = new Map<string, { sales: Decimal; cost: Decimal }>();
    let totalSales = ZERO;
    let totalCost = ZERO;
    let partialOrderCount = 0;
    let excludedOrderCount = 0;
    let excludedSales = ZERO;

    for (const docs of buckets.values()) {
      // Un bucket nunca nace vacío —se crea al empujarle su primer comprobante—, así que
      // esto no puede ocurrir; se comprueba en vez de afirmarlo para no dejar una aserción
      // que el día que deje de ser cierta falle con un `undefined` en otra línea.
      const [first] = docs;
      if (first === undefined) continue;
      const orderId = first.sales_order_id;
      const sales = docs.reduce((acc, d) => acc.plus(signedSubtotal(d)), ZERO);

      const costStatus = resolveCostStatus({
        orderId,
        hasOutside,
        isPending,
        docs,
        costByDocument,
      });
      const inTotals = costStatus !== 'NO_COMPARABLE';

      // **Las filas de costo que le tocan a este pedido**, elegidas una sola vez: de acá salen
      // tanto el monto de la fila como su apertura por línea de negocio, y por eso los dos no
      // pueden discrepar. Cuando el pedido tiene comprobantes fuera del rango, solo cuentan
      // las filas de los despachos que declaran un comprobante **del rango**: esa porción
      // tiene costo exacto propio y no hace falta prorratear nada. En cualquier otro caso
      // cuentan todas, que es el costo entero del pedido.
      const inRangeDocIds = new Set(docs.map((d) => d.id));
      const orderCostRows =
        orderId === null
          ? []
          : (costRowsByOrder.get(orderId) ?? []).filter(
              (r) =>
                !hasOutside.has(orderId) ||
                (r.invoice_id !== null && inRangeDocIds.has(r.invoice_id)),
            );

      // En `NO_COMPARABLE` el costo del pedido cubre más venta que la del rango, así que no se
      // muestra: un costo entero contra una venta parcial es peor que ningún costo.
      const cost = inTotals
        ? orderCostRows.reduce((acc, r) => acc.plus(toDecimal(r.cost_pen.toString())), ZERO)
        : null;

      const documentDtos: SalesMarginDocumentDto[] = docs.map((d) => {
        const docSales = signedSubtotal(d);
        const docCost = costByDocument.get(d.id) ?? null;
        return {
          id: d.id,
          number: d.number,
          docType: d.doc_type as SalesMarginDocumentDto['docType'],
          status: d.status as SalesMarginDocumentDto['status'],
          origin: d.origin as SalesMarginDocumentDto['origin'],
          issueDate: d.issue_date.toISOString().slice(0, 10),
          salesPen: toFixedString(docSales, 'MONEY'),
          costPen: docCost === null ? null : toFixedString(docCost, 'MONEY'),
          marginPen: docCost === null ? null : toFixedString(docSales.minus(docCost), 'MONEY'),
          marginPct: docCost === null ? null : marginPct(docSales, docCost),
        };
      });

      orders.push({
        salesOrderId: orderId,
        orderCode: first.order_seq === null ? null : salesOrderCode(first.order_seq),
        customerName: first.customer_name,
        sellerName: first.seller_name,
        salesPen: toFixedString(sales, 'MONEY'),
        costPen: cost === null ? null : toFixedString(cost, 'MONEY'),
        opMaterialCostPen: toFixedString(
          orderId === null ? ZERO : (opMaterialByOrder.get(orderId) ?? ZERO),
          'MONEY',
        ),
        marginPen: cost === null ? null : toFixedString(sales.minus(cost), 'MONEY'),
        marginPct: cost === null ? null : marginPct(sales, cost),
        costStatus,
        inTotals,
        documents: documentDtos,
      });

      if (!inTotals) {
        excludedOrderCount += 1;
        excludedSales = excludedSales.plus(sales);
        continue;
      }
      if (costStatus === 'PARCIAL') partialOrderCount += 1;
      totalSales = totalSales.plus(sales);
      totalCost = totalCost.plus(cost ?? ZERO);

      // La venta por línea es exacta (sale de las líneas del comprobante). El costo por
      // línea viene del `business_line_id` de su propio movimiento de kardex, que es el del
      // ítem que de verdad salió del almacén (D-119) y no el de la línea del pedido.
      for (const d of docs) {
        const sign = d.doc_type === 'NOTA_CREDITO' ? -1 : 1;
        for (const row of salesLinesByDocument.get(d.id) ?? []) {
          const line = row.business_line_code ?? SIN_LINEA;
          const bucket = lineTotals.get(line) ?? { sales: ZERO, cost: ZERO };
          bucket.sales = bucket.sales.plus(toDecimal(row.subtotal_pen.toString()).times(sign));
          lineTotals.set(line, bucket);
        }
      }
      // **Las mismas filas que dieron `cost`**, abiertas por línea. Que sea el mismo arreglo y
      // no otra lectura es lo que garantiza que `totals.costPen` sea exactamente la suma de
      // `totalsByLine[].costPen`; decidirlo por segunda vez acá es lo que las separaba.
      for (const row of orderCostRows) {
        const bucket = lineTotals.get(row.business_line_code) ?? { sales: ZERO, cost: ZERO };
        bucket.cost = bucket.cost.plus(toDecimal(row.cost_pen.toString()));
        lineTotals.set(row.business_line_code, bucket);
      }
    }

    const totalsByLine: SalesMarginLineTotalDto[] = [...lineTotals.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([line, v]) => ({
        businessLine: line === SIN_LINEA ? null : fromDbLineCode(line),
        salesPen: toFixedString(v.sales, 'MONEY'),
        costPen: toFixedString(v.cost, 'MONEY'),
        marginPen: toFixedString(v.sales.minus(v.cost), 'MONEY'),
        marginPct: marginPct(v.sales, v.cost),
      }));

    return {
      from: query.from,
      to: query.to,
      orders,
      totalsByLine,
      totals: {
        salesPen: toFixedString(totalSales, 'MONEY'),
        costPen: toFixedString(totalCost, 'MONEY'),
        marginPen: toFixedString(totalSales.minus(totalCost), 'MONEY'),
        marginPct: marginPct(totalSales, totalCost),
        partialOrderCount,
        excludedOrderCount,
        excludedSalesPen: toFixedString(excludedSales, 'MONEY'),
      },
    };
  }
}

const ZERO = new Decimal(0);
/** Clave interna del grupo sin línea de negocio. No es un código de línea y no se serializa. */
const SIN_LINEA = '__sin_linea__';

function isString(v: string | null): v is string {
  return v !== null;
}

/** Sin IGV y con signo: una nota de crédito resta. */
function signedSubtotal(doc: DocumentRow): Decimal {
  const subtotal = toDecimal(doc.subtotal_pen.toString());
  return doc.doc_type === 'NOTA_CREDITO' ? subtotal.negated() : subtotal;
}

/**
 * Margen **sobre venta** (§7), en puntos porcentuales con dos decimales, o `null` cuando la
 * venta no es positiva.
 *
 * Con venta cero la división no existe. Con venta **negativa** existe y es peor: un pedido o
 * una línea cuya única actividad del rango es la nota de crédito que anula una venta anterior
 * da `(−500 − 0) / −500 = +100 %`, que en pantalla se lee como el mejor margen del mes. Los
 * dos signos se dividen por cero conceptualmente —no hay base de venta sobre la cual medir—
 * así que el porcentaje se calla y el monto en soles, que sí dice la verdad, queda.
 */
function marginPct(sales: Decimal, cost: Decimal): string | null {
  if (sales.lte(0)) return null;
  return sales.minus(cost).div(sales).times(100).toFixed(2);
}

/**
 * Qué tan comparable es el costo de esta fila con su venta del rango. El orden de las
 * preguntas es el criterio, y es el que decide qué entra a los totales de margen:
 *
 * 1. Si el pedido no tiene comprobantes vivos fuera del rango, su venta del rango es toda su
 *    venta y el costo del pedido le corresponde entero.
 * 2. Si los tiene, pero **cada** comprobante del rango declara su despacho (D-205/D-213), la
 *    porción tiene costo exacto propio y también es comparable.
 * 3. Si los tiene y alguno no declara despacho, cruzar el costo entero con una venta parcial
 *    daría un margen falso y prorratearlo, uno inventado. La fila se muestra sin costo y
 *    fuera de los totales.
 *
 * Dentro de 1 y 2, que queden líneas facturadas sin despachar hace el costo `PARCIAL`: es un
 * piso real, no una omisión, y el total dice cuántas filas están así.
 */
function resolveCostStatus(input: {
  orderId: string | null;
  hasOutside: Set<string>;
  isPending: Set<string>;
  docs: DocumentRow[];
  costByDocument: Map<string, Decimal>;
}): MarginCostStatus {
  const { orderId, hasOutside, isPending, docs, costByDocument } = input;
  // Una venta directa sin pedido no tiene nada fuera del rango con lo que compartir costo.
  if (orderId === null) return 'COMPLETO';
  if (hasOutside.has(orderId)) {
    const everyDocDeclaresDispatch = docs.every((d) => costByDocument.has(d.id));
    if (!everyDocDeclaresDispatch) return 'NO_COMPARABLE';
  }
  return isPending.has(orderId) ? 'PARCIAL' : 'COMPLETO';
}
