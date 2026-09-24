import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  DispatchStatus,
  FiscalDocType,
  FiscalDocumentStatus,
  Prisma,
  SalesOrderStatus,
} from '@prisma/client';
import {
  carriesInventory,
  Decimal,
  LIVE_DOCUMENT_STATUSES,
  salesOrderCode,
  toDecimal,
  TransferMode,
  type InvoiceDispatchPlanDto,
  type InvoiceDispatchResultDto,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { assertSellerAccess } from '../auth/seller-scope';
import { OperationDateService } from '../common/operation-date.service';
import { PrismaService } from '../prisma/prisma.service';
import { findLineReservation, resolveDispatchTarget } from '../sales/reservation-transfer';
import { DispatchesService } from './dispatches.service';
import {
  allocateUndispatched,
  planInvoiceDispatches,
  type PlanInvoice,
  type PlanItemKardex,
  type PlannedInvoice,
  type PlanTarget,
} from './invoice-dispatch-plan';
import { proratedQty } from './invoicing-math';

const LIVE: FiscalDocumentStatus[] = [...LIVE_DOCUMENT_STATUSES];
const SALE_DOCS: FiscalDocType[] = [FiscalDocType.FACTURA, FiscalDocType.BOLETA];

/** Motivos que quedan en la auditoría y en la nota de cada salida (D-278). */
export const AT_ISSUE_DATE_REASON = 'despacho a la fecha del comprobante';
export const BEFORE_OPENING_REASON = 'entregado antes del inventario inicial';

export interface PlanItemInfo {
  key: string;
  label: string;
  unit: string;
  openingDate: string | null;
  balanceQty: Decimal;
  avgCost: Decimal;
}

export interface InvoiceDispatchPlan {
  invoices: (PlannedInvoice & { orderCode: string; sellerId: string | null })[];
  items: Map<string, PlanItemInfo>;
}

function day(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * D-278: despacho de lo facturado y no despachado, a la fecha del comprobante.
 *
 * Todo lo que escribe pasa por `DispatchesService.createInTx` —y de ahí por
 * `InventoryService.record` (regla dura 8)—: un despacho de recojo (sin guía) fechado el día de
 * emisión, enlazado al comprobante (D-205). Las líneas entregadas antes del inventario inicial
 * van en un despacho aparte, sin salida de kardex, para que el pedido quede entregado por el
 * mismo cálculo de siempre (`recomputeOrderStatus` mira los despachos vigentes) y la reserva se
 * descuente por el camino de siempre.
 */
@Injectable()
export class InvoiceDispatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatches: DispatchesService,
    private readonly audit: AuditService,
    private readonly operationDate: OperationDateService,
  ) {}

  /** Qué haría el botón «Despachar a la fecha del comprobante», sin escribir nada. */
  async preview(actor: RequestUser, invoiceId: string): Promise<InvoiceDispatchPlanDto> {
    const plan = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return this.buildPlan(tx, { id: invoiceId });
      },
      { timeout: 30_000 },
    );
    const invoice = plan.invoices[0];
    if (invoice === undefined) return { invoiceId, lines: [] };
    assertSellerAccess(actor, invoice.sellerId, 'Comprobante');
    return toPlanDto(invoice, plan.items);
  }

  /** El botón: despacha lo que el plan permite y devuelve lo que quedó a revisión. */
  async executeForInvoice(
    actor: RequestUser,
    invoiceId: string,
  ): Promise<InvoiceDispatchResultDto> {
    return this.prisma.$transaction((tx) => this.executeInTx(tx, actor, invoiceId), {
      // Un despacho por comprobante, con los locks de bobina y saldo de siempre.
      timeout: 60_000,
    });
  }

  /**
   * Ejecuta un comprobante dentro de la transacción del llamador (la CLI abre una por
   * comprobante). `expected`, si viene, es la línea del dry-run: si el plan de ahora no
   * coincide, se para sin escribir.
   */
  async executeInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    invoiceId: string,
    expected?: PlannedInvoice,
  ): Promise<InvoiceDispatchResultDto> {
    const exists = await tx.fiscalDocument.findUnique({
      where: { id: invoiceId },
      select: { id: true },
    });
    if (exists === null) throw new NotFoundException('Comprobante no encontrado');
    const plan = await this.buildPlan(tx, { id: invoiceId });
    const invoice = plan.invoices[0];
    if (invoice === undefined) {
      throw new BadRequestException('El comprobante no tiene líneas facturadas sin despachar');
    }
    assertSellerAccess(actor, invoice.sellerId, 'Comprobante');
    if (expected !== undefined && planSignature(expected) !== planSignature(invoice)) {
      throw new BadRequestException(
        `El plan de ${invoice.number} cambió desde el dry-run: ${planSignature(expected)} → ${planSignature(invoice)}`,
      );
    }

    const toDispatch = invoice.lines.filter((l) => l.action === 'DISPATCH');
    const beforeOpening = invoice.lines.filter((l) => l.action === 'BEFORE_OPENING');
    if (toDispatch.length === 0 && beforeOpening.length === 0) {
      throw new BadRequestException(
        `Ninguna línea de ${invoice.number} se puede despachar a la fecha del comprobante: ` +
          invoice.lines.map((l) => `línea ${String(l.lineNumber)}: ${l.reason ?? ''}`).join('; '),
      );
    }

    const pickup = await this.dispatches.pickupLocationInTx(tx);
    const base = {
      salesOrderId: invoice.salesOrderId,
      dispatchDate: invoice.issueDate,
      // La retrofecha es el propósito: el acuse de orden cronológico va implícito y queda en
      // la auditoría del despacho. El plan ya comprobó que el kardex no queda negativo.
      confirmBackdate: true,
      originAddress: pickup.address,
      destinationAddress: pickup.address,
      originUbigeo: pickup.ubigeo,
      destinationUbigeo: pickup.ubigeo,
      transferMode: TransferMode.PICKUP,
    };
    const dispatchIds: string[] = [];
    if (toDispatch.length > 0) {
      const id = await this.dispatches.createInTx(
        tx,
        actor,
        {
          ...base,
          notes: `Despacho a la fecha del comprobante ${invoice.number} (D-278)`,
          items: toDispatch.map((l) => ({
            salesOrderItemId: l.orderItemId,
            qty: l.qty.toFixed(3),
          })),
        },
        {
          movementNote: `${AT_ISSUE_DATE_REASON} ${invoice.number}`,
          auditReason: AT_ISSUE_DATE_REASON,
        },
      );
      await this.dispatches.linkInvoiceInTx(tx, id, invoice.invoiceId);
      dispatchIds.push(id);
    }
    if (beforeOpening.length > 0) {
      const id = await this.dispatches.createInTx(
        tx,
        actor,
        {
          ...base,
          notes: `Entregado antes del inventario inicial — comprobante ${invoice.number} (D-278)`,
          items: beforeOpening.map((l) => ({
            salesOrderItemId: l.orderItemId,
            qty: l.qty.toFixed(3),
          })),
        },
        {
          deliveredBeforeOpening: new Set(beforeOpening.map((l) => l.orderItemId)),
          auditReason: BEFORE_OPENING_REASON,
        },
      );
      await this.dispatches.linkInvoiceInTx(tx, id, invoice.invoiceId);
      dispatchIds.push(id);
    }

    const order = await tx.salesOrder.findUniqueOrThrow({
      where: { id: invoice.salesOrderId },
      select: { status: true },
    });
    await this.audit.write(tx, {
      actorId: actor.id,
      action: 'invoicing.dispatch-at-issue-date',
      entity: 'fiscal_documents',
      entityId: invoice.invoiceId,
      after: {
        number: invoice.number,
        issueDate: invoice.issueDate,
        salesOrder: invoice.orderCode,
        dispatchIds,
        orderStatus: order.status,
        lines: invoice.lines.map((l) => ({
          line: l.lineNumber,
          sku: l.sku,
          qty: l.qty.toFixed(3),
          action: l.action,
          reason:
            l.action === 'DISPATCH'
              ? AT_ISSUE_DATE_REASON
              : l.action === 'BEFORE_OPENING'
                ? BEFORE_OPENING_REASON
                : l.reason,
        })),
      },
    });
    const dto = toPlanDto(invoice, plan.items);
    return { ...dto, dispatchIds, orderStatus: order.status };
  }

  /** El dry-run de la CLI: todos los comprobantes vivos con algo facturado sin despachar. */
  async planAll(): Promise<InvoiceDispatchPlan> {
    // READ ONLY: el dry-run contra production no puede escribir aunque algo se lo pida.
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return this.buildPlan(tx, {});
      },
      { timeout: 120_000 },
    );
  }

  /**
   * El plan. `where` acota los comprobantes a mirar; el resto de lo que decide (lo ya
   * facturado y despachado de cada línea, el kardex de cada ítem) se lee entero.
   */
  async buildPlan(
    tx: Prisma.TransactionClient,
    where: Prisma.FiscalDocumentWhereInput,
  ): Promise<InvoiceDispatchPlan> {
    const invoices = await tx.fiscalDocument.findMany({
      where: {
        ...where,
        docType: { in: SALE_DOCS },
        status: { in: LIVE },
        salesOrder: { status: { not: SalesOrderStatus.CANCELLED } },
      },
      select: {
        id: true,
        number: true,
        issueDate: true,
        salesOrderId: true,
        salesOrder: { select: { seq: true, sellerId: true } },
        items: {
          where: { salesOrderItemId: { not: null } },
          select: { id: true, salesOrderItemId: true },
        },
      },
    });
    const orderItemIds = [
      ...new Set(invoices.flatMap((i) => i.items.map((it) => it.salesOrderItemId ?? ''))),
    ].filter((id) => id !== '');
    if (orderItemIds.length === 0) return { invoices: [], items: new Map() };

    const [orderItems, invoicedRows, dispatchedRows] = await Promise.all([
      tx.salesOrderItem.findMany({
        where: { id: { in: orderItemIds } },
        select: {
          id: true,
          lineNumber: true,
          productId: true,
          qty: true,
          reserveItemType: true,
          reserveItemId: true,
          reserveQty: true,
          reserveUnit: true,
          product: {
            select: { sku: true, businessLine: { select: { inventoryStrategy: true } } },
          },
        },
      }),
      tx.fiscalDocumentItem.findMany({
        where: {
          salesOrderItemId: { in: orderItemIds },
          document: { docType: { in: SALE_DOCS }, status: { in: LIVE } },
        },
        select: {
          id: true,
          salesOrderItemId: true,
          qty: true,
          document: { select: { id: true, issueDate: true, number: true } },
        },
      }),
      tx.dispatchItem.groupBy({
        by: ['salesOrderItemId'],
        where: {
          salesOrderItemId: { in: orderItemIds },
          dispatch: { status: DispatchStatus.ISSUED },
        },
        _sum: { qty: true },
      }),
    ]);
    const credited = await tx.fiscalDocumentItem.groupBy({
      by: ['affectedItemId'],
      where: {
        affectedItemId: { in: invoicedRows.map((r) => r.id) },
        document: { status: { in: LIVE } },
      },
      _sum: { qty: true },
    });
    const creditedById = new Map(
      credited.map((c) => [c.affectedItemId ?? '', toDecimal((c._sum.qty ?? 0).toString())]),
    );
    const dispatchedByItem = new Map(
      dispatchedRows.map((r) => [r.salesOrderItemId, toDecimal((r._sum.qty ?? 0).toString())]),
    );

    // Lo facturado y no despachado de cada línea de comprobante.
    const undispatched = new Map<string, Decimal>();
    for (const item of orderItems) {
      const rows = invoicedRows
        .filter((r) => r.salesOrderItemId === item.id)
        .sort((a, b) =>
          day(a.document.issueDate) === day(b.document.issueDate)
            ? (a.document.number ?? '').localeCompare(b.document.number ?? '')
            : day(a.document.issueDate) < day(b.document.issueDate)
              ? -1
              : 1,
        );
      const nets = rows.map((r) =>
        Decimal.max(
          new Decimal(0),
          toDecimal(r.qty.toString()).minus(creditedById.get(r.id) ?? new Decimal(0)),
        ),
      );
      const takes = allocateUndispatched(
        toDecimal(item.qty.toString()),
        dispatchedByItem.get(item.id) ?? new Decimal(0),
        nets,
      );
      rows.forEach((r, i) => undispatched.set(r.id, takes[i] ?? new Decimal(0)));
    }

    // Destino de kardex de cada línea: el mismo que usaría el despacho.
    const historicalStart = this.operationDate.historicalLoadStart;
    const itemById = new Map(orderItems.map((i) => [i.id, i]));
    const targets = new Map<
      string,
      | {
          ok: true;
          itemType: string;
          itemId: string;
          unit: string;
          fromProduction: boolean;
          held: Decimal | null;
        }
      | { ok: false; reason: string }
    >();
    for (const item of orderItems) {
      if (!carriesInventory(item.product.businessLine)) continue;
      try {
        const target = await resolveDispatchTarget(tx, item);
        const held =
          target.fromProduction && target.reservationId !== null
            ? await findLineReservation(tx, item.id, target.itemType, target.itemId)
            : null;
        targets.set(item.id, {
          ok: true,
          itemType: target.itemType,
          itemId: target.itemId,
          unit: target.unit,
          fromProduction: target.fromProduction,
          held: held === null ? null : toDecimal(held.qty.toString()),
        });
      } catch (err) {
        if (!(err instanceof BadRequestException)) throw err;
        targets.set(item.id, { ok: false, reason: err.message });
      }
    }

    const planInputs: PlanInvoice[] = [];
    const meta = new Map<string, { orderCode: string; sellerId: string | null }>();
    for (const inv of invoices) {
      if (inv.salesOrderId === null || inv.salesOrder === null) continue;
      const qtyByItem = new Map<string, Decimal>();
      for (const it of inv.items) {
        const orderItemId = it.salesOrderItemId ?? '';
        const take = undispatched.get(it.id) ?? new Decimal(0);
        if (take.lte(0) || !targets.has(orderItemId)) continue;
        qtyByItem.set(orderItemId, (qtyByItem.get(orderItemId) ?? new Decimal(0)).plus(take));
      }
      if (qtyByItem.size === 0) continue;
      const issueDate = day(inv.issueDate);
      planInputs.push({
        invoiceId: inv.id,
        number: inv.number ?? inv.id,
        salesOrderId: inv.salesOrderId,
        issueDate,
        lines: [...qtyByItem].map(([orderItemId, qty]) => {
          const item = itemById.get(orderItemId);
          const t = targets.get(orderItemId);
          if (item === undefined || t === undefined) throw new Error('línea sin destino');
          let target: PlanTarget;
          if (!t.ok) {
            target = { ok: false, reason: t.reason };
          } else if (issueDate < historicalStart) {
            target = {
              ok: false,
              reason: `El comprobante es anterior al inicio de la carga histórica (${historicalStart})`,
            };
          } else {
            const reserveQty = t.fromProduction
              ? qty
              : proratedQty(qty, item.qty.toString(), item.reserveQty.toString());
            target =
              t.held !== null && reserveQty.gt(t.held)
                ? {
                    ok: false,
                    reason: `Hay ${t.held.toFixed(3)} ${t.unit} fabricados y reservados para la línea y se facturaron ${reserveQty.toFixed(3)}: falta producir`,
                  }
                : { ok: true, itemKey: `${t.itemType}:${t.itemId}`, reserveQty };
          }
          return {
            orderItemId,
            lineNumber: item.lineNumber,
            sku: item.product.sku,
            qty,
            target,
          };
        }),
      });
      meta.set(inv.id, {
        orderCode: salesOrderCode(inv.salesOrder.seq),
        sellerId: inv.salesOrder.sellerId,
      });
    }

    // Kardex y datos de cada ítem que el plan toca.
    const keys = [
      ...new Set(
        planInputs.flatMap((p) => p.lines.flatMap((l) => (l.target.ok ? [l.target.itemKey] : []))),
      ),
    ];
    const ids = keys.map((k) => k.split(':')[1] ?? '');
    const [movements, balances, products, coils] = await Promise.all([
      tx.inventoryMovement.findMany({
        where: { itemId: { in: ids } },
        orderBy: [{ operationDate: 'asc' }, { id: 'asc' }],
        select: {
          itemType: true,
          itemId: true,
          type: true,
          qty: true,
          refType: true,
          operationDate: true,
        },
      }),
      tx.inventoryBalance.findMany({
        where: { itemId: { in: ids } },
        select: { itemType: true, itemId: true, qty: true, avgCost: true, unit: true },
      }),
      tx.product.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true } }),
      tx.coil.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } }),
    ]);
    const kardex = new Map<string, PlanItemKardex>();
    for (const m of movements) {
      const key = `${m.itemType}:${m.itemId}`;
      const entry = kardex.get(key) ?? { openingDate: null, movements: [] };
      const qty = toDecimal(m.qty.toString());
      entry.movements.push({
        date: day(m.operationDate),
        signedQty: m.type === 'IN' ? qty : m.type === 'OUT' ? qty.negated() : new Decimal(0),
      });
      if (m.type === 'IN' && m.refType === 'IMPORT' && entry.openingDate === null) {
        entry.openingDate = day(m.operationDate);
      }
      kardex.set(key, entry);
    }
    const labelById = new Map<string, string>([
      ...products.map((p) => [p.id, p.sku] as [string, string]),
      ...coils.map((c) => [c.id, c.code] as [string, string]),
    ]);
    const items = new Map<string, PlanItemInfo>();
    for (const key of keys) {
      const [, itemId = ''] = key.split(':');
      const balance = balances.find((b) => `${b.itemType}:${b.itemId}` === key);
      items.set(key, {
        key,
        label: labelById.get(itemId) ?? itemId,
        unit: balance?.unit ?? '',
        openingDate: kardex.get(key)?.openingDate ?? null,
        balanceQty: toDecimal((balance?.qty ?? 0).toString()),
        avgCost: toDecimal((balance?.avgCost ?? 0).toString()),
      });
    }

    const planned = planInvoiceDispatches(planInputs, kardex);
    return {
      invoices: planned.map((p) => ({
        ...p,
        orderCode: meta.get(p.invoiceId)?.orderCode ?? '',
        sellerId: meta.get(p.invoiceId)?.sellerId ?? null,
      })),
      items,
    };
  }
}

/** Huella comparable de un plan: la CLI para si el de la ejecución no es el del dry-run. */
export function planSignature(invoice: PlannedInvoice): string {
  return invoice.lines
    .map(
      (l) =>
        `${String(l.lineNumber)}:${l.action}:${l.qty.toFixed(3)}:${l.reserveQty.toFixed(3)}:${l.itemKey ?? '-'}`,
    )
    .join('|');
}

function toPlanDto(
  invoice: PlannedInvoice,
  items: Map<string, PlanItemInfo>,
): InvoiceDispatchPlanDto {
  return {
    invoiceId: invoice.invoiceId,
    lines: invoice.lines.map((l) => ({
      lineNumber: l.lineNumber,
      sku: l.sku,
      qty: l.qty.toFixed(3),
      itemLabel: l.itemKey === null ? null : (items.get(l.itemKey)?.label ?? null),
      action: l.action,
      operationDate: l.operationDate,
      reason: l.reason,
    })),
  };
}
