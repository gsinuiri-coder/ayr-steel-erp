import { HttpException, Injectable } from '@nestjs/common';
import {
  FiscalDocType,
  InventoryItemType,
  QuotationStatus,
  SalesOrderStatus,
  type Prisma,
} from '@prisma/client';
import {
  EXTERNAL_INVOICE_NOTES_PREFIX,
  externalInvoiceOf,
  fromDateOnly,
  importRoundingTolerance,
  normalizeCoilSku,
  quotationCode,
  salesOrderCode,
  STANDING_DOCUMENT_STATUSES,
  toDecimal,
  type SalesItemInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  coilPoolFor,
  isCoilSaleProduct,
  knownCoilAttributes,
  lineCoilPool,
} from '../sales/coil-sale-product';
import { QuotationsService } from '../sales/quotations.service';
import { SalesOrderEditsService } from '../sales/sales-order-edits.service';
import type { PaperLine } from './quotation-import.service';

/**
 * **Barrido de lo ya importado (RF-S4b).** Dry-run por defecto.
 *
 * Recorre **todas** las cotizaciones y pedidos que trajo el importador (abiertos y cerrados) contra
 * el comprobante de origen —el mismo export de ventas detalladas— y lista:
 *
 * - **(a)** líneas enganchadas a un producto que R1 resolvería distinto: un código de bobina que
 *   no vende una bobina del pool (el `BOB…` suelto de COT-000002), o un producto unido a otro;
 * - **(b)** líneas cuyo importe guardado no es el del comprobante (ediciones que perdieron
 *   céntimos, o el IGV recalculado al 18 % en vez del del papel);
 * - **(c)** documentos abiertos que hoy no se pueden confirmar ni emitir por (a) o (b) y que el
 *   execute **no** puede corregir solo (varias candidatas o ninguna): los resuelve el dueño.
 *
 * El execute corrige **solo documentos abiertos**, por los servicios de dominio y auditado: ata la
 * línea a la única bobina candidata (D-254) y restablece los importes del papel (D-255). Lo cerrado
 * o emitido solo se reporta.
 */

export type SweepDocKind = 'COTIZACION' | 'PEDIDO';

export interface SweepLineFinding {
  lineNumber: number;
  /** El SKU que la línea tiene hoy. */
  productSku: string;
  /**
   * El SKU que la línea tendría después del execute: el canónico del pool si (a) la ata a una
   * bobina, el mismo en cualquier otro caso. El dry-run lo muestra como «actual → nuevo».
   */
  newSku: string;
  /** El código de la fila del papel con la que se emparejó, o `null` si no hay una única. */
  paperSku: string | null;
  /** (a): la línea no vende la bobina del pool, o su producto está unido a otro. */
  product: {
    reason: string;
    /** La bobina a la que el execute la ataría; `null` si hay que elegirla a mano. */
    autoCoilId: string | null;
    autoCoilCode: string | null;
    candidates: number;
  } | null;
  /**
   * (c) La línea no tiene **una única** fila del papel con su mismo producto normalizado y su
   * misma cantidad (y, si hay varias, su mismo importe). Nunca se empareja por posición: una
   * línea sin pareja única no se toca y queda para el dueño con el motivo.
   */
  unpaired: string | null;
  /** (b): el importe guardado no es el del papel. */
  amounts: {
    stored: { net: string; igv: string; total: string };
    paper: { net: string; igv: string | null; total: string | null };
  } | null;
}

export interface SweepDocument {
  kind: SweepDocKind;
  id: string;
  code: string;
  status: string;
  externalKey: string;
  /** Abierto = cotización sin confirmar, o pedido vivo sin comprobante. */
  open: boolean;
  /** Algo que impide comparar el documento contra el papel (su comprobante no está en el archivo). */
  unmatched: string | null;
  findings: SweepLineFinding[];
  /** Filas del papel de este comprobante que no quedaron emparejadas con ninguna línea. */
  unpairedPaperRows: number[];
}

export interface SweepReport {
  documents: SweepDocument[];
  /** Cuántos documentos importados se revisaron. */
  reviewed: number;
}

export interface SweepExecution {
  fixed: { kind: SweepDocKind; code: string; lines: number[] }[];
  /** Los que el dominio rechazó al corregir, con el motivo. Quedan en (c). */
  failed: { kind: SweepDocKind; code: string; reason: string }[];
  /** (c) después del execute: abiertos con hallazgos que quedan para el dueño. */
  pending: SweepDocument[];
}

