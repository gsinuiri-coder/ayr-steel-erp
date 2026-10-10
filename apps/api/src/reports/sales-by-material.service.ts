import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BusinessLine,
  FINISH_KIND_LABELS,
  FinishKind,
  LIVE_DOCUMENT_STATUSES,
  SALES_BY_PRODUCT_LINES,
  toDateOnly,
  toFixedString,
  type SalesByMaterialLine,
  type SalesByMaterialDto,
  type SalesByMaterialQuery,
  type SalesMaterialKind,
} from '@ayr/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  assembleSalesByMaterial,
  colorLabelOf,
  emptyAcc,
  figures,
  type CoilUsage,
  type InvoiceLine,
  type OrderLineFacts,
} from './sales-by-material';
import {
  assembleSalesByProduct,
  declaredKey,
  type DeclaredDispatch,
  type ProductInvoiceLine,
} from './sales-by-product';

interface ProductLineRow {
  document_id: string;
  number: string | null;
  doc_type: string;
  issue_date: Date;
  order_seq: number | null;
  order_id: string | null;
  product_id: string;
  sku: string;
  name: string;
  unit: string;
  qty: Prisma.Decimal;
  subtotal_pen: Prisma.Decimal;
  shown_elsewhere: boolean;
}

interface DeclaredRow {
  invoice_id: string;
  product_id: string;
  qty: Prisma.Decimal;
  cost_pen: Prisma.Decimal;
  untraceable: boolean;
  costed_qty: Prisma.Decimal;
}

/** Los mismos estados «ya es una venta» que usa «Ventas y margen» (`LIVE_STATUSES` allá). */
const LIVE = (): Prisma.Sql => Prisma.join([...LIVE_DOCUMENT_STATUSES]);

export interface LineRow {
  document_id: string;
  number: string | null;
  doc_type: string;
  issue_date: Date;
  order_seq: number | null;
  order_id: string | null;
  sales_order_item_id: string | null;
  qty: Prisma.Decimal;
  subtotal_pen: Prisma.Decimal;
  sku: string;
  unit: string;
  is_coil_sale: boolean;
  /** cc24: código de la línea del producto y su origen (D-414: el perfil es `MANUFACTURED`). */
  product_line: string | null;
  source: string | null;
  piece_weight_kg: Prisma.Decimal | null;
  roofing_kind: string | null;
  length_mm: Prisma.Decimal | null;
  p_width: Prisma.Decimal | null;
  p_thickness: Prisma.Decimal | null;
  p_density: Prisma.Decimal | null;
  p_finish_kind: string | null;
  p_color: string | null;
  c_width: Prisma.Decimal | null;
  c_thickness: Prisma.Decimal | null;
  c_density: Prisma.Decimal | null;
  c_finish_kind: string | null;
  c_color: string | null;
  customer_id: string;
  customer_name: string;
}

interface InvoicedRow {
  sales_order_item_id: string;
  qty: Prisma.Decimal;
}

interface FactsRow {
  id: string;
  produced: Prisma.Decimal;
  order_count: bigint;
  dispatched: Prisma.Decimal;
}

interface UsageRow {
  sales_order_item_id: string;
  coil_id: string;
  code: string;
  type_key: string;
  thickness_mm: Prisma.Decimal;
  width_mm: Prisma.Decimal;
  density_factor: Prisma.Decimal;
  finish_name: string;
  finish_kind: string;
  color_name: string | null;
  kg: Prisma.Decimal;
  cost_pen: Prisma.Decimal;
  meters: Prisma.Decimal | null;
  avg_cost: Prisma.Decimal | null;
}

const ROOFING_KIND_TO_MATERIAL: Record<string, SalesMaterialKind> = {
  A_MEDIDA: 'COBERTURA',
  ACCESORIO: 'ACCESORIO',
  PLANCHA: 'PLANCHA',
};

const str = (v: Prisma.Decimal | null): string | null => (v === null ? null : v.toString());

/**
 * Las columnas y los cruces de una línea de comprobante que el motor necesita. Los comparten el
 * rango de «Ventas por material» y la rentabilidad de un comprobante (C06), para que las dos
 * lecturas no puedan describir la misma línea de dos maneras.
 */
