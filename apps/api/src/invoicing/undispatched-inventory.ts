import { DispatchStatus, FiscalDocType, type Prisma } from '@prisma/client';
import {
  planPurchaseReceivedDates,
  type ReceivedDateCase,
} from '../purchases/purchase-received-date-fix';
import type { InvoiceDispatchService, InvoiceDispatchPlan } from './invoice-dispatch.service';
import type { PlannedInvoice } from './invoice-dispatch-plan';

export type UndispatchedVerdict =
  'DESPACHABLE' | 'BLOQUEADO-FECHA-COMPRA' | 'BLOQUEADO-APERTURA' | 'BLOQUEADO-RECOSTEO';

export interface UndispatchedRow {
  number: string;
  issueDate: string;
  status: string;
  lines: {
    sku: string;
    qty: string;
    action: string;
    operationDate: string;
    reason: string | null;
  }[];
  verdict: UndispatchedVerdict;
  purchases: { id: string; document: string }[];
}

export interface UndispatchedInspection {
  branch: string;
  snapshotUtc: string;
  counts: {
    status: string;
    documents: number;
    pending: number;
    withoutDeclaredDispatch: number;
  }[];
  rows: UndispatchedRow[];
}

type Simulate = (cases: readonly ReceivedDateCase[]) => Promise<InvoiceDispatchPlan>;

export function assertInspectionArgs(args: readonly string[]): void {
  if (args.length !== 0)
    throw new Error(`Este subcomando es solo lectura y no acepta argumentos: ${args[0] ?? ''}`);
}

export function countUndispatchedByStatus(
  documents: readonly {
    status: string;
    items: readonly unknown[];
    dispatchesInvoiced: readonly unknown[];
  }[],
  rows: readonly { status: string }[],
): UndispatchedInspection['counts'] {
  const statuses = [...new Set([...documents.map((d) => d.status), 'ANNULLED', 'VOIDED'])].sort();
  return statuses.map((status) => ({
    status,
    documents: documents.filter((d) => d.status === status).length,
    pending: rows.filter((r) => r.status === status).length,
    withoutDeclaredDispatch: documents.filter(
      (d) => d.status === status && d.items.length > 0 && d.dispatchesInvoiced.length === 0,
    ).length,
  }));
}

function allDispatch(plan: InvoiceDispatchPlan, invoice: PlannedInvoice): boolean {
  const after = plan.invoices.find((p) => p.invoiceId === invoice.invoiceId);
  return (
    after?.lines.length === invoice.lines.length &&
    after.lines.every((line) => line.action === 'DISPATCH')
  );
}

/** Usa la reclasificación de compras y vuelve a correr el mismo plan/firstNegativeDate. */
export async function classifyUndispatchedInvoice(
  invoice: PlannedInvoice,
  purchaseCases: readonly ReceivedDateCase[],
  sourceTypes: ReadonlyMap<string, ReadonlySet<string>>,
  simulate: Simulate,
): Promise<{ verdict: UndispatchedVerdict; purchases: ReceivedDateCase[] }> {
  if (invoice.lines.every((line) => line.action === 'DISPATCH'))
    return { verdict: 'DESPACHABLE', purchases: [] };

  const blocked = invoice.lines.filter((line) => line.action !== 'DISPATCH');
  const keys = new Set(blocked.flatMap((line) => (line.itemKey === null ? [] : [line.itemKey])));
  const relevant = purchaseCases.filter(
    (c) =>
      c.destinationDate <= invoice.issueDate &&
      c.currentDate > invoice.issueDate &&
      c.items.some((item) => keys.has(item.key)),
  );
  let safe = relevant.filter((c) => c.safe);
  if (safe.length > 0 && allDispatch(await simulate(safe), invoice)) {
    // El conjunto mínimo por eliminación evita recomendar compras seguras innecesarias.
    for (const candidate of [...safe]) {
      const without = safe.filter((c) => c.purchaseId !== candidate.purchaseId);
      if (without.length > 0 && allDispatch(await simulate(without), invoice)) safe = without;
    }
    return { verdict: 'BLOQUEADO-FECHA-COMPRA', purchases: safe };
  }

  if (
    relevant.some(
      (c) =>
        !c.safe &&
        c.reasons.some(
          (reason) =>
            reason.includes('Salida posterior') || reason.includes('Ajuste de costo posterior'),
        ),
    )
  )
    return { verdict: 'BLOQUEADO-RECOSTEO', purchases: [] };

  if (
    keys.size > 0 &&
    blocked.every((line) => line.itemKey !== null) &&
    [...keys].every((key) => {
      const sources = sourceTypes.get(key);
      return sources?.size === 1 && sources.has('IMPORT');
    })
  )
    return { verdict: 'BLOQUEADO-APERTURA', purchases: [] };

  throw new Error(
    `El comprobante ${invoice.number} tiene una causa fuera de las cuatro clases: ` +
      blocked.map((line) => `${line.sku}: ${line.reason ?? line.action}`).join('; '),
  );
}