const OPEN_QUOTATION = new Set<QuotationStatus>([QuotationStatus.DRAFT, QuotationStatus.EMITTED]);
const OPEN_ORDER = new Set<SalesOrderStatus>([
  SalesOrderStatus.CONFIRMED,
  SalesOrderStatus.IN_PRODUCTION,
  SalesOrderStatus.PARTIALLY_FULFILLED,
]);

const LINE_SELECT = {
  id: true,
  lineNumber: true,
  productId: true,
  description: true,
  qty: true,
  unitPricePen: true,
  subtotalPen: true,
  igvPen: true,
  totalPen: true,
  reserveItemType: true,
  reserveItemId: true,
  pieces: { select: { lengthMm: true, qty: true }, orderBy: { lineNumber: 'asc' } },
  product: {
    select: {
      sku: true,
      name: true,
      isActive: true,
      mergedIntoId: true,
      businessLine: { select: { code: true } },
    },
  },
} satisfies Prisma.QuotationItemSelect;

type DocLine = Prisma.QuotationItemGetPayload<{ select: typeof LINE_SELECT }>;

/** El motivo con el que el barrido firma sus correcciones en `audit_log`. */
export const SWEEP_AUDIT_REASON = 'Barrido de lo importado (RF-S4b): comprobante de origen';

/** Margen entre la fila de precio y la de auditoría de una misma transacción del barrido. */
const SWEEP_AUDIT_WINDOW_MS = 5_000;

/**
 * D-264: ¿este cambio de precio lo dejó el propio barrido? Hasta D-264 el execute registraba
 * sus correcciones en `sales_price_changes` a nombre del ADMINISTRADOR (el de la ventana de
 * RF-S4b, 36 documentos). Se reconocen por su auditoría: una fila del barrido sobre el mismo
 * documento, escrita en la misma transacción (segundos de diferencia como mucho).
 */
export function isSweepPriceChange(
  change: { quotationId: string | null; salesOrderId: string | null; changedAt: Date },
  sweepAudits: readonly { entityId: string | null; at: Date }[],
): boolean {
  const docId = change.quotationId ?? change.salesOrderId;
  return sweepAudits.some(
    (a) =>
      a.entityId === docId &&
      Math.abs(a.at.getTime() - change.changedAt.getTime()) <= SWEEP_AUDIT_WINDOW_MS,
  );
}

/** Un cambio de precio registrado (D-187), lo que el criterio de D-264 necesita de él. */
export interface RecordedPriceChange {
  productId: string;
  beforeUnitValuePen: { toString(): string };
  afterUnitValuePen: { toString(): string };
  changedAt: Date;
}

/**
 * D-264 (P2-2 del delta RF-S4b): **los productos que alguien editó a propósito** en un documento.
 *
 * Por contenido, no por número de línea: la cotización recrea sus líneas en cada guardado, así
 * que el número (y el id) de la línea editada envejece con la siguiente edición. Un producto
 * cuenta como editado si algún cambio registrado de ese producto dejó como precio el que alguna
 * de sus líneas tiene **hoy** — la edición sigue vigente.
 *
 * Si el documento tiene dos líneas del mismo producto y solo una coincide, **las dos** cuentan:
 * no hay forma de saber cuál se editó, y el barrido nunca pisa un precio que alguien cambió.
 *
 * P2-C (autorrevisión del PR #16): una línea que **volvió** al precio con que se importó
 * (Y → X → Y) no está editada: su precio es el del papel y su redondeo lo corrige el barrido. El
 * precio de origen es el «antes» del primer cambio registrado de ese producto.
 */
export function deliberatelyEditedProducts(
  changes: readonly RecordedPriceChange[],
  lines: readonly { productId: string; unitPricePen: { toString(): string } }[],
): Set<string> {
  const origin = new Map<string, RecordedPriceChange>();
  for (const change of changes) {
    const first = origin.get(change.productId);
    if (!first || change.changedAt < first.changedAt) origin.set(change.productId, change);
  }
  const edited = new Set<string>();
  for (const change of changes) {
    const after = toDecimal(change.afterUnitValuePen.toString());
    const imported = toDecimal(
      (origin.get(change.productId) ?? change).beforeUnitValuePen.toString(),
    );
    const stillInForce = lines.some(
      (l) =>
        l.productId === change.productId &&
        toDecimal(l.unitPricePen.toString()).equals(after) &&
        !after.equals(imported),
    );
    if (stillInForce) edited.add(change.productId);
  }
  return edited;
}