const LINE_COLUMNS = Prisma.sql`
        fd."id" AS "document_id",
        fd."number",
        fd."doc_type"::text AS "doc_type",
        fd."issue_date",
        so."seq" AS "order_seq",
        so."id" AS "order_id",
        soi."id" AS "sales_order_item_id",
        CASE WHEN fd."doc_type" = 'NOTA_CREDITO' THEN -fdi."qty" ELSE fdi."qty" END AS "qty",
        CASE WHEN fd."doc_type" = 'NOTA_CREDITO' THEN -fdi."subtotal_pen" ELSE fdi."subtotal_pen" END
          AS "subtotal_pen",
        p."sku",
        p."unit",
        (blp."code"::text = 'trading') AS "is_coil_sale",
        blp."code"::text AS "product_line",
        p."source"::text AS "source",
        p."piece_weight_kg",
        p."roofing_kind"::text AS "roofing_kind",
        p."length_mm",
        p."width_mm" AS "p_width",
        p."thickness_mm" AS "p_thickness",
        pf."density_factor" AS "p_density",
        pf."kind"::text AS "p_finish_kind",
        pc."name" AS "p_color",
        c."width_mm" AS "c_width",
        c."thickness_mm" AS "c_thickness",
        cf."density_factor" AS "c_density",
        cf."kind"::text AS "c_finish_kind",
        cc."name" AS "c_color",
        cu."id" AS "customer_id",
        cu."name" AS "customer_name"`;

/** Los cruces de `LINE_COLUMNS`, desde `fiscal_document_items fdi` y `products p`. */
const LINE_JOINS = Prisma.sql`
      JOIN "fiscal_documents" fd ON fd."id" = fdi."document_id"
      JOIN "customers" cu ON cu."id" = fd."customer_id"
      LEFT JOIN "business_lines" blp ON blp."id" = p."business_line_id"
      LEFT JOIN "fiscal_document_items" afi ON afi."id" = fdi."affected_item_id"
      LEFT JOIN "sales_order_items" soi
        ON soi."id" = COALESCE(fdi."sales_order_item_id", afi."sales_order_item_id")
      LEFT JOIN "sales_orders" so ON so."id" = soi."sales_order_id"
      LEFT JOIN "finishes" pf ON pf."id" = p."finish_id"
      LEFT JOIN "colors" pc ON pc."id" = p."color_id"
      LEFT JOIN "coils" c
        ON soi."reserve_item_type"::text = 'COIL' AND c."id"::text = soi."reserve_item_id"::text
      LEFT JOIN "business_lines" blc ON blc."id" = c."business_line_id"
      LEFT JOIN "finishes" cf ON cf."id" = c."finish_id"
      LEFT JOIN "colors" cc ON cc."id" = c."color_id"`;

/**
 * **Qué línea entra al motor de D-354** en la pestaña de una línea: un producto de esa línea, o
 * la venta de una bobina entera (`BOB…`, línea `trading`) cuya bobina es de esa línea (D-413:
 * la bobina entera se queda en la pestaña de la línea de su bobina).
 */
function inEngine(line: SalesByMaterialLine): Prisma.Sql {
  return Prisma.sql`(
          blp."code"::text = ${line}
          OR (blp."code"::text = 'trading' AND UPPER(p."sku") LIKE 'BOB%'
              AND blc."code"::text = ${line})
        )`;
}

/** La rentabilidad de un comprobante (C06) usa el motor de Coberturas Aluzinc, como antes. */
const IN_ENGINE = inEngine(BusinessLine.METALLIC_ROOFING);

/** Lo de cada línea de pedido que el motor lee (consultas 2 a 4). */
export interface EngineFacts {
  facts: Map<string, OrderLineFacts>;
  usage: CoilUsage[];
}

/**
 * D-354 — «Ventas por material» (Coberturas Aluzinc). Solo lectura, solo ADMINISTRADOR.
 *
 * **De dónde sale cada número:**
 *
 * - *Venta y ML*: las líneas de los comprobantes vivos con `issue_date` en el rango, el mismo
 *   universo que «Ventas y margen» (`LIVE_DOCUMENT_STATUSES`, sin archivados ni guías). Una nota de
 *   crédito resta en cantidad y en importe; si no apunta a la línea del pedido, la hereda de la
 *   línea que afecta.
 * - *Peso real y costo*: los movimientos de kardex de **bobina** que produjeron para la línea de
 *   pedido —la salida de cada reporte de sus OP (`refType=PRODUCTION`, `refId` = el reporte) y
 *   el despunte al cerrarlas (`refType=SCRAP`, `refId` = la OP, D-089)—, netos de reversas. En
 *   una bobina entera, su salida por despacho (`refType=SALE`). Se prorratean por lo facturado
 *   ÷ lo producido de la línea (`traceFraction`).
 *
 * Presupuesto de consultas: **cinco, fijas**, sin importar cuántas líneas entren en el rango
 * (dos si el rango no trae ninguna línea de pedido). La quinta es la venta sin línea (D-407).
 */
