import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CREDIT_NOTE_REASONS,
  Decimal,
  isReturnCreditNoteReason,
  QTY_CREDIT_NOTE_REASONS,
  LIVE_DOCUMENT_STATUSES,
  NO_COST_REPORT_LINES,
  salesOrderCode,
  toDateOnly,
  toDecimal,
  toFixedString,
  type MarginCostStatus,
  type SalesMarginCreditNoteDto,
  type SalesMarginCreditTotalsDto,
  type SalesMarginDocumentDto,
  type SalesMarginDto,
  type SalesMarginLineTotalDto,
  type SalesMarginOrderDto,
  type SalesMarginQuery,
} from '@ayr/shared';
import { fromDbLineCode } from '../common/business-line-code';
import { PrismaService } from '../prisma/prisma.service';
import { engineLineCosts, type EngineLineCost } from './document-profitability';
import { SalesByMaterialService, type DocumentLineRow } from './sales-by-material.service';

/**
 * Estados en los que un comprobante **ya es una venta**: `LIVE_DOCUMENT_STATUSES`, el mismo corte
 * que «Ventas por material» (C06 unificó la copia local, que era literalmente el mismo conjunto).
 *
 * `ISSUED` y `SEND_ERROR` cuentan porque el correlativo ya está tomado y el documento
 * existe para la empresa aunque el PSE todavía no conteste (D-073); `VOID_PENDING` también,
 * porque la baja está pedida pero no aceptada y hasta que SUNAT la acepte la venta sigue
 * viva. Quedan afuera `DRAFT` (no existe), `REJECTED` (terminal: se reemite con otro
 * correlativo, D-072), `VOIDED` y `ANNULLED` (D-110).
 */
const LIVE = (): Prisma.Sql => Prisma.join([...LIVE_DOCUMENT_STATUSES]);

interface DocumentRow {
  id: string;
  number: string | null;
  doc_type: string;
  status: string;
  origin: string;
  /** cc52 (D-647): el motivo de una NC (decide si declara su costo). */
  credit_note_reason: string | null;
  issue_date: Date;
  subtotal_pen: Prisma.Decimal;
  sales_order_id: string | null;
  order_seq: number | null;
  /** cc51 (D-641): el pedido tiene alguna línea vendida a costo. */
  at_cost: boolean;
  customer_id: string;
  customer_name: string;
  customer_doc_number: string;
  seller_id: string | null;
  seller_name: string | null;
  /** cc67 (D-720): el comprobante que acredita una NC, para su detalle. */
  affected_document_id: string | null;
  affected_number: string | null;
  affected_issue_date: Date | null;
}

interface OutOfRangeRow {
  sales_order_id: string;
  outside: bigint;
}

export interface CostRow {
  sales_order_id: string;
  invoice_id: string | null;
  /**
   * cc55 (D-667): la línea de pedido del despacho (o de la devolución). Es lo que deja reemplazar
   * el costo de una línea fabricada contra pedido por el de su OP. `null` si el movimiento no
   * tiene su fila de despacho (no ocurre hoy, ver `costsByOrder`) o en una fila del motor.
   */
  sales_order_item_id: string | null;
  /** cc55 (D-667): fila del costo de OP (motor), no de un despacho. */
  from_engine?: boolean;
  business_line_code: string;
  cost_pen: Prisma.Decimal;
  /**
   * cc52 (D-647): `RETURN` es el reingreso de una devolución, imputado a su **nota de crédito**
   * (`invoice_id` es la NC): cuenta en el periodo de la NC y nunca en el del comprobante.
   */
  kind: 'SALE' | 'RETURN';
  /**
   * cc67 (D-720): la fila es la reversa de un despacho (o su recosteo). Solo decide en qué parte
   * del reparto brutas / NC cae (una NC 01 sin DEV-); los totales la suman igual que siempre.
   */
  reversal?: boolean;
}

interface OpMaterialRow {
  sales_order_id: string;
  material_pen: Prisma.Decimal;
}

export interface SalesByLineRow {
  document_id: string;
  business_line_code: string | null;
  subtotal_pen: Prisma.Decimal;
  /** cc55 (D-667, revisión H1): cuántas líneas del comprobante hay en este grupo. */
  line_count?: bigint | number;
}

interface PendingDispatchRow {
  sales_order_id: string;
  pending: boolean;
  /** D-285: alguna línea despachada que lleva inventario no tiene salida de kardex. */
  untraceable: boolean;
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
 *   donde el costo de lo vendido ya está valorizado al promedio ponderado: la plancha de
 *   catálogo, la reventa y el resto del stock. Las reversas de despacho son movimientos inversos
 *   con el mismo `refType`/`refId`, así que se netean solas sin un caso especial.
 *   **cc55 (D-667):** lo **fabricado contra pedido** (Coberturas Aluzinc, las líneas del motor de
 *   «Ventas por material») se costea con su OP: la bobina que consumieron sus partes y su despunte,
 *   en la proporción de lo facturado. Es la misma cuenta que la rentabilidad del comprobante
 *   (`engineLineCosts`), por comprobante y en el periodo del comprobante. Si el motor no puede
 *   costear la línea (sin producción, sin subtipo), se queda con el promedio de su despacho.
 * - *Material de OPs*: columna aparte, informativa. **No** es el costo de esta venta: una OP
 *   puede producir de más (el excedente queda como stock libre) y un pedido servido desde
 *   stock no tiene OPs propias.
 *
 * Presupuesto de consultas: **diez, fijas**, sin importar cuántos pedidos, comprobantes,
 * líneas o despachos entren en el rango: las seis de siempre, las líneas del motor (1) y sus
 * hechos (3, solo si hay líneas del motor; cc55, D-667).
 */
@Injectable()
export class SalesMarginService {
  private readonly material: SalesByMaterialService;

  constructor(
    private readonly prisma: PrismaService,
    material?: SalesByMaterialService,
  ) {
    // cc55 (D-667): opcional para los usos directos (`new SalesMarginService(prisma)` en las CLI
    // de recosteo y de auditoría); con Nest llega inyectado.
    this.material = material ?? new SalesByMaterialService(prisma);
  }