@Injectable()
export class ImportedDocumentsSweepService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quotations: QuotationsService,
    private readonly edits: SalesOrderEditsService,
  ) {}

  /** Dry-run: el reporte, sin escribir nada. */
  async report(paper: readonly PaperLine[]): Promise<SweepReport> {
    const byKey = new Map<string, PaperLine[]>();
    for (const line of paper) {
      if (line.excluded) continue;
      byKey.set(line.documentKey, [...(byKey.get(line.documentKey) ?? []), line]);
    }
    const known = await knownCoilAttributes(this.prisma);

    const quotations = await this.prisma.quotation.findMany({
      where: { notes: { startsWith: EXTERNAL_INVOICE_NOTES_PREFIX } },
      select: {
        id: true,
        seq: true,
        status: true,
        notes: true,
        items: { select: LINE_SELECT, orderBy: { lineNumber: 'asc' } },
      },
      orderBy: { seq: 'asc' },
    });
    const orders = await this.prisma.salesOrder.findMany({
      where: { notes: { startsWith: EXTERNAL_INVOICE_NOTES_PREFIX } },
      select: {
        id: true,
        seq: true,
        status: true,
        notes: true,
        quotationId: true,
        items: { select: LINE_SELECT, orderBy: { lineNumber: 'asc' } },
        fiscalDocuments: {
          where: {
            docType: { in: [FiscalDocType.FACTURA, FiscalDocType.BOLETA] },
            status: { in: [...STANDING_DOCUMENT_STATUSES] },
            archivedAt: null,
          },
          select: { id: true },
        },
      },
      orderBy: { seq: 'asc' },
    });

    // Repaso de RF-S4b: las líneas con una edición de precio registrada (D-187) después de la
    // importación. Un pedido hereda las de la cotización de la que salió.
    const edits = await this.prisma.salesPriceChange.findMany({
      where: {
        OR: [
          { quotationId: { in: quotations.map((q) => q.id) } },
          { quotationId: { in: orders.flatMap((o) => (o.quotationId ? [o.quotationId] : [])) } },
          { salesOrderId: { in: orders.map((o) => o.id) } },
        ],
      },
      select: {
        quotationId: true,
        salesOrderId: true,
        productId: true,
        beforeUnitValuePen: true,
        afterUnitValuePen: true,
        changedAt: true,
      },
    });
    // D-264: los que dejó el execute de un barrido anterior no son ediciones de una persona.
    const sweepAudits = await this.prisma.auditLog.findMany({
      where: {
        reason: SWEEP_AUDIT_REASON,
        entity: { in: ['quotations', 'sales_orders'] },
        entityId: { in: [...new Set(edits.map((e) => e.quotationId ?? e.salesOrderId ?? ''))] },
      },
      select: { entityId: true, at: true },
    });
    const humanEdits = edits.filter((e) => !isSweepPriceChange(e, sweepAudits));
    const editedProducts = (ids: (string | null)[], items: readonly DocLine[]): Set<string> =>
      deliberatelyEditedProducts(
        humanEdits.filter((e) =>
          ids.some((id) => id !== null && (e.quotationId === id || e.salesOrderId === id)),
        ),
        items,
      );

    const documents: SweepDocument[] = [];
    for (const q of quotations) {
      documents.push(
        await this.review(
          {
            kind: 'COTIZACION',
            id: q.id,
            code: quotationCode(q.seq),
            status: q.status,
            notes: q.notes,
            open: OPEN_QUOTATION.has(q.status),
            items: q.items,
            scope: { exceptQuotationIds: [q.id] },
            editedProducts: editedProducts([q.id], q.items),
          },
          byKey,
          known,
        ),
      );
    }
    for (const o of orders) {
      documents.push(
        await this.review(
          {
            kind: 'PEDIDO',
            id: o.id,
            code: salesOrderCode(o.seq),
            status: o.status,
            notes: o.notes,
            open: OPEN_ORDER.has(o.status) && o.fiscalDocuments.length === 0,
            items: o.items,
            scope: { exceptSalesOrderIds: [o.id] },
            editedProducts: editedProducts([o.id, o.quotationId], o.items),
          },
          byKey,
          known,
        ),
      );
    }
    dropSharedAutoCoils(documents);
    return { documents, reviewed: documents.length };
  }

  /**
   * Corrige los documentos **abiertos**: ata a la bobina única y restablece importes del papel.
   * Un documento con alguna línea que no se puede resolver sola **no se toca entero** —queda en
   * (c)—, para no dejarlo a medio corregir.
   */
  async execute(actor: RequestUser, paper: readonly PaperLine[]): Promise<SweepExecution> {
    const report = await this.report(paper);
    const fixed: SweepExecution['fixed'] = [];
    const failed: SweepExecution['failed'] = [];
    const reason = SWEEP_AUDIT_REASON;
    for (const doc of report.documents) {
      if (!doc.open || doc.unmatched !== null || doc.findings.length === 0) continue;
      if (
        doc.findings.some(
          (f) => f.unpaired !== null || (f.product !== null && f.product.autoCoilId === null),
        )
      ) {
        continue;
      }
      try {
        await this.fixDocument(actor, doc, reason);
        fixed.push({
          kind: doc.kind,
          code: doc.code,
          lines: doc.findings.map((f) => f.lineNumber),
        });
      } catch (err) {
        // Un documento que el dominio rechaza (p. ej. la bobina ya no alcanza) no tumba el resto:
        // se reporta con el motivo y queda en (c). Cada corrección es su propia transacción.
        if (!(err instanceof HttpException)) throw err;
        failed.push({ kind: doc.kind, code: doc.code, reason: err.message });
      }
    }
    const after = await this.report(paper);
    return {
      fixed,
      failed,
      pending: after.documents.filter((d) => d.open && (d.findings.length > 0 || d.unmatched)),
    };
  }

  private async fixDocument(actor: RequestUser, doc: SweepDocument, reason: string): Promise<void> {
    if (doc.kind === 'COTIZACION') {
      await this.fixQuotation(actor, doc, reason);
      return;
    }
    // Un pedido se corrige **entero o nada**: una sola transacción para todas sus líneas, así
    // un rechazo en la línea 2 no deja la 1 corregida (autorrevisión RF-S4b, P1).
    await this.prisma.$transaction(
      async (tx) => {
        for (const f of doc.findings) {
          const line = await tx.salesOrderItem.findFirstOrThrow({
            where: { salesOrderId: doc.id, lineNumber: f.lineNumber },
            select: { id: true },
          });
          if (f.product?.autoCoilId) {
            await this.edits.updateItemCoilInTx(tx, actor, doc.id, line.id, {
              saleCoilId: f.product.autoCoilId,
              reason,
            });
          }
          if (f.amounts) {
            await this.edits.restorePaperAmountsInTx(
              tx,
              actor,
              doc.id,
              line.id,
              {
                netAmountPen: f.amounts.paper.net,
                ...(f.amounts.paper.igv !== null && f.amounts.paper.total !== null
                  ? { igvAmountPen: f.amounts.paper.igv, totalAmountPen: f.amounts.paper.total }
                  : {}),
              },
              reason,
              // D-264 (P2-3): solo en `audit_log`, nunca como cambio de precio de una persona.
              { recordPriceChange: false },
            );
          }
        }
      },
      { timeout: 60_000 },
    );
  }

  private async review(
    doc: {
      kind: SweepDocKind;
      id: string;
      code: string;
      status: string;
      notes: string | null;
      open: boolean;
      items: DocLine[];
      scope: { exceptQuotationIds?: string[]; exceptSalesOrderIds?: string[] };
      /** D-264: productos con una edición de precio registrada que sigue vigente. */
      editedProducts: ReadonlySet<string>;
    },
    byKey: ReadonlyMap<string, PaperLine[]>,
    known: ReadonlySet<string>,
  ): Promise<SweepDocument> {
    const externalKey = externalInvoiceOf(doc.notes) ?? '';
    const base = {
      kind: doc.kind,
      id: doc.id,
      code: doc.code,
      status: doc.status,
      externalKey,
      open: doc.open,
    };
    const paper = byKey.get(externalKey);
    if (!paper) {
      return {
        ...base,
        unmatched: `${externalKey} no está en el archivo`,
        findings: [],
        unpairedPaperRows: [],
      };
    }

    // Revisión cruzada RF-S4b (P1-1): la línea se empareja con la fila del papel por **producto
    // normalizado y cantidad** —y el importe desempata—, nunca por posición. Por posición, dos
    // líneas con la misma cantidad en otro orden recibían el importe de la otra, y una línea
    // común caída frente a un `BOB…` del papel se convertía en venta de bobina.
    const paperKeys = paper.map((p) => paperProductKey(p, known));
    const lineKeys = await Promise.all(doc.items.map((l) => this.lineProductKey(l)));
    const pairing = pairLines(doc.items, lineKeys, paper, paperKeys);

    const findings: SweepLineFinding[] = [];
    for (const [i, line] of doc.items.entries()) {
      const pair = pairing[i];
      if (pair?.paperIndex === undefined || pair.paperIndex === null) {
        findings.push({
          lineNumber: line.lineNumber,
          productSku: line.product.sku,
          newSku: line.product.sku,
          paperSku: null,
          product: null,
          unpaired: pair?.reason ?? 'sin pareja en el papel',
          amounts: null,
        });
        continue;
      }
      const source = paper[pair.paperIndex];
      if (!source) continue;
      const product = await this.productFinding(line, lineKeys[i] ?? '', doc.scope);
      const amounts = amountsFinding(line, source);
      // Repaso de RF-S4b (P2-1): una diferencia de importe mayor de lo que puede explicar el
      // redondeo (la cota de D-169) no es el defecto que corrige el barrido: es un precio que
      // alguien cambió a propósito. No se pisa: queda en (c) para el dueño.
      const deliberate =
        amounts !== null &&
        toDecimal(amounts.stored.net)
          .minus(toDecimal(amounts.paper.net))
          .abs()
          .gt(importRoundingTolerance([line.qty.toString()]));
      if (product || amounts) {
        findings.push({
          lineNumber: line.lineNumber,
          productSku: line.product.sku,
          newSku: product?.autoCoilId ? (lineKeys[i] ?? line.product.sku) : line.product.sku,
          paperSku: source.rawSku,
          product,
          unpaired:
            amounts !== null && doc.editedProducts.has(line.productId)
              ? 'editada a propósito: tiene una edición de precio registrada después de la importación'
              : deliberate
                ? `el importe guardado (${amounts.stored.net}) difiere del papel (${amounts.paper.net}) más de lo que explica el redondeo: parece un precio cambiado a propósito`
                : null,
          amounts,
        });
      }
    }
    const paired = new Set(pairing.flatMap((p) => (p.paperIndex === null ? [] : [p.paperIndex])));
    const unpairedPaperRows = paper.flatMap((p, i) => (paired.has(i) ? [] : [p.rowNumber]));
    return { ...base, unmatched: null, findings, unpairedPaperRows };
  }

  /**
   * El producto **normalizado** de una línea del documento, para emparejarla con el papel. Una
   * línea que vende una bobina, o que está enganchada a un producto de venta de bobina, se
   * compara por el SKU canónico de su pool (D-252); cualquier otra, por su SKU.
   */
  private async lineProductKey(line: DocLine): Promise<string> {
    if (line.reserveItemType === InventoryItemType.COIL || isCoilSaleProduct(line.product)) {
      const pool = await lineCoilPool(this.prisma, line);
      if (pool !== null) return pool.sku;
    }
    return normalizedSku(line.product.sku);
  }

  /**
   * (a) La línea que R1 resolvería distinto, con la bobina a la que se ataría. Solo una línea
   * enganchada a un **producto de venta de bobina** se ata a una bobina: una línea común nunca
   * se convierte en venta de bobina (revisión cruzada RF-S4b, P1-1).
   */
  private async productFinding(
    line: DocLine,
    lineKey: string,
    scope: { exceptQuotationIds?: string[]; exceptSalesOrderIds?: string[] },
  ): Promise<SweepLineFinding['product']> {
    if (line.reserveItemType !== InventoryItemType.COIL && isCoilSaleProduct(line.product)) {
      const key = await lineCoilPool(this.prisma, line);
      if (key === null) {
        return {
          reason: `${line.product.sku}: su color o tipo no se interpreta`,
          autoCoilId: null,
          autoCoilCode: null,
          candidates: 0,
        };
      }
      const pool = await coilPoolFor(this.prisma, key, line.qty.toString(), scope);
      const auto = pool.candidates.find((c) => c.coilId === pool.autoCoilId) ?? null;
      return {
        reason: `${line.product.sku} no vende una bobina del pool ${lineKey}`,
        autoCoilId: auto?.coilId ?? null,
        autoCoilCode: auto?.code ?? null,
        candidates: pool.candidates.length,
      };
    }
    if (!line.product.isActive && line.product.mergedIntoId !== null) {
      return {
        reason: `${line.product.sku} está unido a otro producto`,
        autoCoilId: null,
        autoCoilCode: null,
        candidates: 0,
      };
    }
    return null;
  }

  /**
   * Rehace las líneas de una cotización abierta con la bobina y los importes del papel. Cada
   * línea toma **su** hallazgo —el papel con el que se emparejó—, nunca la fila de su posición.
   */
  private async fixQuotation(
    actor: RequestUser,
    doc: SweepDocument,
    reason: string,
  ): Promise<void> {
    const q = await this.prisma.quotation.findUniqueOrThrow({
      where: { id: doc.id },
      select: {
        customerId: true,
        issueDate: true,
        notes: true,
        items: { select: LINE_SELECT, orderBy: { lineNumber: 'asc' } },
      },
    });
    const byLine = new Map(doc.findings.map((f) => [f.lineNumber, f]));
    const items: SalesItemInput[] = q.items.map((line) => {
      const finding = byLine.get(line.lineNumber);
      const paper = finding?.amounts?.paper;
      const paperAmounts = paper
        ? {
            netAmountPen: paper.net,
            ...(paper.igv !== null && paper.total !== null
              ? { igvAmountPen: paper.igv, totalAmountPen: paper.total }
              : {}),
          }
        : {
            netAmountPen: line.subtotalPen.toFixed(4),
            igvAmountPen: line.igvPen.toFixed(4),
            totalAmountPen: line.totalPen.toFixed(4),
          };
      const qty = line.qty.toString();
      if (finding?.product?.autoCoilId && isCoilSaleProduct(line.product)) {
        return {
          saleCoilId: finding.product.autoCoilId,
          qty,
          description: line.description,
          ...paperAmounts,
        };
      }
      if (line.reserveItemType === InventoryItemType.COIL) {
        return {
          saleCoilId: line.reserveItemId,
          qty,
          description: line.description,
          ...paperAmounts,
        };
      }
      return {
        productId: line.productId,
        qty,
        description: line.description,
        ...paperAmounts,
        ...(line.pieces.length > 0
          ? { pieces: line.pieces.map((p) => ({ lengthMm: p.lengthMm.toFixed(2), qty: p.qty })) }
          : {}),
      };
    });
    await this.quotations.update(
      actor,
      doc.id,
      {
        customerId: q.customerId,
        issueDate: fromDateOnly(q.issueDate),
        // Sin efecto en una importada: su vencimiento es `null` y la edición lo conserva (D-157).
        validityDays: 7,
        ...(q.notes ? { notes: q.notes } : {}),
        items,
      },
      // D-264 (P2-3): la corrección del barrido queda en `audit_log` con su motivo, no como un
      // cambio de precio del ADMINISTRADOR: si no, la próxima corrida la leería como edición.
      { auditReason: reason, recordPriceChanges: false },
    );
  }
}