@Injectable()
export class SalesByMaterialService {
  constructor(private readonly prisma: PrismaService) {}

  async report(query: SalesByMaterialQuery): Promise<SalesByMaterialDto> {
    // D-407: sin pestaña, Coberturas Aluzinc (la de siempre).
    const businessLine = query.businessLine ?? BusinessLine.METALLIC_ROOFING;
    if (SALES_BY_PRODUCT_LINES.includes(businessLine)) {
      return this.productReport(query, businessLine);
    }
    const [rows, noLine] = await Promise.all([
      this.invoiceLines(query, businessLine),
      this.noLineSales(query),
    ]);
    const { facts, usage } = await this.engineFacts(
      rows.map((r) => r.sales_order_item_id).filter((v): v is string => v !== null),
    );
    return assembleSalesByMaterial({
      query,
      businessLine,
      lines: rows.map(toInvoiceLine),
      facts,
      usage,
      noLineSalesPen: noLine[0]?.sales_pen?.toString() ?? '0',
    });
  }

  /**
   * Consultas 2 a 4 para esas líneas de pedido: tres fijas, o ninguna si no hay líneas. La
   * comparten el reporte y la rentabilidad de un comprobante (C06).
   */
  async engineFacts(orderItemIds: readonly string[]): Promise<EngineFacts> {
    const itemIds = [...new Set(orderItemIds)];
    const [invoiced, facts, usage] =
      itemIds.length === 0
        ? [[], [], []]
        : await Promise.all([
            this.invoicedByItem(itemIds),
            this.factsByItem(itemIds),
            this.coilUsage(itemIds),
          ]);

    const invoicedById = new Map(invoiced.map((r) => [r.sales_order_item_id, r.qty.toString()]));
    const factsById = new Map<string, OrderLineFacts>();
    for (const id of itemIds) {
      const f = facts.find((r) => r.id === id);
      factsById.set(id, {
        invoicedQty: invoicedById.get(id) ?? '0',
        producedQty: f === undefined ? '0' : f.produced.toString(),
        orderCount: f === undefined ? 0 : Number(f.order_count),
        dispatchedQty: f === undefined ? '0' : f.dispatched.toString(),
      });
    }
    return {
      facts: factsById,
      usage: usage.map((u): CoilUsage => ({
        salesOrderItemId: u.sales_order_item_id,
        coilId: u.coil_id,
        code: u.code,
        typeKey: u.type_key,
        finishName: u.finish_name,
        thicknessMm: u.thickness_mm.toFixed(2),
        colorLabel: colorLabelOf(u.color_name, u.finish_kind as FinishKind),
        kg: u.kg.toString(),
        costPen: u.cost_pen.toString(),
        widthMm: u.width_mm.toString(),
        densityFactor: u.density_factor.toString(),
        meters: u.meters === null ? '0' : u.meters.toString(),
        avgCostPen: u.avg_cost === null ? null : u.avg_cost.toString(),
      })),
    };
  }