/** Solo Prisma ORM y servicios de dominio; el llamador abre una transacción READ ONLY. */
export async function inspectUndispatchedInvoices(
  tx: Prisma.TransactionClient,
  dispatch: InvoiceDispatchService,
  branch: string,
): Promise<UndispatchedInspection> {
  const plan = await dispatch.buildPlan(tx, {});
  const purchases = await planPurchaseReceivedDates(tx);
  const documents = await tx.fiscalDocument.findMany({
    where: { docType: { in: [FiscalDocType.FACTURA, FiscalDocType.BOLETA] }, archivedAt: null },
    select: {
      id: true,
      status: true,
      items: { where: { salesOrderItemId: { not: null } }, select: { id: true } },
      dispatchesInvoiced: { where: { status: DispatchStatus.ISSUED }, select: { id: true } },
    },
  });
  const ids = [
    ...new Set(
      plan.invoices.flatMap((invoice) =>
        invoice.lines.flatMap((line) =>
          line.itemKey === null ? [] : [line.itemKey.split(':')[1] ?? ''],
        ),
      ),
    ),
  ].filter(Boolean);
  const movements =
    ids.length === 0
      ? []
      : await tx.inventoryMovement.findMany({
          where: { itemId: { in: ids }, type: 'IN' },
          select: { itemType: true, itemId: true, refType: true },
        });
  const sourceTypes = new Map<string, Set<string>>();
  for (const movement of movements) {
    const key = `${movement.itemType}:${movement.itemId}`;
    const types = sourceTypes.get(key) ?? new Set<string>();
    types.add(movement.refType);
    sourceTypes.set(key, types);
  }
  const simulate: Simulate = async (cases) => {
    const movedPurchaseEntries = new Map(
      cases.flatMap((c) => c.movementIds.map((id) => [id, c.destinationDate] as const)),
    );
    return dispatch.buildPlan(tx, {}, { movedPurchaseEntries });
  };
  const rows: UndispatchedRow[] = [];
  for (const invoice of plan.invoices) {
    const classification = await classifyUndispatchedInvoice(
      invoice,
      purchases,
      sourceTypes,
      simulate,
    );
    const status = documents.find((d) => d.id === invoice.invoiceId)?.status;
    if (status === undefined) throw new Error(`Estado ausente para ${invoice.number}`);
    rows.push({
      number: invoice.number,
      issueDate: invoice.issueDate,
      status,
      lines: invoice.lines.map((line) => ({
        sku: line.sku,
        qty: line.qty.toFixed(3),
        action: line.action,
        operationDate: line.operationDate,
        reason: line.reason,
      })),
      verdict: classification.verdict,
      purchases: classification.purchases.map((c) => ({ id: c.purchaseId, document: c.document })),
    });
  }
  return {
    branch,
    snapshotUtc: new Date().toISOString(),
    counts: countUndispatchedByStatus(documents, rows),
    rows,
  };
}