/** El SKU tal como se compara: sin espacios a los costados y en mayúsculas. */
function normalizedSku(sku: string): string {
  return sku.trim().toUpperCase();
}

/**
 * El producto normalizado de una fila del papel, con la misma regla que el importador: un
 * código de bobina (`BOB…`, o una descripción de bobina) que el normalizador interpreta es su
 * SKU canónico; cualquier otro código se compara tal cual.
 */
function paperProductKey(line: PaperLine, known: ReadonlySet<string>): string {
  if (/^\s*BOB/i.test(line.rawSku) || /\bBOBINA\b/i.test(line.productName)) {
    const parsed = normalizeCoilSku({ code: line.rawSku, description: line.productName }, known);
    if (parsed.ok) return parsed.sku;
  }
  return normalizedSku(line.rawSku);
}

interface LinePairing {
  /** Índice de la fila del papel, o `null` si no hay una única. */
  paperIndex: number | null;
  reason: string | null;
}

/**
 * Empareja cada línea del documento con **una única** fila del papel: mismo producto
 * normalizado y misma cantidad; si hay varias, la del mismo importe. Si aun así no es única, o
 * si dos líneas eligen la misma fila, ninguna de las dos se empareja: la posición nunca decide.
 */
function pairLines(
  items: readonly DocLine[],
  lineKeys: readonly string[],
  paper: readonly PaperLine[],
  paperKeys: readonly string[],
): LinePairing[] {
  const choice = items.map((line, i): LinePairing => {
    const qty = toDecimal(line.qty.toString());
    const candidates = paper.flatMap((p, j) =>
      paperKeys[j] === lineKeys[i] && p.qty !== null && toDecimal(p.qty).equals(qty) ? [j] : [],
    );
    if (candidates.length === 0) {
      return {
        paperIndex: null,
        reason: `ninguna línea del papel tiene su producto (${lineKeys[i] ?? ''}) y su cantidad (${line.qty.toFixed(3)})`,
      };
    }
    if (candidates.length === 1) return { paperIndex: candidates[0] ?? null, reason: null };
    const stored = toDecimal(line.subtotalPen.toString());
    const byAmount = candidates.filter((j) => {
      const net = paper[j]?.netAmountPen;
      return net !== null && net !== undefined && toDecimal(net).equals(stored);
    });
    if (byAmount.length === 1) return { paperIndex: byAmount[0] ?? null, reason: null };
    return {
      paperIndex: null,
      reason: `${String(candidates.length)} líneas del papel tienen su producto y su cantidad, y el importe no las distingue: no se elige por posición`,
    };
  });
  const claims = new Map<number, number>();
  for (const c of choice) {
    if (c.paperIndex !== null) claims.set(c.paperIndex, (claims.get(c.paperIndex) ?? 0) + 1);
  }
  return choice.map((c) =>
    c.paperIndex !== null && (claims.get(c.paperIndex) ?? 0) > 1
      ? {
          paperIndex: null,
          reason: 'otra línea del documento se empareja con la misma línea del papel',
        }
      : c,
  );
}