  /**
   * C06 — **todas** las líneas de un comprobante vivo y de sus notas de crédito vivas, con las
   * mismas columnas que la consulta 1 y dos más: si la línea entra al motor (`in_engine`) y si es
   * de una nota de crédito que afecta a este comprobante (`is_credit`). Las líneas sin producto
   * (texto libre) también vienen: no entran al motor y se costean por el despacho.
   */
  documentLines(documentId: string): Promise<DocumentLineRow[]> {
    const live = LIVE();
    return this.prisma.$queryRaw<DocumentLineRow[]>`
      SELECT
        ${LINE_COLUMNS},
        fdi."id" AS "item_id",
        fdi."line_number",
        fdi."description",
        fdi."sales_order_item_id" AS "own_order_item_id",
        blp."code"::text AS "line_code",
        COALESCE(${IN_ENGINE}, false) AS "in_engine",
        (fd."id" <> ${documentId}::uuid) AS "is_credit",
        fd."credit_note_reason"::text AS "credit_reason"
      FROM "fiscal_document_items" fdi
      LEFT JOIN "products" p ON p."id" = fdi."product_id"
      ${LINE_JOINS}
      WHERE fd."archived_at" IS NULL
        AND fd."status"::text IN (${live})
        AND (
          fd."id" = ${documentId}::uuid
          OR (fd."doc_type" = 'NOTA_CREDITO' AND fd."affected_document_id" = ${documentId}::uuid)
        )
      ORDER BY (fd."id" <> ${documentId}::uuid) ASC, fd."issue_date" ASC, fd."number" ASC,
        fdi."line_number" ASC
    `;
  }

  /**
   * cc24 (D-417): Coberturas (UPVC) y Reventa, por producto. Tres consultas fijas (dos si el
   * rango no trae líneas): las líneas, lo despachado contra cada comprobante y la venta sin
   * línea. Los filtros de tipo, espesor y color no aplican a estas pestañas.
   */
  private async productReport(
    query: SalesByMaterialQuery,
    businessLine: SalesByMaterialLine,
  ): Promise<SalesByMaterialDto> {
    const [lines, noLine] = await Promise.all([
      this.productLines(query, businessLine),
      this.noLineSales(query),
    ]);
    const documentIds = [...new Set(lines.map((l) => l.document_id))];
    const declared = documentIds.length === 0 ? [] : await this.declaredDispatches(documentIds);

    const declaredMap = new Map<string, DeclaredDispatch>(
      declared.map((d) => [
        declaredKey(d.invoice_id, d.product_id),
        {
          qty: d.qty.toString(),
          costPen: d.cost_pen.toString(),
          untraceable: d.untraceable,
          costedQty: d.costed_qty.toString(),
        },
      ]),
    );
    const assembly = assembleSalesByProduct(lines.map(toProductLine), declaredMap);
    return {
      from: query.from,
      to: query.to,
      businessLine,
      rows: [],
      subtotals: [],
      total: figures(emptyAcc()),
      untraceable: [],
      untraceableSalesPen: toFixedString(assembly.untraceableSales, 'MONEY'),
      reconciliation: {
        lineSalesPen: toFixedString(assembly.lineSales, 'MONEY'),
        coilSalesPen: toFixedString(assembly.shownElsewhereSales, 'MONEY'),
        unclassifiedSalesPen: '0.0000',
      },
      noLineSalesPen: toFixedString(noLine[0]?.sales_pen?.toString() ?? '0', 'MONEY'),
      products: assembly.products,
    };
  }

  /**
   * Las líneas del rango de los productos de la línea. En Reventa, una bobina vendida entera
   * cuya bobina es de Coberturas Aluzinc o de Drywall se marca: vive en la pestaña de esa línea
   * (D-413) y acá solo cuenta en el cuadre.
   */
  private productLines(
    query: SalesByMaterialQuery,
    line: SalesByMaterialLine,
  ): Promise<ProductLineRow[]> {
    const live = LIVE();
    return this.prisma.$queryRaw<ProductLineRow[]>`
      SELECT
        fd."id" AS "document_id",
        fd."number",
        fd."doc_type"::text AS "doc_type",
        fd."issue_date",
        so."seq" AS "order_seq",
        so."id" AS "order_id",
        p."id" AS "product_id",
        p."sku",
        p."name",
        p."unit",
        CASE WHEN fd."doc_type" = 'NOTA_CREDITO' THEN -fdi."qty" ELSE fdi."qty" END AS "qty",
        CASE WHEN fd."doc_type" = 'NOTA_CREDITO' THEN -fdi."subtotal_pen" ELSE fdi."subtotal_pen" END
          AS "subtotal_pen",
        COALESCE(
          UPPER(p."sku") LIKE 'BOB%' AND blc."code"::text IN ('metallic-roofing', 'drywall'),
          false
        ) AS "shown_elsewhere"
      FROM "fiscal_document_items" fdi
      JOIN "products" p ON p."id" = fdi."product_id"
      ${LINE_JOINS}
      WHERE fd."archived_at" IS NULL
        AND fd."doc_type" <> 'GUIA_REMISION_REMITENTE'
        AND fd."status"::text IN (${live})
        AND fd."issue_date" >= ${toDateOnly(query.from)}::date
        AND fd."issue_date" <= ${toDateOnly(query.to)}::date
        AND blp."code"::text = ${line}
      ORDER BY fd."issue_date" ASC, fd."number" ASC, fdi."line_number" ASC
    `;
  }