  async salesMargin(query: SalesMarginQuery): Promise<SalesMarginDto> {
    const from = toDateOnly(query.from);
    const to = toDateOnly(query.to);
    const live = LIVE();

    // 1. Los comprobantes del rango. La guía de remisión no es una venta y no entra.
    const documents = await this.prisma.$queryRaw<DocumentRow[]>`
      SELECT
        fd."id",
        fd."number",
        fd."doc_type"::text AS "doc_type",
        fd."status"::text   AS "status",
        fd."origin"::text   AS "origin",
        fd."credit_note_reason"::text AS "credit_note_reason",
        fd."issue_date",
        fd."subtotal_pen",
        fd."sales_order_id",
        so."seq"  AS "order_seq",
        EXISTS (
          SELECT 1 FROM "sales_order_items" soi
          WHERE soi."sales_order_id" = fd."sales_order_id" AND soi."at_cost_reason" IS NOT NULL
        ) AS "at_cost",
        cu."id"   AS "customer_id",
        cu."name" AS "customer_name",
        cu."doc_number" AS "customer_doc_number",
        u."id"    AS "seller_id",
        u."name"  AS "seller_name",
        fd."affected_document_id",
        afd."number"     AS "affected_number",
        afd."issue_date" AS "affected_issue_date"
      FROM "fiscal_documents" fd
      JOIN "customers" cu ON cu."id" = fd."customer_id"
      LEFT JOIN "sales_orders" so ON so."id" = fd."sales_order_id"
      -- cc57 (E-16 de audit-01): el vendedor con la regla de CxC (documentOwnerId): el del pedido
      -- y, sin pedido, quien registró el comprobante. Una NC sin pedido toma el dueño del
      -- comprobante que acredita (autorrevisión, P2-4). Antes, una venta sin pedido quedaba «sin
      -- vendedor» acá y contaba para alguien en CxC.
      LEFT JOIN "fiscal_documents" afd ON afd."id" = fd."affected_document_id"
      LEFT JOIN "sales_orders" aso ON aso."id" = afd."sales_order_id"
      LEFT JOIN "users" u ON u."id" = COALESCE(
        so."seller_id", aso."seller_id", afd."created_by_id", fd."created_by_id"
      )
      WHERE fd."archived_at" IS NULL
        AND fd."doc_type" <> 'GUIA_REMISION_REMITENTE'
        AND fd."status"::text IN (${live})
        AND fd."issue_date" >= ${from}::date
        AND fd."issue_date" <= ${to}::date
        -- cc51 (D-641): con el filtro «A costo», solo los pedidos con alguna línea a costo.
        AND (${query.atCost !== 'true'} OR EXISTS (
          SELECT 1 FROM "sales_order_items" soi
          WHERE soi."sales_order_id" = fd."sales_order_id" AND soi."at_cost_reason" IS NOT NULL
        ))
      ORDER BY fd."issue_date" ASC, fd."number" ASC
    `;

    const orderIds = [...new Set(documents.map((d) => d.sales_order_id).filter(isString))];
    const documentIds = documents.map((d) => d.id);

    // 2..6 solo tienen sentido si el rango trajo algo. Con el rango vacío se devuelven los
    // totales en cero sin gastar cinco viajes a la base.
    const [outOfRange, costs, opMaterial, salesByLine, pendingDispatch, engineRows] =
      orderIds.length === 0 && documentIds.length === 0
        ? [[], [], [], [], [], []]
        : await Promise.all([
            this.outOfRangeCounts(orderIds, from, to, live),
            this.costsByOrder(orderIds),
            this.opMaterialByOrder(orderIds),
            this.salesByLine(documentIds),
            this.pendingDispatchByOrder(orderIds),
            this.material.engineLinesOf(documentIds),
          ]);
    // cc55 (D-667): el costo de OP de las líneas fabricadas contra pedido.
    const engineItems = engineRows
      .map((r) => r.sales_order_item_id)
      .filter((v): v is string => v !== null);
    const engineCosts =
      engineItems.length === 0
        ? new Map<string, EngineLineCost>()
        : engineLineCosts(engineRows, await this.material.engineFacts(engineItems));

    return this.assemble({
      query,
      documents,
      outOfRange,
      costs: withEngineCosts(costs, engineRows, engineCosts),
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
        -- cc52 (D-647): una NC de descuento (sin costo) o de devolución (con su propio costo) no
        -- vuelve «no comparable» al pedido en el otro periodo: su efecto es solo del suyo. cc54
        -- (D-663): toda NC que no exige devolución declara costo cero si no generó una.
        AND NOT (
          fd."doc_type" = 'NOTA_CREDITO'
          AND (
            fd."credit_note_reason"::text = ANY(${DISCOUNT_CREDIT_REASONS}::text[])
            -- Una de devolución, solo si de verdad generó su devolución (revisión de cc52, P2).
            OR EXISTS (
              SELECT 1 FROM "sales_returns" sr
              WHERE sr."credit_note_id" = fd."id" AND sr."status" = 'ACTIVE'
            )
          )
        )
      GROUP BY fd."sales_order_id"
    `;
  }

  /**
   * Costo de lo vendido por pedido, abierto por comprobante declarado y por línea de
   * negocio en una sola pasada.
   *
   * El signo sigue al kardex: un `OUT` es valor que salió del almacén y por lo tanto costo;
   * la reversa de ese despacho es un `IN` con el mismo `total_cost` y lo devuelve. Un
   * `ADJUST` bajo `refType='SALE'` es un **recosteo por fecha** (cc53, D-649): se firma al revés que
   * el `OUT` (un ajuste que saca valor del saldo es más costo) y se ata a la línea de la fila que
   * corrige por `recost_of_id`. Lo mismo en la rama de devoluciones.
   *
   * **La línea de negocio sale del producto de la línea despachada, no del movimiento**
   * (D-247). El movimiento lleva la línea del ítem que de verdad salió del almacén (D-119), y
   * para el kardex eso es lo correcto; pero en una **reventa de bobina** (D-116) el ingreso se
   * imputa al SKU de reventa —`trading`— y el acero sale de una bobina de `drywall`, así que
   * con la línea del movimiento las dos mitades del mismo margen caían en filas distintas:
   * `trading` con 100 % y `drywall` con el costo entero en negativo. Los totales generales
   * eran correctos y el desglose, absurdo. Medir ingreso y costo sobre el mismo eje es lo
   * único que hace que una tabla de margen por línea signifique algo.
   *
   * El `LEFT JOIN` al ítem del despacho es a propósito: si algún movimiento `SALE` no tuviera
   * su fila —hoy no ocurre, todos nacen de `DispatchesService`— un `JOIN` lo dejaría fuera y
   * el total de costo bajaría en silencio. Sin ítem cae de vuelta en la línea del movimiento,
   * que es la respuesta vieja: peor atribuida, pero nunca perdida.
   */
  private costsByOrder(orderIds: string[]): Promise<CostRow[]> {
    if (orderIds.length === 0) return Promise.resolve([]);
    return this.prisma.$queryRaw<CostRow[]>`
      SELECT
        d."sales_order_id",
        d."invoice_id",
        COALESCE(blp."code", blm."code")::text AS "business_line_code",
        di."sales_order_item_id",
        COALESCE(SUM(
          CASE m."type"
            WHEN 'OUT' THEN m."total_cost"
            WHEN 'IN'  THEN -m."total_cost"
            ELSE -m."total_cost"
          END
        ), 0) AS "cost_pen",
        'SALE' AS "kind",
        -- cc67 (D-720): la reversa del despacho (y su recosteo) va en su propia fila; la suma por
        -- pedido no cambia. Es lo que deja contarla en una NC 01 sin DEV-.
        (m."reversal_of_id" IS NOT NULL OR (SELECT t."reversal_of_id" FROM "inventory_movements" t WHERE t."id" = m."recost_of_id") IS NOT NULL) AS "reversal"
      FROM "inventory_movements" m
      JOIN "dispatches" d ON d."id"::text = m."ref_id"
      -- La reversa de un despacho es un movimiento nuevo: el ítem lo tiene el original, así
      -- que se lo busca por el movimiento que anula.
      LEFT JOIN "dispatch_items" di
        ON di."movement_id" = COALESCE(m."reversal_of_id", (SELECT t."reversal_of_id" FROM "inventory_movements" t WHERE t."id" = m."recost_of_id"), m."recost_of_id", m."id")
      LEFT JOIN "products" p ON p."id" = di."product_id"
      LEFT JOIN "business_lines" blp ON blp."id" = p."business_line_id"
      JOIN "business_lines" blm ON blm."id" = m."business_line_id"
      WHERE m."ref_type" = 'SALE'
        AND d."sales_order_id" = ANY(${orderIds}::uuid[])
      GROUP BY d."sales_order_id", d."invoice_id", COALESCE(blp."code", blm."code"),
        di."sales_order_item_id", 7
      UNION ALL
      -- cc52 (D-647): el reingreso de una devolución resta costo **en la NC** que la generó; su
      -- reversa (al anular la NC) lo vuelve a sumar. La línea de negocio, la del producto
      -- despachado, como el costo de la venta (D-247).
      SELECT
        sr."sales_order_id",
        sr."credit_note_id" AS "invoice_id",
        COALESCE(blp."code", blm."code")::text AS "business_line_code",
        di."sales_order_item_id",
        COALESCE(SUM(
          CASE m."type" WHEN 'OUT' THEN m."total_cost" ELSE -m."total_cost" END
        ), 0) AS "cost_pen",
        'RETURN' AS "kind",
        false AS "reversal"
      FROM "inventory_movements" m
      JOIN "sales_returns" sr ON sr."id"::text = m."ref_id"
      LEFT JOIN "sales_return_items" sri
        ON sri."movement_id" = COALESCE(m."reversal_of_id", (SELECT t."reversal_of_id" FROM "inventory_movements" t WHERE t."id" = m."recost_of_id"), m."recost_of_id", m."id")
      LEFT JOIN "dispatch_items" di ON di."id" = sri."dispatch_item_id"
      LEFT JOIN "products" p ON p."id" = di."product_id"
      LEFT JOIN "business_lines" blp ON blp."id" = p."business_line_id"
      JOIN "business_lines" blm ON blm."id" = m."business_line_id"
      WHERE m."ref_type" = 'SALES_RETURN'
        AND sr."sales_order_id" = ANY(${orderIds}::uuid[])
      GROUP BY sr."sales_order_id", sr."credit_note_id", COALESCE(blp."code", blm."code"),
        di."sales_order_item_id"
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
    // cc57 (E-15 de audit-01): con el despunte de la OP (`SCRAP`, ref = OP), como
    // `production_orders.material_cost_pen`: sin él, la columna «Material de OPs» quedaba por debajo.
    return this.prisma.$queryRaw<OpMaterialRow[]>`
      WITH "mv" AS (
        SELECT r."sales_order_id", m."type", m."total_cost"
        FROM "inventory_movements" m
        JOIN "production_reports" pr ON pr."id"::text = m."ref_id"
        JOIN "production_orders" po ON po."id" = pr."production_order_id"
        JOIN "reservations" r ON r."id" = po."reservation_id"
        WHERE m."ref_type" = 'PRODUCTION'
          AND m."item_type" = 'COIL'
          AND r."sales_order_id" = ANY(${orderIds}::uuid[])
        UNION ALL
        SELECT r."sales_order_id", m."type", m."total_cost"
        FROM "inventory_movements" m
        JOIN "production_orders" po ON po."id"::text = m."ref_id"
        JOIN "reservations" r ON r."id" = po."reservation_id"
        WHERE m."ref_type" = 'SCRAP'
          AND m."item_type" = 'COIL'
          AND r."sales_order_id" = ANY(${orderIds}::uuid[])
      )
      SELECT
        "sales_order_id",
        COALESCE(SUM(
          -- cc53 (D-649): un recosteo (ADJUST) es costo del consumo: saca valor del saldo.
          CASE "type" WHEN 'OUT' THEN "total_cost" ELSE -"total_cost" END
        ), 0) AS "material_pen"
      FROM "mv"
      GROUP BY "sales_order_id"
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
        COALESCE(SUM(fdi."subtotal_pen"), 0) AS "subtotal_pen",
        COUNT(*) AS "line_count"
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
        BOOL_OR(COALESCE(inv."qty", 0) > COALESCE(disp."qty", 0)) AS "pending",
        BOOL_OR(COALESCE(nomov."lines", 0) > 0) AS "untraceable"
      FROM "sales_order_items" soi
      LEFT JOIN (
        SELECT
          fdi."sales_order_item_id" AS "id",
          -- cc54 (D-663): una NC resta unidades solo si su motivo acredita cantidad.
          SUM(CASE WHEN fd."doc_type" = 'NOTA_CREDITO'
            THEN (CASE WHEN fd."credit_note_reason"::text = ANY(${QTY_REASONS}::text[]) THEN -fdi."qty" ELSE 0 END)
            ELSE fdi."qty" END) AS "qty"
        FROM "fiscal_document_items" fdi
        JOIN "fiscal_documents" fd ON fd."id" = fdi."document_id"
        -- cc57 (E-13 de audit-01): solo las líneas de los pedidos del reporte. Sin este filtro
        -- dentro, Postgres agregaba todas las líneas de comprobante de la base en cada llamada.
        JOIN "sales_order_items" fsoi ON fsoi."id" = fdi."sales_order_item_id"
        WHERE fd."archived_at" IS NULL
          AND fd."status"::text IN (${LIVE()})
          AND fsoi."sales_order_id" = ANY(${orderIds}::uuid[])
        GROUP BY fdi."sales_order_item_id"
      ) inv ON inv."id" = soi."id"
      LEFT JOIN (
        SELECT di."sales_order_item_id" AS "id", SUM(di."qty") AS "qty"
        FROM "dispatch_items" di
        JOIN "dispatches" d ON d."id" = di."dispatch_id"
        -- Por el pedido de la línea, no el del despacho (revisión de cc57-d): mismo resultado que
        -- sin filtro para cualquier dato.
        JOIN "sales_order_items" dsoi ON dsoi."id" = di."sales_order_item_id"
        WHERE d."status" = 'ISSUED'
          AND dsoi."sales_order_id" = ANY(${orderIds}::uuid[])
        GROUP BY di."sales_order_item_id"
      ) disp ON disp."id" = soi."id"
      LEFT JOIN (
        SELECT di."sales_order_item_id" AS "id", COUNT(*) AS "lines"
        FROM "dispatch_items" di
        JOIN "dispatches" d ON d."id" = di."dispatch_id"
        JOIN "products" p ON p."id" = di."product_id"
        JOIN "business_lines" bl ON bl."id" = p."business_line_id"
        JOIN "sales_order_items" nsoi ON nsoi."id" = di."sales_order_item_id"
        WHERE d."status" = 'ISSUED'
          AND nsoi."sales_order_id" = ANY(${orderIds}::uuid[])
          AND di."movement_id" IS NULL
          AND bl."inventory_strategy"::text <> 'NOOP'
        GROUP BY di."sales_order_item_id"
      ) nomov ON nomov."id" = soi."id"
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
    const isUntraceable = new Set(
      pendingDispatch.filter((r) => r.untraceable).map((r) => r.sales_order_id),
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
        // cc52 (D-647): la devolución solo cuenta si su NC está en el rango (abajo); acá se anota
        // igual, porque la NC «declara» su costo.
        costByDocument.set(
          row.invoice_id,
          (costByDocument.get(row.invoice_id) ?? ZERO).plus(toDecimal(row.cost_pen.toString())),
        );
      }
    }

    // cc55 (D-667, revisión H1): qué comprobantes **declaran** su costo. Antes bastaba con tener
    // una fila con su `invoice_id`; con el costo de OP, toda línea del motor la tiene. Un comprobante
    // declara si algún despacho lo declara (D-205/D-213) o si **todas** sus líneas se costean por el
    // motor; uno mixto con el resto sin despacho declarado sigue sin declarar (NO_COMPARABLE con
    // comprobantes fuera del rango), como antes de cc55.
    const declaredDocs = declaredDocuments(costs, salesByLine);

    // cc52 (D-647): una NC de descuento declara costo cero: no movió mercadería.
    for (const doc of documents) {
      if (
        doc.doc_type === 'NOTA_CREDITO' &&
        doc.credit_note_reason !== null &&
        DISCOUNT_CREDIT_REASONS.includes(doc.credit_note_reason) &&
        !costByDocument.has(doc.id)
      ) {
        costByDocument.set(doc.id, ZERO);
        declaredDocs.add(doc.id);
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
    let untraceableOrderCount = 0;
    let untraceableSales = ZERO;
    let excludedSales = ZERO;
    // cc67 (D-720): la parte de los totales que viene de las NC, decidida en el mismo recorrido que
    // los totales (y con las mismas funciones), para que «netas» sean exactamente `totals`.
    const creditNotes: SalesMarginCreditNoteDto[] = [];
    let creditSales = ZERO;
    let creditNoCostSales = ZERO;
    let creditCost = ZERO;

    // cc23 (D-391): la pestaña de la línea; `undefined` es «Todas», el reporte de siempre.
    const viewLine = query.businessLine;
    // D-412: en la pestaña de una línea sin costo registrado (Servicios, D-392) la venta no
    // depende del estado de costo del pedido, que lo deciden las otras líneas.
    const noCostView = viewLine !== undefined && isNoCostLine(viewLine);

    for (const docs of buckets.values()) {
      // Un bucket nunca nace vacío —se crea al empujarle su primer comprobante—, así que
      // esto no puede ocurrir; se comprueba en vez de afirmarlo para no dejar una aserción
      // que el día que deje de ser cierta falle con un `undefined` en otra línea.
      const [first] = docs;
      if (first === undefined) continue;
      const orderId = first.sales_order_id;

      const costStatus = resolveCostStatus({
        orderId,
        hasOutside,
        isPending,
        isUntraceable,
        docs,
        declaredDocs,
      });
      const comparable = costStatus !== 'NO_COMPARABLE' && costStatus !== 'NO_RASTREABLE';
      // D-412 (autorrevisión de cc24, P2-2): un pedido cuyas líneas son todas sin costo
      // registrado (solo Servicios) no tiene costo que comparar; su venta suma igual y no cuenta
      // como «fuera de los totales» aunque se facture en varios meses.
      const onlyNoCost = docs.every((d) => {
        const rows = salesLinesByDocument.get(d.id) ?? [];
        return (
          rows.length > 0 &&
          rows.every((r) => r.business_line_code !== null && isNoCostLine(r.business_line_code))
        );
      });
      const inTotals = comparable || noCostView || onlyNoCost;

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
          : (costRowsByOrder.get(orderId) ?? []).filter((r) =>
              // cc52 (D-647): el reingreso de una devolución cuenta **solo** en el periodo de su
              // NC; el mes del comprobante original no se reescribe.
              r.kind === 'RETURN'
                ? r.invoice_id !== null && inRangeDocIds.has(r.invoice_id)
                : !hasOutside.has(orderId) ||
                  (r.invoice_id !== null && inRangeDocIds.has(r.invoice_id)),
            );

      // cc23 (D-391): con una línea elegida, la fila del pedido es **su porción de esa línea**:
      // la venta de las líneas de sus comprobantes que son de esa línea y, de `orderCostRows`
      // —las mismas filas que suma «Todas»—, las de esa línea. No cambia cómo se calcula el
      // costo: se agrupa lo mismo que «Todas» ya abre en `totalsByLine`, y por eso las
      // pestañas suman el total de «Todas». Un pedido sin nada de esa línea no aparece.
      const viewCostRows =
        viewLine === undefined
          ? orderCostRows
          : orderCostRows.filter((r) => r.business_line_code === viewLine);
      const viewDocs =
        viewLine === undefined
          ? docs
          : docs.filter(
              (d) =>
                (salesLinesByDocument.get(d.id) ?? []).some(
                  (r) => r.business_line_code === viewLine,
                ) || viewCostRows.some((r) => r.invoice_id === d.id),
            );
      if (viewLine !== undefined && viewDocs.length === 0 && viewCostRows.length === 0) continue;
      const docSalesInView = (d: DocumentRow): Decimal =>
        viewLine === undefined ? signedSubtotal(d) : lineSales(d, viewLine, salesLinesByDocument);
      const sales = viewDocs.reduce((acc, d) => acc.plus(docSalesInView(d)), ZERO);
      // cc58 (D-681, E-04): la fila mide su margen sobre la misma base que la franja (D-409/D-419):
      // sin la venta que no tiene costo registrado. Así el pie (margen total ÷ venta total de las
      // filas) da el porcentaje de la franja, y ninguna fila de Servicios figura con 100 %.
      const docNoCostInView = (d: DocumentRow): Decimal =>
        viewLine === undefined
          ? noCostSalesOf(d, salesLinesByDocument)
          : noCostView
            ? docSalesInView(d)
            : ZERO;
      const noCostSales = viewDocs.reduce((acc, d) => acc.plus(docNoCostInView(d)), ZERO);
      const marginBase = sales.minus(noCostSales);

      // En `NO_COMPARABLE` el costo del pedido cubre más venta que la del rango, así que no se
      // muestra: un costo entero contra una venta parcial es peor que ningún costo.
      const cost = inTotals
        ? viewCostRows.reduce((acc, r) => acc.plus(toDecimal(r.cost_pen.toString())), ZERO)
        : null;

      const documentDtos: SalesMarginDocumentDto[] = viewDocs.map((d) => {
        const docSales = docSalesInView(d);
        const docBase = docSales.minus(docNoCostInView(d));
        // Fuera de los totales, el comprobante tampoco muestra costo (autorrevisión P2-7). En
        // la pestaña de una línea, solo lo muestra si un despacho **de esa línea** lo declara:
        // que otra línea lo declare no dice nada del costo de esta (cc23, autorrevisión P3-4).
        const docLineRows = viewCostRows.filter((r) => r.invoice_id === d.id);
        const docCost = !inTotals
          ? null
          : viewLine === undefined
            ? (costByDocument.get(d.id) ?? null)
            : docLineRows.length > 0
              ? docLineRows.reduce((acc, r) => acc.plus(toDecimal(r.cost_pen.toString())), ZERO)
              : null;
        return {
          id: d.id,
          number: d.number,
          docType: d.doc_type as SalesMarginDocumentDto['docType'],
          status: d.status as SalesMarginDocumentDto['status'],
          origin: d.origin as SalesMarginDocumentDto['origin'],
          issueDate: d.issue_date.toISOString().slice(0, 10),
          salesPen: toFixedString(docSales, 'MONEY'),
          costPen: docCost === null ? null : toFixedString(docCost, 'MONEY'),
          marginPen: docCost === null ? null : toFixedString(docBase.minus(docCost), 'MONEY'),
          marginPct: docCost === null ? null : marginPct(docBase, docCost),
        };
      });

      orders.push({
        salesOrderId: orderId,
        orderCode: first.order_seq === null ? null : salesOrderCode(first.order_seq),
        customerId: first.customer_id,
        customerName: first.customer_name,
        customerDocNumber: first.customer_doc_number,
        sellerId: first.seller_id,
        sellerName: first.seller_name,
        salesPen: toFixedString(sales, 'MONEY'),
        noCostSalesPen: toFixedString(noCostSales, 'MONEY'),
        costPen: cost === null ? null : toFixedString(cost, 'MONEY'),
        opMaterialCostPen: toFixedString(
          orderId === null ? ZERO : (opMaterialByOrder.get(orderId) ?? ZERO),
          'MONEY',
        ),
        marginPen: cost === null ? null : toFixedString(marginBase.minus(cost), 'MONEY'),
        marginPct: cost === null ? null : marginPct(marginBase, cost),
        costStatus,
        inTotals,
        atCost: docs.some((d) => d.at_cost),
        documents: documentDtos,
      });

      // cc67 (D-720): las NC de la fila, con lo que cada una aporta a los totales de arriba. Dentro
      // de los totales, su venta y su costo de la pestaña (las filas de costo imputadas a la NC: su
      // DEV- o el costo de OP de su línea); fuera, en «Todas», solo la venta de Servicios que
      // `addNoCostSales` suma igual (D-412), que no tiene costo ni entra al margen.
      // Decisión del dueño (cc67): una NC 01 sin DEV- del periodo se lleva la reversa del despacho de
      // su pedido (atada al comprobante que anula, o a ningún comprobante), que de otro modo dejaba
      // la factura en «brutas» con costo cero. Solo una NC por fila se la lleva; los totales no
      // cambian, porque son las mismas filas de `viewCostRows`.
      const reversalNote = viewDocs.find(
        (d) =>
          d.doc_type === 'NOTA_CREDITO' &&
          d.credit_note_reason === 'ANULACION_OPERACION' &&
          !viewCostRows.some((r) => r.kind === 'RETURN' && r.invoice_id === d.id),
      );
      const takenByNote = (r: CostRow, d: DocumentRow): boolean =>
        r.invoice_id === d.id ||
        (d === reversalNote &&
          r.reversal === true &&
          (r.invoice_id === null || r.invoice_id === d.affected_document_id));
      for (const d of viewDocs) {
        if (d.doc_type !== 'NOTA_CREDITO') continue;
        const ncSales = docSalesInView(d);
        const ncNoCost = docNoCostInView(d);
        const ncCost = inTotals
          ? viewCostRows
              .filter((r) => takenByNote(r, d))
              .reduce((acc, r) => acc.plus(toDecimal(r.cost_pen.toString())), ZERO)
          : null;
        if (ncCost !== null) {
          creditSales = creditSales.plus(ncSales);
          creditNoCostSales = creditNoCostSales.plus(ncNoCost);
          creditCost = creditCost.plus(ncCost);
        } else if (viewLine === undefined) {
          const services = NO_COST_REPORT_LINES.reduce(
            (acc, l) => acc.plus(lineSales(d, l, salesLinesByDocument)),
            ZERO,
          );
          creditSales = creditSales.plus(services);
          creditNoCostSales = creditNoCostSales.plus(services);
        }
        creditNotes.push(creditNoteDto(d, ncSales, ncNoCost, ncCost));
      }

      if (!inTotals) {
        // D-412: en «Todas», la venta de Servicios de este pedido no depende de su costo y
        // suma igual al total de ventas y a su fila de «Totales por línea». Queda fuera solo
        // el resto, que es lo que tiene un costo no comparable o no rastreable.
        const noCost =
          viewLine === undefined ? addNoCostSales(docs, salesLinesByDocument, lineTotals) : ZERO;
        totalSales = totalSales.plus(noCost);
        if (costStatus === 'NO_RASTREABLE') {
          untraceableOrderCount += 1;
          untraceableSales = untraceableSales.plus(sales.minus(noCost));
        } else {
          excludedOrderCount += 1;
          excludedSales = excludedSales.plus(sales.minus(noCost));
        }
        continue;
      }
      // En Servicios no hay costo que sea un piso (segundo modelo de cc24, P3).
      if (costStatus === 'PARCIAL' && !noCostView) partialOrderCount += 1;
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
      .filter(([line]) => viewLine === undefined || line === viewLine)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([line, v]) => ({
        businessLine: line === SIN_LINEA ? null : fromDbLineCode(line),
        salesPen: toFixedString(v.sales, 'MONEY'),
        costPen: toFixedString(v.cost, 'MONEY'),
        marginPen: toFixedString(v.sales.minus(v.cost), 'MONEY'),
        marginPct: marginPct(v.sales, v.cost),
      }));

    // D-409: el margen se calcula sin la venta de Servicios, que no tiene costo registrado
    // (D-392) y con costo 0 inflaba el margen. Sigue sumando a la venta. En «Todas» es la de su
    // fila de «Totales por línea» (con la de los pedidos excluidos, D-412); en la pestaña de
    // Servicios, toda la venta; en las demás pestañas, nada. El costo no cambia: Servicios no
    // tiene kardex (`NOOP`).
    // D-419: en «Todas» también queda fuera la venta «Sin línea» (líneas escritas a mano, sin
    // producto, D-398): tampoco tiene costo registrado. Su fila de costo es siempre 0, porque
    // toda fila de costo lleva la línea de un producto o de un movimiento.
    const noCostSales =
      viewLine === undefined
        ? [...NO_COST_REPORT_LINES, SIN_LINEA].reduce(
            (acc, l) => acc.plus(lineTotals.get(l)?.sales ?? ZERO),
            ZERO,
          )
        : noCostView
          ? totalSales
          : ZERO;
    const marginBase = totalSales.minus(noCostSales);
    // cc28 (D-461): la diferencia entre sumar comprobantes («Todas») y sumar sus líneas (las
    // pestañas y «Totales por línea»): el redondeo al céntimo de los comprobantes (D-377).
    const rounding =
      viewLine === undefined
        ? totalSales.minus([...lineTotals.values()].reduce((acc, v) => acc.plus(v.sales), ZERO))
        : ZERO;

    // cc67 (D-720): netas = `totals`; brutas = netas − NC.
    const creditMargin = creditSales.minus(creditNoCostSales).minus(creditCost);
    const netMargin = marginBase.minus(totalCost);
    const creditTotals: SalesMarginCreditTotalsDto = {
      grossSalesPen: toFixedString(totalSales.minus(creditSales), 'MONEY'),
      creditSalesPen: toFixedString(creditSales, 'MONEY'),
      netSalesPen: toFixedString(totalSales, 'MONEY'),
      grossCostPen: toFixedString(totalCost.minus(creditCost), 'MONEY'),
      creditCostPen: toFixedString(creditCost, 'MONEY'),
      netCostPen: toFixedString(totalCost, 'MONEY'),
      grossMarginPen: toFixedString(netMargin.minus(creditMargin), 'MONEY'),
      creditMarginPen: toFixedString(creditMargin, 'MONEY'),
      netMarginPen: toFixedString(netMargin, 'MONEY'),
      netMarginPct: marginPct(marginBase, totalCost),
    };
    // Por fecha de la NC, de la más antigua a la más reciente; a igual fecha, por número con su
    // parte numérica (F001-9 antes que F001-10; autorrevisión, P3-7).
    creditNotes.sort(
      (a, b) =>
        a.issueDate.localeCompare(b.issueDate) ||
        (a.number ?? '').localeCompare(b.number ?? '', 'es', { numeric: true }),
    );

    return {
      from: query.from,
      to: query.to,
      orders,
      totalsByLine,
      creditNotes,
      creditTotals,
      totals: {
        salesPen: toFixedString(totalSales, 'MONEY'),
        noCostSalesPen: toFixedString(noCostSales, 'MONEY'),
        costPen: toFixedString(totalCost, 'MONEY'),
        marginPen: toFixedString(marginBase.minus(totalCost), 'MONEY'),
        marginPct: marginPct(marginBase, totalCost),
        partialOrderCount,
        excludedOrderCount,
        excludedSalesPen: toFixedString(excludedSales, 'MONEY'),
        untraceableOrderCount,
        untraceableSalesPen: toFixedString(untraceableSales, 'MONEY'),
        roundingPen: toFixedString(rounding, 'MONEY'),
      },
    };
  }
}

const ZERO = new Decimal(0);

/**
 * cc55 (D-667): los estados del motor con los que la línea se costea por su OP. Sin producción
 * (`NO_COST_YET`), sin trazar (`UNTRACEABLE`) o con producción parcial (`PARTIAL`: el motor solo
 * costea lo producido; revisión H2), la línea de pedido sigue con el promedio de su despacho, como
 * antes: mejor un costo entero por otra base que uno parcial.
 */
// Revisión H2: `PARTIAL` (facturado de más sobre lo producido) costearía solo lo producido.
const ENGINE_COSTED: readonly string[] = ['COMPLETE'];

/**
 * cc55 (D-667) — **un solo costo para lo fabricado contra pedido.** Las líneas de pedido cuyas
 * líneas de comprobante del rango costea el motor dejan de costearse por la salida de su despacho
 * (promedio del SKU) y pasan a costearse por su OP, imputado a cada comprobante (y a cada NC, con
 * signo) en su propio periodo: una fila por línea de comprobante, con la línea de negocio del
 * producto. Si alguna línea del rango de esa línea de pedido no se puede costear por el motor, la
 * línea de pedido entera se queda con el promedio (no se mezclan bases en una misma línea).
 *
 * Pura: sin consultas. Exportada para probarla sin base.
 */
export function withEngineCosts(
  costs: readonly CostRow[],
  engineRows: readonly DocumentLineRow[],
  engineCosts: ReadonlyMap<string, EngineLineCost>,
): CostRow[] {
  const byItem = new Map<string, DocumentLineRow[]>();
  for (const r of engineRows) {
    if (r.sales_order_item_id === null || r.order_id === null) continue;
    const list = byItem.get(r.sales_order_item_id) ?? [];
    list.push(r);
    byItem.set(r.sales_order_item_id, list);
  }
  const engineItems = new Set(
    [...byItem].flatMap(([item, rows]) =>
      rows.every((r) => ENGINE_COSTED.includes(engineCosts.get(r.item_id)?.status ?? ''))
        ? [item]
        : [],
    ),
  );
  if (engineItems.size === 0) return [...costs];
  const kept = costs.filter(
    (c) => c.sales_order_item_id === null || !engineItems.has(c.sales_order_item_id),
  );
  const added: CostRow[] = [...engineItems].flatMap((item) =>
    (byItem.get(item) ?? []).map((r): CostRow => ({
      sales_order_id: r.order_id ?? '',
      invoice_id: r.document_id,
      business_line_code: r.line_code ?? r.product_line ?? '',
      sales_order_item_id: null,
      cost_pen: new Prisma.Decimal((engineCosts.get(r.item_id)?.costPen ?? ZERO).toFixed(4)),
      kind: 'SALE',
      from_engine: true,
    })),
  );
  return [...kept, ...added];
}

/**
 * cc55 (D-667, revisión H1): qué comprobantes **declaran** su costo (lo que `resolveCostStatus` mira
 * cuando el pedido tiene comprobantes fuera del rango). Un comprobante declara si algún despacho lo
 * declara (D-205/D-213) o si **todas** sus líneas se costean por el motor; uno mixto con el resto
 * sin despacho declarado no declara, como antes de cc55. (Las NC de descuento las suma `assemble`.)
 * Pura; exportada para probarla sin base.
 */
export function declaredDocuments(
  costs: readonly CostRow[],
  salesByLine: readonly SalesByLineRow[],
): Set<string> {
  const lineCountByDoc = new Map<string, number>();
  for (const r of salesByLine) {
    lineCountByDoc.set(
      r.document_id,
      (lineCountByDoc.get(r.document_id) ?? 0) + Number(r.line_count ?? 0),
    );
  }
  const engineLinesByDoc = new Map<string, number>();
  const declared = new Set<string>();
  for (const row of costs) {
    if (row.invoice_id === null) continue;
    if (row.from_engine === true) {
      engineLinesByDoc.set(row.invoice_id, (engineLinesByDoc.get(row.invoice_id) ?? 0) + 1);
    } else {
      declared.add(row.invoice_id);
    }
  }
  for (const [doc, n] of engineLinesByDoc) {
    if (n >= (lineCountByDoc.get(doc) ?? 0)) declared.add(doc);
  }
  return declared;
}

/**
 * cc52 (D-647): las NC que **declaran su costo**: las de descuento o corrección (costo cero: no
 * mueven mercadería) y las de devolución (el reingreso, imputado a la NC). Su efecto cae entero
 * en su periodo y no vuelven «no comparable» al pedido en el periodo del comprobante.
 *
 * cc54 (D-663): con el motivo decidiendo el efecto, **toda** NC declara su costo. Las que exigen
 * devolución (06, 07) lo declaran con su DEV-; las demás, con la suya si la generaron (01, D-656) o
 * con cero: 02 pasa el despacho al reemplazo (D-655), 03 y 13 no mueven importe (D-654, D-657), 04
 * y 05 no mueven mercadería.
 */
/** cc54 (D-663): los motivos que acreditan cantidad. */
const QTY_REASONS: string[] = [...QTY_CREDIT_NOTE_REASONS];
const DISCOUNT_CREDIT_REASONS: string[] = CREDIT_NOTE_REASONS.filter(
  // El 01 declara costo solo con su DEV- (la cláusula de devoluciones); sin ella, como antes: la
  // anulación del mostrador y la manual que revierte el despacho a mano no son «costo cero».
  (r) => !isReturnCreditNoteReason(r) && r !== 'ANULACION_OPERACION',
);
/** Clave interna del grupo sin línea de negocio. No es un código de línea y no se serializa. */
const SIN_LINEA = '__sin_linea__';

function isString(v: string | null): v is string {
  return v !== null;
}

/**
 * cc23: la venta de un comprobante en una línea, sin IGV y con signo, desde sus líneas (la
 * misma fuente que `totalsByLine`).
 */
function lineSales(
  doc: DocumentRow,
  line: string,
  salesLinesByDocument: Map<string, SalesByLineRow[]>,
): Decimal {
  const sign = doc.doc_type === 'NOTA_CREDITO' ? -1 : 1;
  return (salesLinesByDocument.get(doc.id) ?? [])
    .filter((r) => r.business_line_code === line)
    .reduce((acc, r) => acc.plus(toDecimal(r.subtotal_pen.toString()).times(sign)), ZERO);
}

/**
 * cc58 (D-681): la venta sin costo registrado de un comprobante, con signo: la de las líneas sin
 * costo (Servicios, D-409) y la de las escritas a mano sin producto («Sin línea», D-419). La misma
 * venta que la franja saca de la base del margen en «Todas».
 */
function noCostSalesOf(
  doc: DocumentRow,
  salesLinesByDocument: Map<string, SalesByLineRow[]>,
): Decimal {
  const sign = doc.doc_type === 'NOTA_CREDITO' ? -1 : 1;
  return (salesLinesByDocument.get(doc.id) ?? [])
    .filter((r) => r.business_line_code === null || isNoCostLine(r.business_line_code))
    .reduce((acc, r) => acc.plus(toDecimal(r.subtotal_pen.toString()).times(sign)), ZERO);
}

/** D-392: una línea cuyo reporte declara «sin costo registrado» (Servicios). */
function isNoCostLine(line: string): boolean {
  return (NO_COST_REPORT_LINES as readonly string[]).includes(line);
}

/**
 * D-412: la venta de las líneas sin costo registrado de los comprobantes de un pedido que quedó
 * fuera de los totales. La suma a su fila de `lineTotals` y la devuelve, para que el total de
 * ventas la cuente y la venta excluida no.
 */
function addNoCostSales(
  docs: DocumentRow[],
  salesLinesByDocument: Map<string, SalesByLineRow[]>,
  lineTotals: Map<string, { sales: Decimal; cost: Decimal }>,
): Decimal {
  let total = ZERO;
  for (const line of NO_COST_REPORT_LINES) {
    const sales = docs.reduce((acc, d) => acc.plus(lineSales(d, line, salesLinesByDocument)), ZERO);
    if (sales.isZero()) continue;
    const bucket = lineTotals.get(line) ?? { sales: ZERO, cost: ZERO };
    bucket.sales = bucket.sales.plus(sales);
    lineTotals.set(line, bucket);
    total = total.plus(sales);
  }
  return total;
}

/**
 * cc67 (D-720): la fila del detalle de una NC. `cost` es `null` si su pedido queda fuera de los
 * totales; ahí tampoco se muestra su efecto en el margen.
 */
function creditNoteDto(
  d: DocumentRow,
  sales: Decimal,
  noCost: Decimal,
  cost: Decimal | null,
): SalesMarginCreditNoteDto {
  const issueDate = d.issue_date.toISOString().slice(0, 10);
  const affectedIssueDate = d.affected_issue_date?.toISOString().slice(0, 10) ?? null;
  return {
    id: d.id,
    number: d.number,
    issueDate,
    reason: (d.credit_note_reason as SalesMarginCreditNoteDto['reason']) ?? null,
    affectedDocumentId: d.affected_document_id,
    affectedNumber: d.affected_number,
    affectedIssueDate,
    affectedEarlierMonth:
      affectedIssueDate !== null && affectedIssueDate.slice(0, 7) < issueDate.slice(0, 7),
    salesOrderId: d.sales_order_id,
    orderCode: d.order_seq === null ? null : salesOrderCode(d.order_seq),
    customerId: d.customer_id,
    customerName: d.customer_name,
    customerDocNumber: d.customer_doc_number,
    salesPen: toFixedString(sales, 'MONEY'),
    costPen: cost === null ? null : toFixedString(cost, 'MONEY'),
    marginPen: cost === null ? null : toFixedString(sales.minus(noCost).minus(cost), 'MONEY'),
    inTotals: cost !== null,
  };
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
  isUntraceable: Set<string>;
  docs: DocumentRow[];
  /** cc55 (revisión H1): los comprobantes que declaran su costo (ver `assemble`). */
  declaredDocs: Set<string>;
}): MarginCostStatus {
  const { orderId, hasOutside, isPending, isUntraceable, docs, declaredDocs } = input;
  // Una venta directa sin pedido no tiene nada fuera del rango con lo que compartir costo.
  if (orderId === null) return 'COMPLETO';
  // D-285: algo salió del almacén sin su salida de kardex: el costo no se puede rastrear.
  if (isUntraceable.has(orderId)) return 'NO_RASTREABLE';
  if (hasOutside.has(orderId)) {
    const everyDocDeclaresDispatch = docs.every((d) => declaredDocs.has(d.id));
    if (!everyDocDeclaresDispatch) return 'NO_COMPARABLE';
  }
  return isPending.has(orderId) ? 'PARCIAL' : 'COMPLETO';
}
