import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  LIVE_DOCUMENT_STATUSES,
  toDateOnly,
  type FinishKind,
  type SalesByMaterialDto,
  type SalesByMaterialQuery,
  type SalesMaterialKind,
} from '@ayr/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  assembleSalesByMaterial,
  colorLabelOf,
  type CoilUsage,
  type InvoiceLine,
  type OrderLineFacts,
} from './sales-by-material';

/** Los mismos estados «ya es una venta» que usa «Ventas y margen» (`LIVE_STATUSES` allá). */
const LIVE = (): Prisma.Sql => Prisma.join([...LIVE_DOCUMENT_STATUSES]);

interface LineRow {
  document_id: string;
  number: string | null;
  doc_type: string;
  issue_date: Date;
  order_seq: number | null;
  sales_order_item_id: string | null;
  qty: Prisma.Decimal;
  subtotal_pen: Prisma.Decimal;
  sku: string;
  unit: string;
  is_coil_sale: boolean;
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
  thickness_mm: Prisma.Decimal;
  finish_kind: string;
  color_name: string | null;
  kg: Prisma.Decimal;
  cost_pen: Prisma.Decimal;
}

const ROOFING_KIND_TO_MATERIAL: Record<string, SalesMaterialKind> = {
  A_MEDIDA: 'COBERTURA',
  ACCESORIO: 'ACCESORIO',
  PLANCHA: 'PLANCHA',
};

const str = (v: Prisma.Decimal | null): string | null => (v === null ? null : v.toString());

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
 * Presupuesto de consultas: **cuatro, fijas**, sin importar cuántas líneas entren en el rango
 * (una sola si el rango no trae ninguna línea de pedido).
 */
@Injectable()
export class SalesByMaterialService {
  constructor(private readonly prisma: PrismaService) {}

  async report(query: SalesByMaterialQuery): Promise<SalesByMaterialDto> {
    const rows = await this.invoiceLines(query);
    const itemIds = [
      ...new Set(rows.map((r) => r.sales_order_item_id).filter((v): v is string => v !== null)),
    ];
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

    return assembleSalesByMaterial({
      query,
      lines: rows.map(toInvoiceLine),
      facts: factsById,
      usage: usage.map((u): CoilUsage => ({
        salesOrderItemId: u.sales_order_item_id,
        coilId: u.coil_id,
        code: u.code,
        thicknessMm: u.thickness_mm.toFixed(2),
        colorLabel: colorLabelOf(u.color_name, u.finish_kind as FinishKind),
        kg: u.kg.toString(),
        costPen: u.cost_pen.toString(),
      })),
    });
  }

  /**
   * 1. Las líneas del rango: productos de Coberturas Aluzinc, y ventas de bobina entera
   *    (`BOB…`, línea `trading`) cuya bobina es de Coberturas Aluzinc. La geometría de la
   *    bobina viaja para la bobina entera (su ML se saca de sus kilos).
   */
  private invoiceLines(query: SalesByMaterialQuery): Promise<LineRow[]> {
    const live = LIVE();
    return this.prisma.$queryRaw<LineRow[]>`
      SELECT
        fd."id" AS "document_id",
        fd."number",
        fd."doc_type"::text AS "doc_type",
        fd."issue_date",
        so."seq" AS "order_seq",
        soi."id" AS "sales_order_item_id",
        CASE WHEN fd."doc_type" = 'NOTA_CREDITO' THEN -fdi."qty" ELSE fdi."qty" END AS "qty",
        CASE WHEN fd."doc_type" = 'NOTA_CREDITO' THEN -fdi."subtotal_pen" ELSE fdi."subtotal_pen" END
          AS "subtotal_pen",
        p."sku",
        p."unit",
        (blp."code"::text = 'trading') AS "is_coil_sale",
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
        cc."name" AS "c_color"
      FROM "fiscal_document_items" fdi
      JOIN "fiscal_documents" fd ON fd."id" = fdi."document_id"
      JOIN "products" p ON p."id" = fdi."product_id"
      JOIN "business_lines" blp ON blp."id" = p."business_line_id"
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
      LEFT JOIN "colors" cc ON cc."id" = c."color_id"
      WHERE fd."archived_at" IS NULL
        AND fd."doc_type" <> 'GUIA_REMISION_REMITENTE'
        AND fd."status"::text IN (${live})
        AND fd."issue_date" >= ${toDateOnly(query.from)}::date
        AND fd."issue_date" <= ${toDateOnly(query.to)}::date
        AND (
          blp."code"::text = 'metallic-roofing'
          OR (blp."code"::text = 'trading' AND UPPER(p."sku") LIKE 'BOB%'
              AND blc."code"::text = 'metallic-roofing')
        )
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
      )
      SELECT
        u."item_id" AS "sales_order_item_id",
        c."id" AS "coil_id",
        c."code",
        c."thickness_mm",
        f."kind"::text AS "finish_kind",
        col."name" AS "color_name",
        SUM(CASE u."type" WHEN 'OUT' THEN u."qty" WHEN 'IN' THEN -u."qty" ELSE 0 END) AS "kg",
        SUM(CASE u."type" WHEN 'OUT' THEN u."total_cost" ELSE -u."total_cost" END) AS "cost_pen"
      FROM usage u
      JOIN "coils" c ON c."id"::text = u."coil_id"::text
      JOIN "finishes" f ON f."id" = c."finish_id"
      LEFT JOIN "colors" col ON col."id" = c."color_id"
      GROUP BY u."item_id", c."id", c."code", c."thickness_mm", f."kind", col."name"
    `;
  }
}

function toInvoiceLine(r: LineRow): InvoiceLine {
  const isCoilSale = r.is_coil_sale;
  const kind: SalesMaterialKind | null = isCoilSale
    ? 'BOBINA'
    : r.roofing_kind === null
      ? null
      : (ROOFING_KIND_TO_MATERIAL[r.roofing_kind] ?? null);
  const thickness = isCoilSale ? r.c_thickness : r.p_thickness;
  return {
    documentId: r.document_id,
    documentNumber: r.number,
    issueDate: r.issue_date.toISOString().slice(0, 10),
    orderSeq: r.order_seq,
    salesOrderItemId: r.sales_order_item_id,
    sku: r.sku,
    unit: r.unit,
    kind,
    qty: r.qty.toString(),
    salesPen: r.subtotal_pen.toString(),
    lengthMm: str(r.length_mm),
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
    colorLabel: isCoilSale
      ? colorLabelOf(r.c_color, r.c_finish_kind as FinishKind | null)
      : colorLabelOf(r.p_color, r.p_finish_kind as FinishKind | null),
  };
}