  /**
   * Lo que los despachos que **declaran** cada comprobante (`Dispatch.invoiceId`) sacaron por
   * producto: la cantidad de los despachos vigentes y el costo de kardex neto de reversas (la
   * reversa es un movimiento nuevo; el ítem lo tiene el original). `untraceable`: algún ítem
   * vigente de un producto con inventario salió sin movimiento (D-285).
   */
  private declaredDispatches(documentIds: string[]): Promise<DeclaredRow[]> {
    return this.prisma.$queryRaw<DeclaredRow[]>`
      WITH qty AS (
        SELECT d."invoice_id", di."product_id",
          SUM(di."qty") AS "qty",
          BOOL_OR(di."movement_id" IS NULL AND bl."inventory_strategy"::text <> 'NOOP')
            AS "untraceable",
          SUM(di."qty") FILTER (
            WHERE di."movement_id" IS NOT NULL OR bl."inventory_strategy"::text = 'NOOP'
          ) AS "costed_qty"
        FROM "dispatch_items" di
        JOIN "dispatches" d ON d."id" = di."dispatch_id"
        JOIN "products" p ON p."id" = di."product_id"
        JOIN "business_lines" bl ON bl."id" = p."business_line_id"
        WHERE d."invoice_id" = ANY(${documentIds}::uuid[]) AND d."status" = 'ISSUED'
        GROUP BY d."invoice_id", di."product_id"
      ),
      cost AS (
        SELECT d."invoice_id", di."product_id",
          SUM(CASE m."type" WHEN 'OUT' THEN m."total_cost" ELSE -m."total_cost" END) AS "cost_pen"
        FROM "inventory_movements" m
        JOIN "dispatch_items" di ON di."movement_id" = COALESCE(m."reversal_of_id", m."id")
        JOIN "dispatches" d ON d."id" = di."dispatch_id"
        WHERE m."ref_type" = 'SALE' AND d."invoice_id" = ANY(${documentIds}::uuid[])
        GROUP BY d."invoice_id", di."product_id"
      )
      SELECT
        COALESCE(q."invoice_id", c."invoice_id") AS "invoice_id",
        COALESCE(q."product_id", c."product_id") AS "product_id",
        COALESCE(q."qty", 0) AS "qty",
        COALESCE(c."cost_pen", 0) AS "cost_pen",
        COALESCE(q."untraceable", false) AS "untraceable",
        COALESCE(q."costed_qty", 0) AS "costed_qty"
      FROM qty q
      FULL JOIN cost c ON c."invoice_id" = q."invoice_id" AND c."product_id" = q."product_id"
    `;
  }

  /**
   * D-407: la venta del rango en líneas sin producto (texto libre), con signo. No tiene línea de
   * negocio (D-398): no entra a ninguna pestaña y la pantalla la declara con un aviso.
   */
  private noLineSales(
    query: SalesByMaterialQuery,
  ): Promise<{ sales_pen: Prisma.Decimal | null }[]> {
    const live = LIVE();
    return this.prisma.$queryRaw<{ sales_pen: Prisma.Decimal | null }[]>`
      SELECT SUM(
        CASE WHEN fd."doc_type" = 'NOTA_CREDITO' THEN -fdi."subtotal_pen" ELSE fdi."subtotal_pen" END
      ) AS "sales_pen"
      FROM "fiscal_document_items" fdi
      JOIN "fiscal_documents" fd ON fd."id" = fdi."document_id"
      WHERE fdi."product_id" IS NULL
        AND fd."archived_at" IS NULL
        AND fd."doc_type" <> 'GUIA_REMISION_REMITENTE'
        AND fd."status"::text IN (${live})
        AND fd."issue_date" >= ${toDateOnly(query.from)}::date
        AND fd."issue_date" <= ${toDateOnly(query.to)}::date
    `;
  }

