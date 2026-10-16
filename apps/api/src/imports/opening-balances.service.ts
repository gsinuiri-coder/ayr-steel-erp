import { randomUUID } from 'node:crypto';
import { FiscalDocType, PurchaseStatus, type Currency, type Prisma } from '@prisma/client';
import {
  Decimal,
  fromDateOnly,
  LIVE_DOCUMENT_STATUSES,
  payableBalance,
  PAYMENT_METHOD_LABELS,
  toDecimal,
} from '@ayr/shared';
import type { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { lockDocuments } from '../inventory/document-locks';
import { documentBalanceOf } from '../invoicing/collectible-documents';
import type { ReceivablesService } from '../invoicing/receivables.service';
import { purchaseBalance, toPurchaseCurrency } from '../purchases/purchase-math';
import type { PurchasesService } from '../purchases/purchases.service';
import {
  MISSING_POLICY_LABELS,
  planOpeningBalances,
  type MissingPolicy,
  type OpeningAccount,
  type OpeningPlan,
  type OpeningRow,
  type PlannedPayment,
} from './opening-balances-plan';
import {
  supplierKey,
  type CustomerTemplateRow,
  type OpeningSide,
  type SupplierTemplateRow,
} from './opening-balances-sheets';

/**
 * cc56 (D-668) — el importador de **saldos iniciales** de cobranzas y pagos a proveedor.
 *
 * Registra cada cobro (pago) por la puerta de siempre —`ReceivablesService.addPaymentInTx` y
 * `PurchasesService.addPaymentInTx`, que bloquean la cuenta, revalidan el saldo y auditan el pago— y
 * todo el lote en una sola transacción: o entra entero o no entra nada.
 *
 * **El lote sin migración.** `customer_payments` y `supplier_payments` no tienen columna de lote;
 * agregarla exigía una migración (D-460). El lote se identifica por:
 * - su registro en la auditoría (`imports.opening-balances`, `entityId` = id del lote), con los ids
 *   de cada cobro y pago que creó: es la lista que usa el deshacer;
 * - la referencia de cada pago, que empieza con `SI <8 primeros del lote>` para que se vea en la app.
 *
 * Deshacer revierte cada pago del lote por la reversa de siempre (la fila no se borra, D-061) y
 * deja `imports.opening-balances.undo`. Mientras un lote del mismo lado siga vivo, otro no corre:
 * cargar dos veces los saldos iniciales duplicaría los cobros.
 */

export const OPENING_BATCH_ACTION = 'imports.opening-balances';
/** Clave del candado asesor de la ejecución (un número fijo, propio de este importador). */
export const OPENING_ADVISORY_LOCK = 560668;
export const OPENING_UNDO_ACTION = 'imports.opening-balances.undo';
const OPENING_ENTITY = 'opening_balance_batches';

export interface OpeningBatchInput {
  cutoff: string;
  missing: MissingPolicy;
  /** `null`: ese lado no se toca (no vino su archivo). */
  customers: OpeningRow[] | null;
  suppliers: OpeningRow[] | null;
}

export interface OpeningSideResult {
  plan: OpeningPlan;
  /** Ids de los pagos registrados (vacío en el plan sin ejecutar). */
  paymentIds: string[];
}

export interface OpeningBatchResult {
  batchId: string;
  cutoff: string;
  missing: MissingPolicy;
  customers: OpeningSideResult | null;
  suppliers: OpeningSideResult | null;
}

/** Un lote vivo (registrado y no deshecho). */
export interface LiveOpeningBatch {
  batchId: string;
  at: string;
  sides: OpeningSide[];
}

interface BatchAudit {
  batchId: string;
  cutoff: string;
  missing: MissingPolicy;
  customerPaymentIds: string[];
  supplierPaymentIds: string[];
}

const ZERO = new Decimal(0);

/** La referencia de un pago del lote: `SI <lote>` y, si vino, la del Excel (recortada). */
export function batchReference(batchId: string, reference: string | null, max: number): string {
  const tag = `SI ${batchId.slice(0, 8)}`;
  return (reference ? `${tag} · ${reference}` : tag).slice(0, max);
}

export class OpeningBalancesImporter {
  constructor(
    private readonly receivables: Pick<ReceivablesService, 'addPaymentInTx' | 'reversePaymentInTx'>,
    private readonly purchases: Pick<PurchasesService, 'addPaymentInTx' | 'reversePaymentInTx'>,
    private readonly audit: Pick<AuditService, 'write'>,
    private readonly historicalFloor: string,
  ) {}

  /** Los comprobantes que pueden tener saldo: facturas y boletas vivas, no archivadas. */
  async customerAccounts(
    tx: Prisma.TransactionClient,
    cutoff: string,
  ): Promise<{ accounts: OpeningAccount[]; template: CustomerTemplateRow[] }> {
    const documents = await tx.fiscalDocument.findMany({
      where: {
        status: { in: [...LIVE_DOCUMENT_STATUSES] },
        docType: { in: [FiscalDocType.FACTURA, FiscalDocType.BOLETA] },
        archivedAt: null,
        number: { not: null },
      },
      include: {
        customer: { select: { name: true, docNumber: true } },
        payments: { select: { amountPen: true, reversedAt: true, date: true } },
        creditNotes: {
          where: { status: { in: [...LIVE_DOCUMENT_STATUSES] }, archivedAt: null },
          select: { totalPen: true, issueDate: true },
        },
      },
      orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
    });
    const accounts: OpeningAccount[] = [];
    const template: CustomerTemplateRow[] = [];
    for (const d of documents) {
      const credited = d.creditNotes
        .filter((n) => fromDateOnly(n.issueDate) <= cutoff)
        .reduce((acc, n) => acc.plus(n.totalPen.toString()), ZERO);
      const paid = d.payments
        .filter((p) => p.reversedAt === null && fromDateOnly(p.date) <= cutoff)
        .reduce((acc, p) => acc.plus(p.amountPen.toString()), ZERO);
      const balance = documentBalanceOf(d);
      const number = d.number ?? '';
      accounts.push({
        id: d.id,
        key: number,
        issueDate: fromDateOnly(d.issueDate),
        netAtCutoff: toDecimal(d.totalPen.toString()).minus(credited),
        paidUpToCutoff: paid,
        payableNow: payableBalance(balance),
        currency: 'PEN',
      });
      // La plantilla trae lo emitido hasta el corte: lo posterior no es saldo inicial.
      if (fromDateOnly(d.issueDate) > cutoff) continue;
      template.push({
        number,
        customer: d.customer.name,
        customerDoc: d.customer.docNumber,
        issueDate: fromDateOnly(d.issueDate),
        dueDate: d.dueDate ? fromDateOnly(d.dueDate) : null,
        totalPen: d.totalPen.toFixed(2),
        balancePen: balance.toFixed(2),
      });
    }
    return { accounts, template };
  }

  /** Las compras recibidas (bobinas, producto y servicios): lo que se le debe al proveedor. */
  async supplierAccounts(
    tx: Prisma.TransactionClient,
    cutoff: string,
  ): Promise<{
    accounts: OpeningAccount[];
    template: SupplierTemplateRow[];
    meta: Map<string, { currency: string; exchangeRate: string }>;
  }> {
    const purchases = await tx.purchase.findMany({
      where: { status: PurchaseStatus.RECEIVED },
      include: { supplier: { select: { name: true, docNumber: true } }, payments: true },
      orderBy: [{ issueDate: 'asc' }, { series: 'asc' }, { number: 'asc' }],
    });
    const accounts: OpeningAccount[] = [];
    const template: SupplierTemplateRow[] = [];
    const meta = new Map<string, { currency: string; exchangeRate: string }>();
    for (const p of purchases) {
      const document = `${p.series}-${p.number}`;
      const paid = p.payments
        .filter((x) => x.reversedAt === null && fromDateOnly(x.date) <= cutoff)
        .reduce(
          (acc, x) =>
            acc.plus(
              toPurchaseCurrency(
                toDecimal(x.amount.toString()),
                x.currency,
                p.currency,
                toDecimal(x.exchangeRate.toString()),
              ),
            ),
          ZERO,
        );
      const balance = purchaseBalance(p, p.payments);
      accounts.push({
        id: p.id,
        key: supplierKey(p.supplier.docNumber, document),
        issueDate: fromDateOnly(p.issueDate),
        netAtCutoff: toDecimal(p.total.toString()),
        paidUpToCutoff: paid,
        // Hacia abajo, no hacia arriba como en ventas: `addPaymentInTx` compara contra el saldo sin
        // redondear, y el resto de menos de un céntimo ya cuenta como saldado (D-039).
        payableNow: balance.toDecimalPlaces(2, Decimal.ROUND_DOWN),
        currency: p.currency,
      });
      meta.set(p.id, { currency: p.currency, exchangeRate: p.exchangeRate.toFixed(4) });
      if (fromDateOnly(p.issueDate) > cutoff) continue;
      template.push({
        supplierDoc: p.supplier.docNumber,
        supplier: p.supplier.name,
        document,
        issueDate: fromDateOnly(p.issueDate),
        currency: p.currency,
        total: p.total.toFixed(2),
        balance: balance.toFixed(2),
      });
    }
    return { accounts, template, meta };
  }

  /** Los lotes registrados y no deshechos. */
  async liveBatches(tx: Prisma.TransactionClient): Promise<LiveOpeningBatch[]> {
    const rows = await tx.auditLog.findMany({
      where: {
        entity: OPENING_ENTITY,
        action: { in: [OPENING_BATCH_ACTION, OPENING_UNDO_ACTION] },
      },
      select: { action: true, entityId: true, after: true, at: true },
      orderBy: { at: 'asc' },
    });
    const undone = new Set(
      rows.filter((r) => r.action === OPENING_UNDO_ACTION).map((r) => r.entityId),
    );
    return rows
      .filter((r) => r.action === OPENING_BATCH_ACTION && r.entityId && !undone.has(r.entityId))
      .map((r) => {
        const after = r.after as unknown as BatchAudit;
        const sides: OpeningSide[] = [];
        if (after.customerPaymentIds.length > 0) sides.push('CUSTOMERS');
        if (after.supplierPaymentIds.length > 0) sides.push('SUPPLIERS');
        return { batchId: r.entityId ?? '', at: r.at.toISOString(), sides };
      });
  }

  /** El plan del lote (no escribe). Sirve para el dry-run y es lo primero que hace `run`. */
  async plan(tx: Prisma.TransactionClient, input: OpeningBatchInput): Promise<OpeningBatchResult> {
    const options = (account: string, payment: string) => ({
      cutoff: input.cutoff,
      missing: input.missing,
      historicalFloor: this.historicalFloor,
      noun: { account, payment },
    });
    const customers =
      input.customers === null
        ? null
        : planOpeningBalances(
            (await this.customerAccounts(tx, input.cutoff)).accounts,
            input.customers,
            options('comprobante', 'cobro'),
          );
    let suppliers: OpeningPlan | null = null;
    if (input.suppliers !== null) {
      const { accounts, meta } = await this.supplierAccounts(tx, input.cutoff);
      suppliers = planOpeningBalances(accounts, input.suppliers, options('compra', 'pago'));
      checkExchangeRates(suppliers, meta);
    }
    return {
      batchId: randomUUID(),
      cutoff: input.cutoff,
      missing: input.missing,
      customers: customers && { plan: customers, paymentIds: [] },
      suppliers: suppliers && { plan: suppliers, paymentIds: [] },
    };
  }

  /**
   * Registra el lote. Si el plan tiene un solo error, o si ya hay un lote vivo del mismo lado, no
   * escribe nada (lanza). El llamador abre la transacción: el dry-run la revierte al final.
   */
  async run(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    input: OpeningBatchInput,
  ): Promise<OpeningBatchResult> {
    // Dos ejecuciones a la vez no se cruzan: la segunda espera y después ve el lote vivo.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${OPENING_ADVISORY_LOCK})::text AS "lock"`;
    const live = await this.liveBatches(tx);
    const sides: OpeningSide[] = [];
    if (input.customers !== null) sides.push('CUSTOMERS');
    if (input.suppliers !== null) sides.push('SUPPLIERS');
    const clash = live.find((b) => b.sides.some((s) => sides.includes(s)));
    if (clash) {
      throw new OpeningBatchRejected(
        `Ya hay un lote de saldos iniciales vivo (${clash.batchId}, ${clash.at}) del mismo lado: deshazlo antes de cargar otro.`,
      );
    }
    // Regla 17 (D-474): todos los comprobantes que el lote puede tocar (los emitidos hasta el corte
    // con algo que cobrar) se toman juntos y en orden al inicio, y el plan se lee con ellos bloqueados.
    // Las compras se pagan en orden de id (cada pago bloquea la suya; es una rama aparte).
    if (input.customers !== null) {
      const { accounts } = await this.customerAccounts(tx, input.cutoff);
      await lockDocuments(tx, {
        fiscalDocuments: accounts
          .filter((a) => a.issueDate <= input.cutoff && a.payableNow.gt(0))
          .map((a) => a.id),
      });
    }
    const result = await this.plan(tx, input);
    result.customers?.plan.payments.sort(byAccount);
    result.suppliers?.plan.payments.sort(byAccount);
    const errors = [
      ...(result.customers?.plan.errors ?? []),
      ...(result.suppliers?.plan.errors ?? []),
    ];
    if (errors.length > 0) {
      throw new OpeningBatchRejected(
        `El lote tiene ${String(errors.length)} error(es): no se registra nada.`,
        result,
      );
    }
    const { batchId } = result;
    let ordinal = 0;
    const key = (): string => {
      ordinal += 1;
      return `opening-${batchId}-${String(ordinal)}`;
    };
    if (result.customers) {
      for (const p of result.customers.plan.payments) {
        const id = await named(p.key, () =>
          this.receivables.addPaymentInTx(tx, actor, p.accountId, {
            date: p.date,
            amountPen: p.amount,
            method: p.method,
            reference: batchReference(batchId, p.reference, 120),
            idempotencyKey: key(),
          }),
        );
        result.customers.paymentIds.push(id);
      }
    }
    if (result.suppliers) {
      const { meta } = await this.supplierAccounts(tx, input.cutoff);
      for (const p of result.suppliers.plan.payments) {
        const m = meta.get(p.accountId);
        if (!m) throw new OpeningBatchRejected(`Compra ${p.key} sin datos de moneda`);
        const rate = paymentRate(p, m);
        const id = await named(p.key, () =>
          this.purchases.addPaymentInTx(
            tx,
            actor,
            p.accountId,
            {
              date: p.date,
              amount: p.amount,
              currency: m.currency as Currency,
              exchangeRate: rate.toFixed(4),
              method: p.method,
              reference: batchReference(batchId, p.reference, 80),
              idempotencyKey: key(),
            },
            rate,
          ),
        );
        if (id === null) throw new OpeningBatchRejected(`El pago de ${p.key} ya estaba registrado`);
        result.suppliers.paymentIds.push(id);
      }
    }
    const audit: BatchAudit = {
      batchId,
      cutoff: input.cutoff,
      missing: input.missing,
      customerPaymentIds: result.customers?.paymentIds ?? [],
      supplierPaymentIds: result.suppliers?.paymentIds ?? [],
    };
    await this.audit.write(tx, {
      actorId: actor.id,
      action: OPENING_BATCH_ACTION,
      entity: OPENING_ENTITY,
      entityId: batchId,
      after: {
        ...audit,
        missingLabel: MISSING_POLICY_LABELS[input.missing],
        customersTotalPen: result.customers?.plan.totalRegistered ?? '0.00',
        suppliersTotals: result.suppliers?.plan.totalsByCurrency ?? {},
      },
    });
    return result;
  }

  /**
   * Deshace un lote: revierte cada pago que registró (los ya revertidos a mano se saltan) y deja la
   * auditoría del deshacer. Devuelve cuántos revirtió y cuántos ya estaban revertidos.
   */
  async undo(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    batchId: string,
    reason: string,
  ): Promise<{ reversed: number; alreadyReversed: number }> {
    const live = await this.liveBatches(tx);
    if (!live.some((b) => b.batchId === batchId)) {
      throw new OpeningBatchRejected(`No hay un lote vivo ${batchId} (no existe o ya se deshizo).`);
    }
    const row = await tx.auditLog.findFirstOrThrow({
      where: { entity: OPENING_ENTITY, action: OPENING_BATCH_ACTION, entityId: batchId },
      select: { after: true },
    });
    const batch = row.after as unknown as BatchAudit;
    const motive = `${reason} (deshacer saldos iniciales, lote ${batchId.slice(0, 8)})`.slice(
      0,
      240,
    );
    let reversed = 0;
    let alreadyReversed = 0;
    const customers = await tx.customerPayment.findMany({
      where: { id: { in: batch.customerPaymentIds } },
      select: { id: true, documentId: true, reversedAt: true },
      orderBy: { documentId: 'asc' },
    });
    for (const p of customers) {
      if (p.reversedAt !== null) {
        alreadyReversed += 1;
        continue;
      }
      await this.receivables.reversePaymentInTx(tx, actor, p.documentId, p.id, motive);
      reversed += 1;
    }
    const suppliers = await tx.supplierPayment.findMany({
      where: { id: { in: batch.supplierPaymentIds } },
      select: { id: true, purchaseId: true, reversedAt: true },
      orderBy: { purchaseId: 'asc' },
    });
    for (const p of suppliers) {
      if (p.reversedAt !== null) {
        alreadyReversed += 1;
        continue;
      }
      await this.purchases.reversePaymentInTx(tx, actor, p.purchaseId, p.id, { reason: motive });
      reversed += 1;
    }
    const expected = batch.customerPaymentIds.length + batch.supplierPaymentIds.length;
    if (customers.length + suppliers.length !== expected) {
      throw new OpeningBatchRejected(
        `El lote lista ${String(expected)} pagos y se encontraron ${String(customers.length + suppliers.length)}.`,
      );
    }
    await this.audit.write(tx, {
      actorId: actor.id,
      action: OPENING_UNDO_ACTION,
      entity: OPENING_ENTITY,
      entityId: batchId,
      reason: reason.slice(0, 500),
      after: { batchId, reversed, alreadyReversed },
    });
    return { reversed, alreadyReversed };
  }
}

/** El lote no se registra (errores, lote vivo, deshacer imposible). Lleva el plan si lo hay. */
export class OpeningBatchRejected extends Error {
  constructor(
    message: string,
    readonly result?: OpeningBatchResult,
  ) {
    super(message);
  }
}

/**
 * El tipo de cambio de un pago a proveedor: en soles, 1; en dólares, el de la fila o, si no vino,
 * el de la propia compra. Como el monto va en la moneda de la compra, el tipo de cambio no cambia lo
 * que se descuenta del saldo (`toPurchaseCurrency` con la misma moneda): queda informativo, y no se
 * consulta a ningún servicio externo.
 */
export function paymentRate(
  payment: Pick<PlannedPayment, 'exchangeRate'>,
  meta: { currency: string; exchangeRate: string },
): Decimal {
  if (meta.currency === 'PEN') return new Decimal(1);
  return toDecimal(payment.exchangeRate ?? meta.exchangeRate);
}

/** Valida el tipo de cambio de cada pago planeado y lo anota como error del plan si no sirve. */
function checkExchangeRates(
  plan: OpeningPlan,
  meta: Map<string, { currency: string; exchangeRate: string }>,
): void {
  for (const p of plan.payments) {
    const m = meta.get(p.accountId);
    if (!m) continue;
    if (p.exchangeRate === null) {
      if (m.currency !== 'PEN') {
        plan.warnings.push({
          rowNumber: p.rowNumbers[0] ?? null,
          key: p.key,
          message: `pago en ${m.currency} sin tipo de cambio: se guarda el de la compra (${m.exchangeRate}); no cambia el saldo`,
        });
      }
      continue;
    }
    const rate = /^\d+(\.\d{1,4})?$/.test(p.exchangeRate.replace(',', '.'))
      ? toDecimal(p.exchangeRate.replace(',', '.'))
      : null;
    if (m.currency === 'PEN') {
      plan.warnings.push({
        rowNumber: p.rowNumbers[0] ?? null,
        key: p.key,
        message: 'compra en soles: el tipo de cambio de la fila no se usa',
      });
      p.exchangeRate = null;
    } else if (rate === null || rate.lte(0)) {
      plan.errors.push({
        rowNumber: p.rowNumbers[0] ?? null,
        key: p.key,
        message: `tipo de cambio inválido: «${p.exchangeRate}»`,
      });
    } else {
      p.exchangeRate = rate.toFixed(4);
    }
  }
}

/** Orden de ejecución: por cuenta (id ascendente, regla 17) y, dentro de cada una, por fecha. */
function byAccount(a: PlannedPayment, b: PlannedPayment): number {
  if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1;
  return a.date.localeCompare(b.date);
}

/** Un rechazo del servicio de dominio, con la cuenta que lo causó (el lote se revierte entero). */
async function named<T>(key: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new OpeningBatchRejected(`${key}: ${message}. No se registró nada del lote.`);
  }
}

/** El rótulo de un medio para el informe. */
export function methodLabel(method: PlannedPayment['method']): string {
  return PAYMENT_METHOD_LABELS[method];
}
