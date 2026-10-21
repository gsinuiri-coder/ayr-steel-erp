import { HttpException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';
import {
  cancelProductionOrderSchema,
  confirmPurchaseImportSchema,
  createCustomerPaymentSchema,
  createDispatchSchema,
  createInvoiceSchema,
  createSupplierPaymentSchema,
  Decimal,
  detailsLengths,
  EXTERNAL_INVOICE_NOTES_PREFIX,
  fiscalDocumentNumber,
  importQuotationsSchema,
  isAccessory,
  mountRoofingCoilSchema,
  normalizePurchaseNumber,
  reportAndCloseRoofingSchema,
  reportRoofingPiecesSchema,
  reverseMovementSchema,
  toDecimal,
  type QuotationImportRowDto,
} from '@ayr/shared';
import type { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import type { DispatchesService } from '../invoicing/dispatches.service';
import type { FiscalImportService } from '../invoicing/fiscal-import.service';
import type { InvoicingService } from '../invoicing/invoicing.service';
import type { ReceivablesService } from '../invoicing/receivables.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RoofingProductionService } from '../production/roofing-production.service';
import type { PurchasesService } from '../purchases/purchases.service';
import type { QuotationsService } from '../sales/quotations.service';
import type { SalesOrdersService } from '../sales/sales-orders.service';
import { LOAD_COLUMNS, metersOf, parseLengths } from './backdated-load';
import {
  idempotencyKeyOf,
  LOAD_STEP_LABELS,
  type LoadOp,
  type LoadStep,
} from './backdated-load-ops';
import { parseMethod } from './opening-balances-plan';
import { parsePurchaseRows } from './purchase-import-parse';
import type { PurchaseImportService } from './purchase-import.service';
import type { QuotationImportService } from './quotation-import.service';
import { getField } from './parse-spreadsheet';

/**
 * cc64 (D-705) — **el cargador de la carga atrasada** (`pnpm carga:ejecutar` / `carga:revertir`).
 *
 * Ejecuta las operaciones de `planLoadOps` por los servicios de dominio de la app (nunca SQL que
 * escriba), como el ADMINISTRADOR que corre la CLI. El lote vive en `audit_log` (sin migración,
 * como D-668): una fila de inicio con el archivo y su huella, y una por operación hecha con su clave
 * estable y los ids que creó. Para reanudar, se salta lo que está en el manifiesto y, si una
 * operación quedó hecha sin anotar (un corte entre las dos escrituras), se la reconoce por su clave
 * natural o por la clave de idempotencia del lote. Ante la primera falla, para.
 */
export const LOAD_ENTITY = 'backdated_load_batches';
export const LOAD_START_ACTION = 'imports.backdated-load';
export const LOAD_OP_ACTION = 'imports.backdated-load.op';
export const LOAD_REVERTED_ACTION = 'imports.backdated-load.op-reverted';

/** Lo que una operación creó o adoptó: lo necesita la reversa. */
export type OpIds = Record<string, string | boolean | null>;

export interface LoadManifest {
  start: { fileName: string; sha256: string } | null;
  /** Operaciones hechas (y no revertidas), en el orden en que se hicieron. */
  done: Map<string, { step: LoadStep; ids: OpIds }>;
  reverted: Set<string>;
}

export interface LoadDeps {
  prisma: PrismaService;
  audit: Pick<AuditService, 'write' | 'log'>;
  purchaseImport: Pick<PurchaseImportService, 'confirm'>;
  purchases: Pick<PurchasesService, 'receive' | 'cancel' | 'addPayment' | 'reversePayment'>;
  quotationImport: Pick<QuotationImportService, 'preview' | 'confirm'>;
  quotations: Pick<QuotationsService, 'cancel'>;
  salesOrders: Pick<SalesOrdersService, 'confirm' | 'cancel'>;
  roofing: Pick<
    RoofingProductionService,
    'mountCoil' | 'report' | 'reportAndClose' | 'reopen' | 'reverseReport' | 'cancel'
  >;
  dispatches: Pick<DispatchesService, 'create' | 'reverse'>;
  invoicing: Pick<InvoicingService, 'create' | 'registerManual'>;
  fiscalImport: Pick<FiscalImportService, 'annulExternal'>;
  receivables: Pick<ReceivablesService, 'addPayment' | 'reversePayment'>;
}

export interface LoadFailure {
  key: string;
  step: LoadStep;
  rows: { sheet: string; row: number }[];
  message: string;
}

export interface LoadRunResult {
  executed: string[];
  skipped: string[];
  failure: LoadFailure | null;
  ms: number;
}

/** El origen de un despacho de la carga: el recojo por defecto de la app (`dispatches.service`). */
export const LOAD_PICKUP = { address: 'Mostrador — recojo en tienda', ubigeo: '150101' };

const reasonOf = (batchId: string) => `Reversa de la carga atrasada ${batchId}`;

function messageOf(err: unknown): string {
  if (err instanceof HttpException) {
    const body = err.getResponse();
    if (typeof body === 'object' && body !== null && 'message' in body) {
      const m = body.message;
      return Array.isArray(m) ? m.join(' · ') : String(m);
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** El manifiesto del lote, leído de `audit_log`. */
export async function readManifest(
  db: Prisma.TransactionClient,
  batchId: string,
): Promise<LoadManifest> {
  const rows = await db.auditLog.findMany({
    where: { entity: LOAD_ENTITY, entityId: batchId },
    orderBy: { id: 'asc' },
    select: { action: true, after: true },
  });
  const manifest: LoadManifest = { start: null, done: new Map(), reverted: new Set() };
  for (const r of rows) {
    const after = (r.after ?? {}) as Record<string, unknown>;
    if (r.action === LOAD_START_ACTION && manifest.start === null) {
      manifest.start = {
        fileName: typeof after.fileName === 'string' ? after.fileName : '',
        sha256: typeof after.sha256 === 'string' ? after.sha256 : '',
      };
    } else if (r.action === LOAD_OP_ACTION) {
      const key = String(after.key);
      // La primera anotación manda: una segunda (la misma operación reconocida tras un corte) diría
      // «adoptada» y la reversa saltaría lo que este lote sí creó.
      if (!manifest.done.has(key)) {
        manifest.done.set(key, { step: after.step as LoadStep, ids: (after.ids ?? {}) as OpIds });
      }
      manifest.reverted.delete(key);
    } else if (r.action === LOAD_REVERTED_ACTION) {
      const key = String(after.key);
      manifest.reverted.add(key);
      manifest.done.delete(key);
    }
  }
  return manifest;
}

export class BackdatedLoadRunner {
  constructor(
    private readonly deps: LoadDeps,
    private readonly actor: RequestUser,
    private readonly batchId: string,
  ) {}

  private get db(): PrismaService {
    return this.deps.prisma;
  }

  private key(op: LoadOp, part = ''): string {
    return idempotencyKeyOf(this.batchId, op.key, part);
  }

  /** Anota el inicio del lote (una vez). */
  async start(fileName: string, sha256: string, ops: number): Promise<void> {
    await this.deps.audit.log({
      actorId: this.actor.id,
      action: LOAD_START_ACTION,
      entity: LOAD_ENTITY,
      entityId: this.batchId,
      after: { fileName, sha256, ops },
    });
  }

  /** Ejecuta las operaciones que faltan; para en la primera que falle. */
  async execute(ops: readonly LoadOp[], manifest: LoadManifest): Promise<LoadRunResult> {
    const t0 = Date.now();
    const executed: string[] = [];
    const skipped: string[] = [];
    for (const op of ops) {
      if (manifest.done.has(op.key)) {
        skipped.push(op.key);
        continue;
      }
      let ids: OpIds;
      try {
        ids = await this.run(op);
      } catch (err) {
        return {
          executed,
          skipped,
          failure: { key: op.key, step: op.step, rows: op.rows, message: messageOf(err) },
          ms: Date.now() - t0,
        };
      }
      await this.deps.audit.log({
        actorId: this.actor.id,
        action: LOAD_OP_ACTION,
        entity: LOAD_ENTITY,
        entityId: this.batchId,
        after: { key: op.key, step: op.step, ids },
      });
      manifest.done.set(op.key, { step: op.step, ids });
      executed.push(op.key);
    }
    return { executed, skipped, failure: null, ms: Date.now() - t0 };
  }

  /** Revierte lo hecho por el lote, de la última operación a la primera. */
  async revert(manifest: LoadManifest): Promise<LoadRunResult> {
    const t0 = Date.now();
    const executed: string[] = [];
    const entries = [...manifest.done.entries()].reverse();
    for (const [key, { step, ids }] of entries) {
      try {
        await this.undo(step, ids);
      } catch (err) {
        return {
          executed,
          skipped: [],
          failure: { key, step, rows: [], message: messageOf(err) },
          ms: Date.now() - t0,
        };
      }
      await this.deps.audit.log({
        actorId: this.actor.id,
        action: LOAD_REVERTED_ACTION,
        entity: LOAD_ENTITY,
        entityId: this.batchId,
        after: { key, step },
      });
      manifest.done.delete(key);
      manifest.reverted.add(key);
      executed.push(key);
    }
    return { executed, skipped: [], failure: null, ms: Date.now() - t0 };
  }

  // ---------------------------------------------------------------------------------------------
  // Ejecutar
  // ---------------------------------------------------------------------------------------------

  private async run(op: LoadOp): Promise<OpIds> {
    switch (op.step) {
      case 'purchases':
        return this.runPurchase(op);
      case 'sales':
        return this.runSale(op);
      case 'orders':
        return this.runOrder(op);
      case 'production':
        return this.runProduction(op);
      case 'dispatches':
        return this.runDispatch(op);
      case 'invoices':
        return this.runInvoice(op);
      case 'collections':
        return this.runCollection(op);
      case 'supplierPayments':
        return this.runSupplierPayment(op);
    }
  }

  private async findPurchase(ruc: string, document: string) {
    const dash = document.indexOf('-');
    const series = dash < 0 ? '' : document.slice(0, dash);
    const number = normalizePurchaseNumber(dash < 0 ? document : document.slice(dash + 1));
    return this.db.purchase.findFirst({
      where: { supplier: { docNumber: ruc }, series, number, status: { not: 'CANCELLED' } },
      select: { id: true, status: true, currency: true, exchangeRate: true },
    });
  }

  private async runPurchase(op: Extract<LoadOp, { step: 'purchases' }>): Promise<OpIds> {
    let purchase = await this.findPurchase(op.supplierRuc, op.document);
    let adopted = purchase !== null;
    if (!purchase) {
      const parsed = parsePurchaseRows(op.raws);
      await this.deps.purchaseImport.confirm(
        this.actor,
        confirmPurchaseImportSchema.parse({
          documents: parsed.documents,
          fileName: `carga ${this.batchId}`,
          idempotencyKey: this.key(op),
        }),
      );
      purchase = await this.findPurchase(op.supplierRuc, op.document);
      adopted = false;
      if (!purchase) throw new Error(`la compra ${op.document} no quedó registrada`);
    }
    if (purchase.status === 'DRAFT') {
      await this.deps.purchases.receive(this.actor, purchase.id, {
        operationDate: op.receivedDate,
        confirmBackdate: true,
      });
    }
    return { purchaseId: purchase.id, adopted };
  }

  private async findQuotation(document: string) {
    const note = `${EXTERNAL_INVOICE_NOTES_PREFIX}${document}`;
    return this.db.quotation.findFirst({
      where: {
        status: { not: 'CANCELLED' },
        OR: [{ notes: note }, { notes: { startsWith: `${note}\n` } }],
      },
      select: { id: true, status: true },
    });
  }

  private async runSale(op: Extract<LoadOp, { step: 'sales' }>): Promise<OpIds> {
    const existing = await this.findQuotation(op.document);
    if (existing) return { quotationId: existing.id, adopted: true };
    // El importador lee la primera hoja: se le arma una con las filas de esta venta.
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(op.raws), 'Ventas');
    const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const preview = await this.deps.quotationImport.preview(`carga-${op.document}.xlsx`, buffer);
    const rows = preview.rows.filter((r) => r.excludedReason === null);
    const errors = rows.flatMap((r) => r.issues.filter((i) => i.severity === 'error'));
    if (errors.length > 0) throw new Error(errors.map((e) => e.message).join(' · '));
    if (rows.length === 0) throw new Error(`${op.document} no tiene líneas que importar`);
    const input = importQuotationsSchema.parse({
      rows: rows.map((r) => this.confirmRow(r, op.raws[r.rowNumber - 1])),
    });
    await this.deps.quotationImport.confirm(this.actor, input);
    const created = await this.findQuotation(op.document);
    if (!created) throw new Error(`la cotización de ${op.document} no quedó registrada`);
    return { quotationId: created.id, adopted: false };
  }

  /** Una fila del preview, como la manda la pantalla de importar (D-158, D-169, D-255). */
  private confirmRow(r: QuotationImportRowDto, raw: Record<string, unknown> | undefined) {
    if (r.customerId === null && r.padron === null) {
      throw new Error(
        `${r.documentKey}: el cliente «${r.rawCustomer}» no está en el maestro ni en el padrón`,
      );
    }
    let pieces = r.pieces;
    if (r.needsPieces) {
      const text = raw
        ? getField(raw, { key: 'lengths', header: LOAD_COLUMNS.lengths.header, required: false })
        : '';
      const parsed = parseLengths(text);
      if (!parsed)
        throw new Error(`${r.documentKey}: la línea a medida ${r.rawSku} no trae LARGOS válidos`);
      if (!metersOf(parsed).eq(toDecimal(r.qty))) {
        throw new Error(`${r.documentKey}: LARGOS de ${r.rawSku} no suman la cantidad`);
      }
      pieces = parsed.map((p) => ({ lengthMm: p.lengthMm.toFixed(2), qty: p.qty }));
    }
    return {
      rowNumber: r.rowNumber,
      documentKey: r.documentKey,
      issueDate: r.issueDate,
      customerId: r.customerId,
      ...(r.customerId === null && r.padron
        ? { newCustomer: { docType: r.padron.docType, docNumber: r.padron.docNumber } }
        : {}),
      productId: r.productId,
      qty: r.qty,
      unitPricePen: r.unitPricePen,
      ...(r.netAmountPen ? { netAmountPen: r.netAmountPen } : {}),
      ...(r.netAmountPen && r.igvAmountPen && r.totalAmountPen
        ? { igvAmountPen: r.igvAmountPen, totalAmountPen: r.totalAmountPen }
        : {}),
      ...(r.coilLine && r.saleCoilId ? { saleCoilId: r.saleCoilId } : {}),
      ...(r.rawProductName ? { description: r.rawProductName } : {}),
      ...(pieces ? { pieces } : {}),
    };
  }

  private async orderOf(document: string) {
    const quotation = await this.findQuotation(document);
    if (!quotation) throw new Error(`${document}: no hay cotización importada`);
    const order = await this.db.salesOrder.findFirst({
      where: { quotationId: quotation.id, status: { not: 'CANCELLED' } },
      select: {
        id: true,
        customerId: true,
        items: {
          select: { id: true, qty: true, product: { select: { sku: true } } },
          orderBy: { lineNumber: 'asc' },
        },
      },
    });
    return { quotation, order };
  }

  private async runOrder(op: Extract<LoadOp, { step: 'orders' }>): Promise<OpIds> {
    const { quotation, order } = await this.orderOf(op.document);
    if (order) return { orderId: order.id, adopted: true };
    const created = await this.deps.salesOrders.confirm(this.actor, quotation.id, {});
    return { orderId: created.id, adopted: false };
  }

  private async runProduction(op: Extract<LoadOp, { step: 'production' }>): Promise<OpIds> {
    const { order } = await this.orderOf(op.document);
    if (!order) throw new Error(`${op.document}: el pedido no está confirmado`);
    const item = order.items.find((i) => i.product.sku === op.sku);
    if (!item) throw new Error(`${op.document}: el pedido no vende ${op.sku}`);
    const po = await this.db.productionOrder.findFirst({
      where: { reservation: { salesOrderItemId: item.id }, status: { not: 'CANCELLED' } },
      select: {
        id: true,
        status: true,
        product: { select: { unit: true, roofingKind: true, lengthMm: true } },
        items: {
          select: { lineNumber: true, lengthMm: true, qty: true },
          orderBy: { lineNumber: 'asc' },
        },
        reports: {
          where: { status: 'ACTIVE' },
          select: {
            metersM: true,
            pieces: true,
            piecesDetail: { select: { lengthMm: true, qty: true } },
          },
        },
        consumptions: { where: { releasedAt: null }, select: { coilId: true } },
      },
    });
    if (!po) throw new Error(`${op.document}: el pedido no tiene OP para ${op.sku}`);
    const qty = toDecimal(op.qty);
    const planMeters = po.items.reduce(
      (acc, i) => acc.plus(toDecimal(i.lengthMm.toString()).times(i.qty).div(1000)),
      new Decimal(0),
    );
    const reportedMeters = po.reports.reduce(
      (acc, r) =>
        acc.plus(
          r.metersM !== null
            ? toDecimal(r.metersM.toString())
            : r.piecesDetail.reduce(
                (s, p) => s.plus(toDecimal(p.lengthMm.toString()).times(p.qty).div(1000)),
                new Decimal(0),
              ),
        ),
      new Decimal(0),
    );
    // Lo que se reporta: metros de bobina (accesorio), planchas del largo del SKU o los largos que
    // quedan del plan, en su orden.
    const product = po.product;
    let form: { meters: string } | { pieces: { lengthMm: string; qty: number }[] };
    let addMeters: Decimal;
    if (isAccessory(product)) {
      form = { meters: qty.toFixed(3) };
      addMeters = qty;
    } else if (!detailsLengths(product) && product.lengthMm !== null) {
      const lengthMm = toDecimal(product.lengthMm.toString());
      form = { pieces: [{ lengthMm: lengthMm.toFixed(2), qty: qty.toNumber() }] };
      addMeters = lengthMm.times(qty).div(1000);
    } else {
      const pieces = takeFromPlan(po.items, po.reports, qty);
      if (!pieces) {
        throw new Error(
          `${op.document}: ${qty.toFixed(3)} m de ${op.sku} no son piezas enteras de lo que queda del plan`,
        );
      }
      form = { pieces };
      addMeters = qty;
    }
    if (op.coil !== '') {
      const coil = await this.db.coil.findFirst({
        where: { status: { not: 'CANCELLED' }, OR: [{ code: op.coil }, { externalCode: op.coil }] },
        select: { id: true },
      });
      if (!coil) throw new Error(`la bobina ${op.coil} no existe`);
      if (!po.consumptions.some((c) => c.coilId === coil.id)) {
        await this.deps.roofing.mountCoil(
          this.actor,
          po.id,
          mountRoofingCoilSchema.parse({ coilId: coil.id }),
        );
      }
      Object.assign(form, { coilId: coil.id });
    }
    const closes = reportedMeters.plus(addMeters).gte(planMeters);
    const base = {
      ...form,
      operationDate: op.date,
      confirmBackdate: true,
      idempotencyKey: this.key(op),
    };
    if (closes) {
      await this.deps.roofing.reportAndClose(
        this.actor,
        po.id,
        reportAndCloseRoofingSchema.parse(base),
      );
    } else {
      await this.deps.roofing.report(this.actor, po.id, reportRoofingPiecesSchema.parse(base));
    }
    const report = await this.db.productionReport.findFirst({
      where: { productionOrderId: po.id, status: 'ACTIVE' },
      orderBy: { seq: 'desc' },
      select: { id: true },
    });
    return { productionOrderId: po.id, reportId: report?.id ?? null, closed: closes };
  }

  private async runDispatch(op: Extract<LoadOp, { step: 'dispatches' }>): Promise<OpIds> {
    const { order } = await this.orderOf(op.document);
    if (!order) throw new Error(`${op.document}: el pedido no está confirmado`);
    const items = op.items.map((it) => {
      const line = order.items.find((i) => i.product.sku === it.sku);
      if (!line) throw new Error(`${op.document}: el pedido no vende ${it.sku}`);
      return { salesOrderItemId: line.id, qty: it.qty };
    });
    // D-707: la entrega se registra con su destino real y sin datos de transporte: la guía
    // salió del otro sistema; acá queda como recojo.
    const delivery = op.mode === 'DELIVERY';
    const dispatch = await this.deps.dispatches.create(
      this.actor,
      createDispatchSchema.parse({
        salesOrderId: order.id,
        dispatchDate: op.date,
        confirmBackdate: true,
        originAddress: LOAD_PICKUP.address,
        originUbigeo: LOAD_PICKUP.ubigeo,
        destinationAddress: delivery ? op.destination : LOAD_PICKUP.address,
        destinationUbigeo: delivery ? op.ubigeo : LOAD_PICKUP.ubigeo,
        transferMode: 'PICKUP',
        notes: `Carga atrasada ${this.batchId}${delivery ? ' · entrega (guía del otro sistema)' : ''}`,
        items,
        idempotencyKey: this.key(op),
      }),
    );
    return { dispatchId: dispatch.id };
  }

  private numberOf(document: string): { series: string; correlative: number; number: string } {
    const dash = document.indexOf('-');
    const series = document.slice(0, dash);
    const correlative = Number(document.slice(dash + 1));
    if (dash < 0 || !Number.isInteger(correlative) || correlative <= 0) {
      throw new Error(`${document}: la serie y el número no se entienden (SERIE-NÚMERO)`);
    }
    return { series, correlative, number: fiscalDocumentNumber(series, correlative) };
  }

  private async runInvoice(op: Extract<LoadOp, { step: 'invoices' }>): Promise<OpIds> {
    const { series, correlative, number } = this.numberOf(op.document);
    const existing = await this.db.fiscalDocument.findFirst({
      where: { number, archivedAt: null },
      select: { id: true, status: true },
    });
    if (existing?.status === 'ACCEPTED') return { invoiceId: existing.id, adopted: true };
    if (existing) {
      throw new Error(
        `${number} existe con estado ${existing.status}: si está anulado, se reactiva a mano (D-373)`,
      );
    }
    const { order } = await this.orderOf(op.document);
    if (!order) throw new Error(`${op.document}: el pedido no está confirmado`);
    const customer = await this.db.customer.findUniqueOrThrow({
      where: { id: order.customerId },
      select: { creditDays: true },
    });
    const terms = op.paymentTerms ?? (customer.creditDays > 0 ? 'CREDITO' : 'CONTADO');
    const dispatches = await this.db.dispatch.findMany({
      where: { salesOrderId: order.id, reversedAt: null, invoiceId: null },
      select: { id: true },
    });
    const draft = await this.deps.invoicing.create(
      this.actor,
      createInvoiceSchema.parse({
        docType: op.docType,
        customerId: order.customerId,
        salesOrderId: order.id,
        issueDate: op.date,
        paymentTerms: terms,
        ...(terms === 'CREDITO' && op.dueDate ? { dueDate: op.dueDate } : {}),
        ...(dispatches.length === 1 && dispatches[0] ? { dispatchId: dispatches[0].id } : {}),
        items: order.items.map((i) => ({ salesOrderItemId: i.id, qty: i.qty.toString() })),
        idempotencyKey: this.key(op),
      }),
    );
    const doc = await this.deps.invoicing.registerManual(this.actor, draft.id, {
      series,
      correlative,
    });
    return { invoiceId: doc.id, adopted: false };
  }

  private async runCollection(op: Extract<LoadOp, { step: 'collections' }>): Promise<OpIds> {
    const { number } = this.numberOf(op.document);
    const doc = await this.db.fiscalDocument.findFirst({
      where: { number, archivedAt: null, status: 'ACCEPTED' },
      select: { id: true },
    });
    if (!doc) throw new Error(`${number}: el comprobante no está registrado`);
    const reference = loadReference(this.batchId, op.reference, 120);
    const idempotencyKey = this.key(op);
    await this.deps.receivables.addPayment(
      this.actor,
      doc.id,
      createCustomerPaymentSchema.parse({
        date: op.date,
        amountPen: op.amount.replace(',', '.'),
        method: parseMethod(op.method) ?? 'OTHER',
        reference,
        idempotencyKey,
      }),
    );
    const claim = await this.db.idempotencyKey.findUnique({ where: { key: idempotencyKey } });
    return { invoiceId: doc.id, paymentId: claim?.resourceId ?? null };
  }

  private async runSupplierPayment(
    op: Extract<LoadOp, { step: 'supplierPayments' }>,
  ): Promise<OpIds> {
    const purchase = await this.findPurchase(op.supplierRuc, op.document);
    if (!purchase) throw new Error(`${op.document}: la compra no está registrada`);
    const reference = loadReference(this.batchId, op.reference, 80);
    await this.deps.purchases.addPayment(
      this.actor,
      purchase.id,
      createSupplierPaymentSchema.parse({
        date: op.date,
        amount: op.amount.replace(',', '.'),
        currency: purchase.currency,
        ...(purchase.currency === 'PEN' ? {} : { exchangeRate: purchase.exchangeRate.toString() }),
        method: parseMethod(op.method) ?? 'OTHER',
        reference,
        idempotencyKey: this.key(op),
      }),
    );
    const payment = await this.db.supplierPayment.findFirst({
      where: { purchaseId: purchase.id, reference, reversedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return { purchaseId: purchase.id, paymentId: payment?.id ?? null };
  }

  // ---------------------------------------------------------------------------------------------
  // Revertir (D-706)
  // ---------------------------------------------------------------------------------------------

  private async undo(step: LoadStep, ids: OpIds): Promise<void> {
    const reason = reasonOf(this.batchId);
    const id = (k: string) => {
      const v = ids[k];
      if (typeof v !== 'string')
        throw new Error(`${LOAD_STEP_LABELS[step]}: falta ${k} en el manifiesto`);
      return v;
    };
    switch (step) {
      case 'supplierPayments':
        await this.deps.purchases.reversePayment(this.actor, id('purchaseId'), id('paymentId'), {
          reason,
        });
        return;
      case 'collections':
        await this.deps.receivables.reversePayment(
          this.actor,
          id('invoiceId'),
          id('paymentId'),
          reason,
        );
        return;
      case 'invoices':
        if (ids.adopted === true) return; // no lo creó este lote
        await this.deps.fiscalImport.annulExternal(this.actor, id('invoiceId'), reason);
        return;
      case 'dispatches':
        await this.deps.dispatches.reverse(
          this.actor,
          id('dispatchId'),
          reverseMovementSchema.parse({ reason }),
        );
        return;
      case 'production':
        await this.undoProduction(id('productionOrderId'), ids, reason);
        return;
      case 'orders':
        if (ids.adopted === true) return;
        await this.deps.salesOrders.cancel(this.actor, id('orderId'), {
          reason,
          acknowledgeFabricated: true,
        });
        return;
      case 'sales':
        if (ids.adopted === true) return;
        await this.deps.quotations.cancel(this.actor, id('quotationId'), reason);
        return;
      case 'purchases':
        if (ids.adopted === true) return;
        await this.deps.purchases.cancel(this.actor, id('purchaseId'), { reason });
        return;
    }
  }

  /**
   * D-706 (excepción a D-578): solo la reversa de un lote reabre una OP, y solo si la cerró ese
   * mismo lote (`closed` en el manifiesto). Después revierte el parte y, sin partes vivos, anula
   * la OP para que el pedido se pueda anular.
   */
  private async undoProduction(orderId: string, ids: OpIds, reason: string): Promise<void> {
    const po = await this.db.productionOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true },
    });
    if (po.status === 'CLOSED') {
      if (ids.closed !== true) {
        throw new Error('la OP está cerrada y no la cerró este lote: no se reabre (D-578)');
      }
      await this.deps.roofing.reopen(this.actor, orderId, reverseMovementSchema.parse({ reason }));
    }
    if (typeof ids.reportId === 'string') {
      const report = await this.db.productionReport.findUnique({
        where: { id: ids.reportId },
        select: { status: true },
      });
      if (report?.status === 'ACTIVE') {
        await this.deps.roofing.reverseReport(
          this.actor,
          orderId,
          ids.reportId,
          reverseMovementSchema.parse({ reason }),
        );
      }
    }
    const live = await this.db.productionReport.count({
      where: { productionOrderId: orderId, status: 'ACTIVE' },
    });
    const now = await this.db.productionOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true },
    });
    if (live === 0 && now.status !== 'CANCELLED') {
      await this.deps.roofing.cancel(
        this.actor,
        orderId,
        cancelProductionOrderSchema.parse({ reason }),
      );
    }
  }
}

/**
 * Las piezas enteras que quedan del plan, en su orden, hasta sumar exactamente `meters`; `null`
 * si no se puede.
 */
export function takeFromPlan(
  plan: readonly { lineNumber: number; lengthMm: { toString(): string }; qty: number }[],
  reports: readonly {
    piecesDetail: readonly { lengthMm: { toString(): string }; qty: number }[];
  }[],
  meters: Decimal,
): { lengthMm: string; qty: number }[] | null {
  const reported = new Map<string, number>();
  for (const r of reports) {
    for (const p of r.piecesDetail) {
      const k = toDecimal(p.lengthMm.toString()).toFixed(2);
      reported.set(k, (reported.get(k) ?? 0) + p.qty);
    }
  }
  let left = meters;
  const out: { lengthMm: string; qty: number }[] = [];
  for (const item of plan) {
    const k = toDecimal(item.lengthMm.toString()).toFixed(2);
    const done = Math.min(reported.get(k) ?? 0, item.qty);
    reported.set(k, (reported.get(k) ?? 0) - done);
    const free = item.qty - done;
    const each = toDecimal(k).div(1000);
    let take = 0;
    while (take < free && left.gte(each)) {
      take += 1;
      left = left.minus(each);
    }
    if (take > 0) out.push({ lengthMm: k, qty: take });
    if (left.isZero()) break;
  }
  return left.isZero() && out.length > 0 ? out : null;
}

/**
 * La referencia de un cobro o pago de la carga: la marca del lote y la del Excel, ya recortada como
 * la guarda el schema (sin espacios en los bordes), para poder encontrarla después.
 */
export function loadReference(batchId: string, reference: string, max: number): string {
  const ref = reference.trim();
  return `CA ${batchId.slice(0, 12)}${ref ? ` · ${ref}` : ''}`.slice(0, max).trim();
}