  /**
   * 1. Las líneas del rango: productos de la línea de la pestaña, y ventas de bobina entera
   *    (`BOB…`, línea `trading`) cuya bobina es de esa línea (D-413). La geometría de la
   *    bobina viaja para la bobina entera (su ML se saca de sus kilos).
   */
  private invoiceLines(query: SalesByMaterialQuery, line: SalesByMaterialLine): Promise<LineRow[]> {
    const live = LIVE();
    return this.prisma.$queryRaw<LineRow[]>`
      SELECT
        ${LINE_COLUMNS}
      FROM "fiscal_document_items" fdi
      JOIN "products" p ON p."id" = fdi."product_id"
      ${LINE_JOINS}
      WHERE fd."archived_at" IS NULL
        AND fd."doc_type" <> 'GUIA_REMISION_REMITENTE'
        AND fd."status"::text IN (${live})
        AND fd."issue_date" >= ${toDateOnly(query.from)}::date
        AND fd."issue_date" <= ${toDateOnly(query.to)}::date
        AND ${inEngine(line)}
      ORDER BY fd."issue_date" ASC, fd."number" ASC, fdi."line_number" ASC
    `;
  }

  /**
   * 2. Facturado neto de **toda la vida** de cada línea de pedido (D-346: emitido vivo menos
   *    notas de crédito vivas). Es el denominador de «facturé más de lo que produje».
   */
  private invoicedByItem(itemIds: string[]): Promise<InvoicedRow[]> {
    const live = LIVE();
    return this.prisma.$queryRaw<InvoicedRow[]>`
      SELECT
        COALESCE(fdi."sales_order_item_id", afi."sales_order_item_id") AS "sales_order_item_id",
        SUM(CASE WHEN fd."doc_type" = 'NOTA_CREDITO' THEN -fdi."qty" ELSE fdi."qty" END) AS "qty"
      FROM "fiscal_document_items" fdi
      JOIN "fiscal_documents" fd ON fd."id" = fdi."document_id"
      LEFT JOIN "fiscal_document_items" afi ON afi."id" = fdi."affected_item_id"
      WHERE fd."archived_at" IS NULL
        AND fd."doc_type" <> 'GUIA_REMISION_REMITENTE'
        AND fd."status"::text IN (${live})
        AND COALESCE(fdi."sales_order_item_id", afi."sales_order_item_id") = ANY(${itemIds}::uuid[])
      GROUP BY 1
    `;
  }

  /**
   * 3. Por línea de pedido: lo producido por sus OP (entrada de producto terminado de cada
   *    reporte, neta de reversas; el `ADJUST` del despunte es costo, no cantidad), cuántas OP no
   *    anuladas tiene y cuánto despachó (para distinguir «sin producción» de «desde stock»).
   */
  private factsByItem(itemIds: string[]): Promise<FactsRow[]> {
    return this.prisma.$queryRaw<FactsRow[]>`
      SELECT
        soi."id",
        COALESCE((
          SELECT SUM(CASE m."type" WHEN 'IN' THEN m."qty" WHEN 'OUT' THEN -m."qty" ELSE 0 END)
          FROM "reservations" r
          JOIN "production_orders" po ON po."reservation_id" = r."id"
          JOIN "production_reports" pr ON pr."production_order_id" = po."id"
          JOIN "inventory_movements" m
            ON m."ref_type" = 'PRODUCTION' AND m."ref_id" = pr."id"::text
           AND m."item_type" = 'PRODUCT'
          WHERE r."sales_order_item_id" = soi."id"
        ), 0) AS "produced",
        (
          SELECT COUNT(*)
          FROM "reservations" r
          JOIN "production_orders" po ON po."reservation_id" = r."id"
          WHERE r."sales_order_item_id" = soi."id" AND po."status" <> 'CANCELLED'
        ) AS "order_count",
        COALESCE((
          SELECT SUM(di."qty")
          FROM "dispatch_items" di
          JOIN "dispatches" d ON d."id" = di."dispatch_id"
          WHERE di."sales_order_item_id" = soi."id" AND d."status" = 'ISSUED'
        ), 0) AS "dispatched"
      FROM "sales_order_items" soi
      WHERE soi."id" = ANY(${itemIds}::uuid[])
    `;
  }

