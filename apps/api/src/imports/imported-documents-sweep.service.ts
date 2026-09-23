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
  normalizeCoilSku,
  quotationCode,
  salesOrderCode,
  STANDING_DOCUMENT_STATUSES,
  toDecimal,
  type SalesItemInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { coilPoolFor, isCoilSaleProduct, knownCoilAttributes } from '../sales/coil-sale-product';
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
  productSku: string;
  /** (a): la línea no vende la bobina del pool, o su producto está unido a otro. */
  product: {
    reason: string;
    /** La bobina a la que el execute la ataría; `null` si hay que elegirla a mano. */
    autoCoilId: string | null;
    autoCoilCode: string | null;
    candidates: number;
  } | null;
  /**
   * La cantidad de la línea no es la del papel (alguien la editó a propósito). El importe del
   * papel no se le puede pegar —describe otra cantidad—, así que la línea queda para el dueño.
   */
  qtyMismatch: { paper: string; stored: string } | null;
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
  /** Algo que impide comparar el documento contra el papel (no está, o no coinciden las líneas). */
  unmatched: string | null;
  findings: SweepLineFinding[];
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
    const reason = 'Barrido de lo importado (RF-S4b): comprobante de origen';
    for (const doc of report.documents) {
      if (!doc.open || doc.unmatched !== null || doc.findings.length === 0) continue;
      if (
        doc.findings.some(
          (f) => f.qtyMismatch !== null || (f.product !== null && f.product.autoCoilId === null),
        )
      ) {
        continue;
      }
      try {
        await this.fixDocument(actor, doc, paper, reason);
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

  private async fixDocument(
    actor: RequestUser,
    doc: SweepDocument,
    paper: readonly PaperLine[],
    reason: string,
  ): Promise<void> {
    if (doc.kind === 'COTIZACION') {
      await this.fixQuotation(actor, doc, paper);
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
    if (!paper) return { ...base, unmatched: `${externalKey} no está en el archivo`, findings: [] };
    if (paper.length !== doc.items.length) {
      return {
        ...base,
        unmatched: `El archivo tiene ${String(paper.length)} línea(s) de ${externalKey} y el documento ${String(doc.items.length)}`,
        findings: [],
      };
    }

    const findings: SweepLineFinding[] = [];
    for (const [i, line] of doc.items.entries()) {
      const source = paper[i];
      if (!source) continue;
      const product = await this.productFinding(line, source, known, doc.scope);
      const qtyMismatch =
        source.qty !== null && !toDecimal(source.qty).equals(toDecimal(line.qty.toString()))
          ? { paper: source.qty, stored: line.qty.toFixed(3) }
          : null;
      // Con la cantidad cambiada, el importe del papel describe otra línea: no se propone.
      const amounts = qtyMismatch === null ? amountsFinding(line, source) : null;
      if (product || amounts || qtyMismatch) {
        findings.push({
          lineNumber: line.lineNumber,
          productSku: line.product.sku,
          product,
          qtyMismatch,
          amounts,
        });
      }
    }
    return { ...base, unmatched: null, findings };
  }

  /** (a) La línea que R1 resolvería distinto, con la bobina a la que se ataría. */
  private async productFinding(
    line: DocLine,
    source: PaperLine,
    known: ReadonlySet<string>,
    scope: { exceptQuotationIds?: string[]; exceptSalesOrderIds?: string[] },
  ): Promise<SweepLineFinding['product']> {
    const parsed = normalizeCoilSku(
      { code: source.rawSku, description: source.productName },
      known,
    );
    const coilish = parsed.ok || /^\s*BOB/i.test(source.rawSku) || isCoilSaleProduct(line.product);
    if (coilish && line.reserveItemType !== InventoryItemType.COIL) {
      if (!parsed.ok) {
        return { reason: parsed.reason, autoCoilId: null, autoCoilCode: null, candidates: 0 };
      }
      const pool = await coilPoolFor(
        this.prisma,
        { thicknessMm: parsed.thicknessMm, attribute: parsed.attribute },
        line.qty.toString(),
        scope,
      );
      const auto = pool.candidates.find((c) => c.coilId === pool.autoCoilId) ?? null;
      return {
        reason: `${line.product.sku} no vende una bobina del pool ${parsed.sku}`,
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

  /** Rehace las líneas de una cotización abierta con la bobina y los importes del papel. */
  private async fixQuotation(
    actor: RequestUser,
    doc: SweepDocument,
    paper: readonly PaperLine[],
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
    const source = paper.filter((p) => !p.excluded && p.documentKey === doc.externalKey);
    const byLine = new Map(doc.findings.map((f) => [f.lineNumber, f]));
    const items: SalesItemInput[] = q.items.map((line, i) => {
      const finding = byLine.get(line.lineNumber);
      const src = source[i];
      const paperAmounts =
        finding?.amounts && src?.netAmountPen
          ? {
              netAmountPen: src.netAmountPen,
              ...(src.igvAmountPen && src.totalAmountPen
                ? { igvAmountPen: src.igvAmountPen, totalAmountPen: src.totalAmountPen }
                : {}),
            }
          : {
              netAmountPen: line.subtotalPen.toFixed(4),
              igvAmountPen: line.igvPen.toFixed(4),
              totalAmountPen: line.totalPen.toFixed(4),
            };
      const qty = line.qty.toString();
      if (finding?.product?.autoCoilId) {
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
    await this.quotations.update(actor, doc.id, {
      customerId: q.customerId,
      issueDate: fromDateOnly(q.issueDate),
      // Sin efecto en una importada: su vencimiento es `null` y la edición lo conserva (D-157).
      validityDays: 7,
      ...(q.notes ? { notes: q.notes } : {}),
      items,
    });
  }
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
  const count = new Map<string, number>();
  for (const f of documents.flatMap((d) => d.findings)) {
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
