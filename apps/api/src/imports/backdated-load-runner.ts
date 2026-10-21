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
import { parseAmount, parseMethod } from './opening-balances-plan';
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
/**
 * Revisión de cc64 (R-02): la intención de una operación, anotada **antes** de llamar al servicio.
 * Si al reanudar la operación ya existe y tiene su intención, la creó este lote (no es «adoptada»).
 */
export const LOAD_STARTED_ACTION = 'imports.backdated-load.op-start';

/** Lo que una operación creó o adoptó: lo necesita la reversa. */
export type OpIds = Record<string, string | boolean | null>;

export interface LoadManifest {
  start: { fileName: string; sha256: string } | null;
  /** Operaciones hechas (y no revertidas), en el orden en que se hicieron. */
  done: Map<string, { step: LoadStep; ids: OpIds }>;
  reverted: Set<string>;
  /** Operaciones que el lote intentó alguna vez (R-02). */
  started: Set<string>;
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
  const manifest: LoadManifest = {
    start: null,
    done: new Map(),
    reverted: new Set(),
    started: new Set(),
  };
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
    } else if (r.action === LOAD_STARTED_ACTION) {
      manifest.started.add(String(after.key));
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

  /** La operación en curso ya se había intentado antes (reanudación, R-02/R-03). */
  private resumed = false;
  /** Pedidos que creó este lote: sus OP se pueden anular en la reversa (R-04). */
  private readonly ownedOrders = new Set<string>();

  private get db(): PrismaService {
    return this.deps.prisma;
  }

  /** Anota en el manifiesto una operación hecha. Las pruebas lo reemplazan para simular un corte. */
  protected async recordOp(op: LoadOp, ids: OpIds): Promise<void> {
    await this.deps.audit.log({
      actorId: this.actor.id,
      action: LOAD_OP_ACTION,
      entity: LOAD_ENTITY,
      entityId: this.batchId,
      after: { key: op.key, step: op.step, ids },
    });
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
    // Revisión de cc64 (R-07): un lote revertido no se vuelve a cargar (los recursos de sus claves
    // de idempotencia ya están revertidos): el plan corregido va con otro lote (D-706).
    if (manifest.reverted.size > 0) {
      return {
        executed,
        skipped,
        failure: {
          key: '',
          step: 'purchases',
          rows: [],
          message: 'este lote ya se revirtió: carga el plan con otro --lote',
        },
        ms: 0,
      };
    }
    for (const [, d] of manifest.done) {
      if (d.step === 'orders' && d.ids.adopted !== true && typeof d.ids.orderId === 'string') {
        this.ownedOrders.add(d.ids.orderId);
      }
    }
    for (const op of ops) {
      if (manifest.done.has(op.key)) {
        skipped.push(op.key);
        continue;
      }
      this.resumed = manifest.started.has(op.key);
      if (!this.resumed) {
        await this.deps.audit.log({
          actorId: this.actor.id,
          action: LOAD_STARTED_ACTION,
          entity: LOAD_ENTITY,
          entityId: this.batchId,
          after: { key: op.key, step: op.step },
        });
        manifest.started.add(op.key);
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
      await this.recordOp(op, ids);
      manifest.done.set(op.key, { step: op.step, ids });
      if (op.step === 'orders' && ids.adopted !== true && typeof ids.orderId === 'string') {
        this.ownedOrders.add(ids.orderId);
      }
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
    let adopted = purchase !== null && !this.resumed;
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
    if (existing) return { quotationId: existing.id, adopted: !this.resumed };
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
          select: {
            id: true,
            qty: true,
            product: { select: { sku: true } },
            dispatchItems: {
              where: { dispatch: { reversedAt: null } },
              select: { qty: true },
            },
          },
          orderBy: { lineNumber: 'asc' },
        },
      },
    });
    return { quotation, order };
  }

  private async runOrder(op: Extract<LoadOp, { step: 'orders' }>): Promise<OpIds> {
    const { quotation, order } = await this.orderOf(op.document);
    if (order) return { orderId: order.id, adopted: !this.resumed };
    const created = await this.deps.salesOrders.confirm(this.actor, quotation.id, {});
    return { orderId: created.id, adopted: false };
  }

  private async runProduction(op: Extract<LoadOp, { step: 'production' }>): Promise<OpIds> {
    const { order } = await this.orderOf(op.document);
    if (!order) throw new Error(`${op.document}: el pedido no está confirmado`);
    const lines = order.items.filter((i) => i.product.sku === op.sku);
    if (lines.length === 0) throw new Error(`${op.document}: el pedido no vende ${op.sku}`);
    // Con varias líneas del mismo SKU, la primera cuya OP no está cerrada (autorrevisión, P1-1).
    const open = await this.db.productionOrder.findFirst({
      where: {
        reservation: { salesOrderItemId: { in: lines.map((l) => l.id) } },
        status: { notIn: ['CANCELLED', 'CLOSED'] },
      },
      orderBy: { seq: 'asc' },
      select: { reservation: { select: { salesOrderItemId: true } } },
    });
    const item = lines.find((l) => l.id === open?.reservation?.salesOrderItemId) ?? lines[0];
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
    const qty = amountOf(op.qty, `${op.document}: cantidad`);
    const orderOwned = this.ownedOrders.has(order.id);
    // Revisión de cc64 (R-03): un parte hecho y no anotado se reconoce por su clave de
    // idempotencia (cualquier alcance: parte o parte y cierre) y no se vuelve a calcular.
    if (this.resumed) {
      const seen = await this.db.idempotencyKey.findUnique({ where: { key: this.key(op) } });
      if (seen) {
        const last = await this.db.productionReport.findFirst({
          where: { productionOrderId: po.id, status: 'ACTIVE' },
          orderBy: { seq: 'desc' },
          select: { id: true },
        });
        if (!last) throw new Error(`${op.document}: el parte ya se hizo, pero no se encuentra`);
        return {
          productionOrderId: po.id,
          reportId: last.id,
          closed: po.status === 'CLOSED',
          orderOwned,
        };
      }
    }
    // Sin líneas de plan, la cantidad del pedido; en planchas de largo fijo es un conteo, y se pasa
    // a metros para compararla con lo reportado.
    const fixedLengthMm =
      !isAccessory(po.product) && !detailsLengths(po.product) && po.product.lengthMm !== null
        ? toDecimal(po.product.lengthMm.toString())
        : null;
    const planMeters =
      po.items.length === 0
        ? fixedLengthMm
          ? fixedLengthMm.times(item.qty.toString()).div(1000)
          : toDecimal(item.qty.toString())
        : po.items.reduce(
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
      const coil =
        (await this.db.coil.findFirst({
          where: { status: { not: 'CANCELLED' }, code: op.coil },
          select: { id: true },
        })) ??
        (await this.db.coil.findFirst({
          where: { status: { not: 'CANCELLED' }, externalCode: op.coil },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        }));
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
      ...(op.coilKg.trim() === ''
        ? {}
        : { consumedKg: amountOf(op.coilKg, `${op.document}: KG CONSUMIDOS`).toFixed(3) }),
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
    // Revisión de cc64 (R-04): sin el parte, la reversa no podría deshacerlo.
    if (!report) throw new Error(`${op.document}: el parte no quedó registrado`);
    return { productionOrderId: po.id, reportId: report.id, closed: closes, orderOwned };
  }

  private async runDispatch(op: Extract<LoadOp, { step: 'dispatches' }>): Promise<OpIds> {
    const { order } = await this.orderOf(op.document);
    if (!order) throw new Error(`${op.document}: el pedido no está confirmado`);
    const items = allocateDispatch(
      op.document,
      order.items.map((i) => ({
        id: i.id,
        sku: i.product.sku,
        pending: toDecimal(i.qty.toString()).minus(
          i.dispatchItems.reduce((s, d) => s.plus(d.qty.toString()), new Decimal(0)),
        ),
      })),
      op.items.map((it) => ({ sku: it.sku, qty: amountOf(it.qty, `${op.document}: cantidad`) })),
    );
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
      select: { id: true, status: true, salesOrderId: true },
    });
    if (existing?.status === 'ACCEPTED') {
      const { order: mine } = await this.orderOf(op.document);
      if (existing.salesOrderId !== mine?.id) {
        throw new Error(`${number} ya está registrado y no es del pedido de esta venta`);
      }
      return { invoiceId: existing.id, adopted: !this.resumed };
    }
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
      select: { id: true, items: { select: { salesOrderItemId: true, qty: true } } },
    });
    // D-205: el comprobante declara el despacho que cubre. Se enlaza solo un despacho único que
    // lleva todo el pedido; si no, el comprobante queda sin despacho declarado.
    const covers = (d: (typeof dispatches)[number]) =>
      order.items.every((i) =>
        d.items
          .filter((x) => x.salesOrderItemId === i.id)
          .reduce((s, x) => s.plus(x.qty.toString()), new Decimal(0))
          .eq(i.qty.toString()),
      );
    const linked =
      dispatches.length === 1 && dispatches[0] && covers(dispatches[0]) ? dispatches[0] : null;
    const draft = await this.deps.invoicing.create(
      this.actor,
      createInvoiceSchema.parse({
        docType: op.docType,
        customerId: order.customerId,
        salesOrderId: order.id,
        issueDate: op.date,
        paymentTerms: terms,
        ...(terms === 'CREDITO' && op.dueDate ? { dueDate: op.dueDate } : {}),
        ...(linked ? { dispatchId: linked.id } : {}),
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
        amountPen: amountOf(op.amount, `${op.document}: monto`).toFixed(2),
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
    // El servicio no devuelve el id del pago: se lo busca por su referencia, que lleva el número
    // del pago dentro de la compra para que dos pagos sin REFERENCIA no se confundan
    // (autorrevisión de cc64, P3-19).
    const nth = op.key.split('|').at(-1) ?? '1';
    const reference = loadReference(this.batchId, `#${nth} ${op.reference}`, 80);
    await this.deps.purchases.addPayment(
      this.actor,
      purchase.id,
      createSupplierPaymentSchema.parse({
        date: op.date,
        amount: amountOf(op.amount, `${op.document}: monto`).toFixed(2),
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
      case 'supplierPayments': {
        const payment = await this.db.supplierPayment.findUnique({
          where: { id: id('paymentId') },
          select: { reversedAt: true },
        });
        if (payment?.reversedAt) return;
        await this.deps.purchases.reversePayment(this.actor, id('purchaseId'), id('paymentId'), {
          reason,
        });
        return;
      }
      case 'collections': {
        const payment = await this.db.customerPayment.findUnique({
          where: { id: id('paymentId') },
          select: { reversedAt: true },
        });
        if (payment?.reversedAt) return;
        await this.deps.receivables.reversePayment(
          this.actor,
          id('invoiceId'),
          id('paymentId'),
          reason,
        );
        return;
      }
      case 'invoices': {
        if (ids.adopted === true) return; // no lo creó este lote
        const doc = await this.db.fiscalDocument.findUnique({
          where: { id: id('invoiceId') },
          select: { status: true },
        });
        if (doc?.status === 'ANNULLED') return;
        await this.deps.fiscalImport.annulExternal(this.actor, id('invoiceId'), reason);
        return;
      }
      case 'dispatches': {
        const dispatch = await this.db.dispatch.findUnique({
          where: { id: id('dispatchId') },
          select: { reversedAt: true },
        });
        if (dispatch?.reversedAt) return;
        await this.deps.dispatches.reverse(
          this.actor,
          id('dispatchId'),
          reverseMovementSchema.parse({ reason }),
        );
        return;
      }
      case 'production':
        await this.undoProduction(id('productionOrderId'), ids, reason);
        return;
      case 'orders': {
        if (ids.adopted === true) return;
        const order = await this.db.salesOrder.findUnique({
          where: { id: id('orderId') },
          select: { status: true },
        });
        if (order?.status === 'CANCELLED') return;
        await this.deps.salesOrders.cancel(this.actor, id('orderId'), {
          reason,
          acknowledgeFabricated: true,
        });
        return;
      }
      case 'sales': {
        if (ids.adopted === true) return;
        const quotation = await this.db.quotation.findUnique({
          where: { id: id('quotationId') },
          select: { status: true },
        });
        if (quotation?.status === 'CANCELLED') return;
        await this.deps.quotations.cancel(this.actor, id('quotationId'), reason);
        return;
      }
      case 'purchases': {
        if (ids.adopted === true) return;
        const purchase = await this.db.purchase.findUnique({
          where: { id: id('purchaseId') },
          select: { status: true },
        });
        if (purchase?.status === 'CANCELLED') return;
        await this.deps.purchases.cancel(this.actor, id('purchaseId'), { reason });
        return;
      }
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
    // Revisión de cc64 (R-04): la OP de un pedido que el lote no creó no se anula.
    if (live === 0 && now.status !== 'CANCELLED' && ids.orderOwned !== false) {
      await this.deps.roofing.cancel(
        this.actor,
        orderId,
        cancelProductionOrderSchema.parse({ reason }),
      );
    }
  }
}

/**
 * Reparte las filas de un despacho entre las líneas del pedido con ese SKU, según lo que le falta a
 * cada una, y suma las filas del mismo SKU (autorrevisión de cc64, P1-1 y P3-18).
 */
export function allocateDispatch(
  document: string,
  lines: readonly { id: string; sku: string; pending: Decimal }[],
  rows: readonly { sku: string; qty: Decimal }[],
): { salesOrderItemId: string; qty: string }[] {
  const left = new Map(lines.map((l) => [l.id, l.pending]));
  const out = new Map<string, Decimal>();
  for (const row of rows) {
    const candidates = lines.filter((l) => l.sku === row.sku);
    if (candidates.length === 0) throw new Error(`${document}: el pedido no vende ${row.sku}`);
    let need = row.qty;
    for (const l of candidates) {
      if (need.isZero()) break;
      const room = Decimal.max(left.get(l.id) ?? new Decimal(0), new Decimal(0));
      const take = Decimal.min(room, need);
      if (take.gt(0)) {
        out.set(l.id, (out.get(l.id) ?? new Decimal(0)).plus(take));
        left.set(l.id, room.minus(take));
        need = need.minus(take);
      }
    }
    // Lo que no cabe va a la última línea: el servicio lo rechaza con su mensaje («de más»).
    const last = candidates.at(-1);
    if (need.gt(0) && last) out.set(last.id, (out.get(last.id) ?? new Decimal(0)).plus(need));
  }
  return [...out].map(([salesOrderItemId, qty]) => ({ salesOrderItemId, qty: qty.toFixed(3) }));
}

/** Una cantidad o un monto del Excel, con el mismo parser que la revisión (`1.234,50`, `1,234.50`). */
function amountOf(text: string, label: string): Decimal {
  const value = parseAmount(text);
  if (!value || value.lte(0)) throw new Error(`${label} inválido: «${text}»`);
  return value;
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
  // Lo que queda de cada largo, en el orden del plan.
  const free: { k: string; each: Decimal; qty: number }[] = [];
  for (const item of plan) {
    const k = toDecimal(item.lengthMm.toString()).toFixed(2);
    const done = Math.min(reported.get(k) ?? 0, item.qty);
    reported.set(k, (reported.get(k) ?? 0) - done);
    if (item.qty - done > 0) free.push({ k, each: toDecimal(k).div(1000), qty: item.qty - done });
  }
  // Revisión de cc64 (P2-10): búsqueda exacta, prefiriendo los largos del principio del plan; un
  // reparto voraz rechazaba combinaciones que sí existen.
  const take: number[] = free.map(() => 0);
  const search = (i: number, left: Decimal): boolean => {
    if (left.isZero()) return true;
    if (i >= free.length) return false;
    const f = free[i];
    if (!f) return false;
    const max = Math.min(f.qty, left.div(f.each).floor().toNumber());
    for (let n = max; n >= 0; n -= 1) {
      take[i] = n;
      if (search(i + 1, left.minus(f.each.times(n)))) return true;
    }
    take[i] = 0;
    return false;
  };
  if (meters.lte(0) || !search(0, meters)) return null;
  return free.flatMap((f, i) => ((take[i] ?? 0) > 0 ? [{ lengthMm: f.k, qty: take[i] ?? 0 }] : []));
}

/**
 * La referencia de un cobro o pago de la carga: la marca del lote y la del Excel, ya recortada como
 * la guarda el schema (sin espacios en los bordes), para poder encontrarla después.
 */
export function loadReference(batchId: string, reference: string, max: number): string {
  const ref = reference.trim();
  return `CA ${batchId.slice(0, 12)}${ref ? ` · ${ref}` : ''}`.slice(0, max).trim();
}