  /**
   * 4. Kilos y costo de bobina por línea de pedido y bobina. Tres fuentes, todas del kardex de
   *    la bobina y con su propio signo (la reversa es un `IN` que resta):
   *    - la salida de cada reporte de las OP de la línea (`PRODUCTION`, `refId` = el reporte);
   *    - el despunte al cerrar esas OP (`SCRAP`, `refId` = la OP, D-089);
   *    - la salida por despacho de una bobina vendida entera (`SALE`, por `dispatch_items`).
   */
  private coilUsage(itemIds: string[]): Promise<UsageRow[]> {
    return this.prisma.$queryRaw<UsageRow[]>`
      WITH ops AS (
        SELECT po."id" AS "op_id", r."sales_order_item_id" AS "item_id"
        FROM "production_orders" po
        JOIN "reservations" r ON r."id" = po."reservation_id"
        WHERE r."sales_order_item_id" = ANY(${itemIds}::uuid[])
      ),
      refs AS (
        SELECT 'PRODUCTION' AS "ref_type", pr."id"::text AS "ref_id", ops."item_id"
        FROM "production_reports" pr
        JOIN ops ON ops."op_id" = pr."production_order_id"
        UNION ALL
        SELECT 'SCRAP', ops."op_id"::text, ops."item_id" FROM ops
      ),
      usage AS (
        SELECT refs."item_id", m."item_id" AS "coil_id", m."type", m."qty", m."total_cost"
        FROM refs
        JOIN "inventory_movements" m
          ON m."ref_type" = refs."ref_type"::"InventoryRefType" AND m."ref_id" = refs."ref_id"
         AND m."item_type" = 'COIL'
        UNION ALL
        SELECT di."sales_order_item_id", m."item_id", m."type", m."qty", m."total_cost"
        FROM "inventory_movements" m
        JOIN "dispatch_items" di ON di."movement_id" = COALESCE(m."reversal_of_id", m."id")
        WHERE m."ref_type" = 'SALE' AND m."item_type" = 'COIL'
          AND di."sales_order_item_id" = ANY(${itemIds}::uuid[])
      ),
      -- D-369: los metros que cada reporte vigente roló, atribuidos a la bobina de su salida.
      -- Un reporte de coberturas sale de un solo rollo; la salida original es la que no es
      -- reversa (la de un reporte revertido queda fuera por el estado del reporte).
      report_coil AS (
        SELECT DISTINCT ops."item_id", pr."id" AS "report_id", pr."meters_m",
          m."item_id" AS "coil_id"
        FROM "production_reports" pr
        JOIN ops ON ops."op_id" = pr."production_order_id"
        JOIN "inventory_movements" m
          ON m."ref_type" = 'PRODUCTION' AND m."ref_id" = pr."id"::text
         AND m."item_type" = 'COIL' AND m."type" = 'OUT' AND m."reversal_of_id" IS NULL
        WHERE pr."status" = 'ACTIVE'
      ),
      -- La misma precedencia que reportMeters (production/reported-meters.ts): los metros directos del reporte (a medida y
      -- accesorio, que no lleva detalle de largos, D-343) y, si no hay, la suma de sus largos
      -- (plancha NIU, D-366).
      meters AS (
        SELECT rc."item_id", rc."coil_id",
          SUM(COALESCE(
            rc."meters_m",
            (SELECT SUM(p."qty" * p."length_mm") / 1000
             FROM "production_report_pieces" p WHERE p."report_id" = rc."report_id"),
            0
          )) AS "meters"
        FROM report_coil rc
        GROUP BY rc."item_id", rc."coil_id"
      ),
      totals AS (
        SELECT u."item_id", u."coil_id",
          SUM(CASE u."type" WHEN 'OUT' THEN u."qty" WHEN 'IN' THEN -u."qty" ELSE 0 END) AS "kg",
          SUM(CASE u."type" WHEN 'OUT' THEN u."total_cost" ELSE -u."total_cost" END) AS "cost_pen"
        FROM usage u
        GROUP BY u."item_id", u."coil_id"
      )
      SELECT
        t."item_id" AS "sales_order_item_id",
        c."id" AS "coil_id",
        c."code",
        c."type_key",
        c."thickness_mm",
        c."width_mm",
        f."density_factor",
        f."name" AS "finish_name",
        f."kind"::text AS "finish_kind",
        col."name" AS "color_name",
        t."kg",
        t."cost_pen",
        mt."meters",
        NULLIF(ib."avg_cost", 0) AS "avg_cost"
      FROM totals t
      JOIN "coils" c ON c."id"::text = t."coil_id"::text
      JOIN "finishes" f ON f."id" = c."finish_id"
      LEFT JOIN "colors" col ON col."id" = c."color_id"
      LEFT JOIN meters mt
        ON mt."item_id" = t."item_id" AND mt."coil_id"::text = t."coil_id"::text
      LEFT JOIN "inventory_balances" ib
        ON ib."item_type" = 'COIL' AND ib."item_id"::text = c."id"::text
    `;
  }
}