/** (b) El importe guardado contra el del papel. */
function amountsFinding(line: DocLine, source: PaperLine): SweepLineFinding['amounts'] {
  if (source.netAmountPen === null) return null;
  const stored = {
    net: line.subtotalPen.toFixed(4),
    igv: line.igvPen.toFixed(4),
    total: line.totalPen.toFixed(4),
  };
  const netDiffers = !toDecimal(stored.net).equals(toDecimal(source.netAmountPen));
  const tripletDiffers =
    source.igvAmountPen !== null &&
    source.totalAmountPen !== null &&
    (!toDecimal(stored.igv).equals(toDecimal(source.igvAmountPen)) ||
      !toDecimal(stored.total).equals(toDecimal(source.totalAmountPen)));
  if (!netDiffers && !tripletDiffers) return null;
  return {
    stored,
    paper: { net: source.netAmountPen, igv: source.igvAmountPen, total: source.totalAmountPen },
  };
}

/**
 * Dos líneas del barrido no pueden quedarse con la misma bobina: la elección automática que se
 * repite queda para el dueño (misma regla que el importador).
 */
function dropSharedAutoCoils(documents: SweepDocument[]): void {
  // Un documento cerrado o anulado solo se reporta: nunca se ata a una bobina, así que no
  // compite por ella. Sin esto, en el ensayo en demo COT-000074 (anulada) le quitaba la bobina
  // exacta a COT-000002 (abierta) y la mandaba a «elige a mano».
  for (const f of documents.filter((d) => !d.open).flatMap((d) => d.findings)) {
    if (f.product?.autoCoilId) {
      f.product.autoCoilId = null;
      f.product.autoCoilCode = null;
      f.product.reason += ' (documento cerrado: solo se reporta)';
    }
  }
  const count = new Map<string, number>();
  for (const f of documents.filter((d) => d.open).flatMap((d) => d.findings)) {
    const id = f.product?.autoCoilId;
    if (id) count.set(id, (count.get(id) ?? 0) + 1);
  }
  for (const f of documents.flatMap((d) => d.findings)) {
    if (f.product?.autoCoilId && (count.get(f.product.autoCoilId) ?? 0) > 1) {
      f.product.autoCoilId = null;
      f.product.autoCoilCode = null;
      f.product.reason += ' (la misma bobina es candidata única de otra línea: elige a mano)';
    }
  }
}