/** Una línea de `documentLines`: las columnas del motor y las propias del comprobante. */
export interface DocumentLineRow extends Omit<LineRow, 'sku' | 'unit'> {
  /** Sin producto (línea de texto libre): `null`. */
  sku: string | null;
  unit: string | null;
  item_id: string;
  line_number: number;
  description: string;
  /** La línea de pedido **propia** de la línea (sin heredar la de la línea que afecta). */
  own_order_item_id: string | null;
  /** Código de la línea de negocio del producto (`services` no lleva inventario). */
  line_code: string | null;
  in_engine: boolean;
  is_credit: boolean;
  /** cc34 (N6): el motivo de la NC (catálogo 09); `null` en las líneas del propio comprobante. */
  credit_reason: string | null;
}

export function toInvoiceLine(r: LineRow): InvoiceLine {
  const isCoilSale = r.is_coil_sale;
  // cc24 (D-414): en Drywall, el perfil fabricado desde fleje es la fila; el comprado no entra
  // a las filas (cuenta en el cuadre, como un producto de Aluzinc sin subtipo).
  const isDrywall = r.product_line === BusinessLine.DRYWALL;
  const kind: SalesMaterialKind | null = isCoilSale
    ? 'BOBINA'
    : isDrywall
      ? r.source === 'MANUFACTURED'
        ? 'PERFIL'
        : null
      : r.roofing_kind === null
        ? null
        : (ROOFING_KIND_TO_MATERIAL[r.roofing_kind] ?? null);
  const thickness = isCoilSale ? r.c_thickness : r.p_thickness;
  return {
    documentId: r.document_id,
    documentNumber: r.number,
    issueDate: r.issue_date.toISOString().slice(0, 10),
    orderSeq: r.order_seq,
    orderId: r.order_id,
    salesOrderItemId: r.sales_order_item_id,
    sku: r.sku,
    unit: r.unit,
    kind,
    qty: r.qty.toString(),
    salesPen: r.subtotal_pen.toString(),
    lengthMm: str(r.length_mm),
    pieceWeightKg: kind === 'PERFIL' ? str(r.piece_weight_kg) : null,
    geometry: isCoilSale
      ? {
          widthMm: str(r.c_width),
          thicknessMm: str(r.c_thickness),
          densityFactor: str(r.c_density),
        }
      : {
          widthMm: str(r.p_width),
          thicknessMm: str(r.p_thickness),
          densityFactor: str(r.p_density),
        },
    thicknessMm: thickness === null ? '0.00' : thickness.toFixed(2),
    // D-415: el producto de Drywall no lleva acabado ni color y siempre es galvanizado.
    colorLabel: isCoilSale
      ? colorLabelOf(r.c_color, r.c_finish_kind as FinishKind | null)
      : isDrywall
        ? FINISH_KIND_LABELS[FinishKind.GALVANIZADO]
        : colorLabelOf(r.p_color, r.p_finish_kind as FinishKind | null),
    customerId: r.customer_id,
    customerName: r.customer_name,
  };
}

function toProductLine(r: ProductLineRow): ProductInvoiceLine {
  return {
    documentId: r.document_id,
    documentNumber: r.number,
    docType: r.doc_type,
    issueDate: r.issue_date.toISOString().slice(0, 10),
    orderSeq: r.order_seq,
    orderId: r.order_id,
    productId: r.product_id,
    sku: r.sku,
    name: r.name,
    unit: r.unit,
    qty: r.qty.toString(),
    salesPen: r.subtotal_pen.toString(),
    shownElsewhere: r.shown_elsewhere,
  };
}
