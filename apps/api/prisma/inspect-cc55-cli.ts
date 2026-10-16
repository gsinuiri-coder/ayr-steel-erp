/**
 * cc55 — **chequeos previos de las correcciones de datos** (corte C). Solo lectura: una
 * transacción `READ ONLY`, sin modo execute. Imprime un JSON en stdout (para `local-data/cc55/`,
 * fuera del repo) y un resumen en stderr.
 *
 * 1. Re-fecha de D-278: los despachos vigentes cuyo comprobante es de un mes anterior al de su
 *    salida. Para cada uno simula mover sus salidas de kardex a la fecha del comprobante (al final
 *    de ese día, en orden) y mide con el motor de D-652 (`negativeSpans`) si algún ítem queda
 *    negativo en alguna fecha. No escribe nada: la simulación es en memoria.
 * 2. La línea 22 de la compra 118-315630: la bobina, sus movimientos y **toda** la auditoría que la
 *    nombra (quién, cuándo, motivo de cada cambio de precio).
 */
import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { LIVE_DOCUMENT_STATUSES, toDecimal } from '@ayr/shared';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import {
  negativeSpans,
  qtyRowsFromMovements,
  type QtyMovement,
} from '../src/inventory/recost-engine';

type Tx = Prisma.TransactionClient;
const day = (d: Date | null | undefined): string | null =>
  d ? d.toISOString().slice(0, 10) : null;
const LIVE = [...LIVE_DOCUMENT_STATUSES];
const COIL_CODE = 'IMPO-ALZ-AZUL-5002-0.28-4150-23';

async function redatePlan(tx: Tx) {
  const docs = await tx.fiscalDocument.findMany({
    where: { docType: { in: ['FACTURA', 'BOLETA'] }, status: { in: LIVE }, archivedAt: null },
    select: {
      id: true,
      number: true,
      issueDate: true,
      dispatchesInvoiced: {
        where: { status: 'ISSUED' },
        select: {
          id: true,
          seq: true,
          dispatchDate: true,
          items: { select: { movementId: true, itemType: true, itemId: true, qty: true } },
        },
      },
    },
  });
  const targets = docs.flatMap((d) =>
    d.dispatchesInvoiced
      .filter((x) => day(x.dispatchDate)!.slice(0, 7) !== day(d.issueDate)!.slice(0, 7))
      .map((x) => ({ doc: d, dispatch: x })),
  );
  const sepToOct = targets.filter(
    (t) =>
      day(t.doc.issueDate)!.startsWith('2026-09') &&
      day(t.dispatch.dispatchDate)!.startsWith('2026-10'),
  );
  const moving = new Map<string, string>(); // movementId → fecha nueva
  for (const t of sepToOct)
    for (const i of t.dispatch.items)
      if (i.movementId !== null) moving.set(i.movementId.toString(), day(t.doc.issueDate)!);
  const itemKeys = new Set(
    sepToOct.flatMap((t) => t.dispatch.items.map((i) => `${i.itemType}:${i.itemId}`)),
  );
  const labels = new Map<string, string>([
    ...(await tx.product.findMany({ select: { id: true, sku: true } })).map(
      (p) => [p.id, p.sku] as const,
    ),
    ...(await tx.coil.findMany({ select: { id: true, code: true } })).map(
      (c) => [c.id, c.code] as const,
    ),
  ]);
  const items: unknown[] = [];
  let itemsNegative = 0;
  for (const key of itemKeys) {
    const [itemType, itemId] = key.split(':') as ['PRODUCT' | 'COIL', string];
    const rows = await tx.inventoryMovement.findMany({
      where: { itemType, itemId, type: { in: ['IN', 'OUT'] } },
      orderBy: [{ operationDate: 'asc' }, { at: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        type: true,
        qty: true,
        operationDate: true,
        reversalOfId: true,
        refType: true,
      },
    });
    const toQty = (r: (typeof rows)[number], date: string): QtyMovement => ({
      id: r.id,
      reversalOfId: r.reversalOfId,
      date,
      type: r.type,
      qty: toDecimal(r.qty.toString()),
    });
    const before = negativeSpans(
      qtyRowsFromMovements(rows.map((r) => toQty(r, day(r.operationDate)!))),
    );
    // Las salidas movidas van al final de su día nuevo (criterio de D-652), en su orden de registro.
    const kept = rows.filter((r) => !moving.has(r.id.toString()));
    const moved = rows.filter((r) => moving.has(r.id.toString()));
    const simulated = [
      ...kept.map((r) => ({ r, date: day(r.operationDate)!, late: 0 })),
      ...moved.map((r) => ({ r, date: moving.get(r.id.toString())!, late: 1 })),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.late - b.late || Number(a.r.id - b.r.id));
    const after = negativeSpans(qtyRowsFromMovements(simulated.map((s) => toQty(s.r, s.date))));
    const firstIn = rows.find((r) => r.type === 'IN');
    if (after.length > 0) itemsNegative += 1;
    items.push({
      item: labels.get(itemId) ?? itemId,
      movedOuts: moved.length,
      firstEntry: firstIn ? day(firstIn.operationDate) : null,
      negativeBefore: before,
      negativeAfter: after,
    });
  }
  return {
    allCrossMonth: targets.length,
    sepToOct: {
      dispatches: sepToOct.length,
      invoices: new Set(sepToOct.map((t) => t.doc.id)).size,
      movements: moving.size,
      items: itemKeys.size,
      itemsNegativeAfter: itemsNegative,
      list: sepToOct.map((t) => ({
        number: t.doc.number,
        issueDate: day(t.doc.issueDate),
        dispatch: `DES-${String(t.dispatch.seq).padStart(6, '0')}`,
        dispatchDate: day(t.dispatch.dispatchDate),
      })),
    },
    items,
  };
}

async function coilAudit(tx: Tx) {
  const coil = await tx.coil.findUnique({
    where: { code: COIL_CODE },
    select: {
      id: true,
      code: true,
      unitCostPerKg: true,
      totalCost: true,
      totalCostPen: true,
      status: true,
      purchaseId: true,
      purchaseItemId: true,
      notes: true,
    },
  });
  if (!coil) return null;
  const item = coil.purchaseItemId
    ? await tx.purchaseItem.findUnique({ where: { id: coil.purchaseItemId } })
    : null;
  const movements = await tx.inventoryMovement.findMany({
    where: { itemType: 'COIL', itemId: coil.id },
    orderBy: [{ operationDate: 'asc' }, { at: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      type: true,
      qty: true,
      unitCost: true,
      totalCost: true,
      refType: true,
      refId: true,
      reversalOfId: true,
      recostOfId: true,
      operationDate: true,
      at: true,
      notes: true,
      actorId: true,
    },
  });
  const ids = [coil.id, coil.purchaseId, coil.purchaseItemId, coil.code].filter(
    (x): x is string => !!x,
  );
  const logs = await tx.auditLog.findMany({
    where: { at: { gte: new Date('2026-09-01T00:00:00Z') } },
    orderBy: { at: 'asc' },
    select: {
      id: true,
      action: true,
      entity: true,
      entityId: true,
      at: true,
      actorId: true,
      actorKind: true,
      reason: true,
      before: true,
      after: true,
      requestId: true,
    },
  });
  const users = new Map(
    (await tx.user.findMany({ select: { id: true, email: true } })).map((u) => [
      u.id,
      u.email.replace(/^(.{2}).*(@.*)$/, '$1***$2'),
    ]),
  );
  const touching = logs.filter((l) => {
    if (l.entityId && ids.includes(l.entityId)) return true;
    const text = JSON.stringify([l.before, l.after]);
    return ids.some((id) => text.includes(id));
  });
  return {
    coil: {
      ...coil,
      unitCostPerKg: coil.unitCostPerKg.toString(),
      totalCost: coil.totalCost.toString(),
      totalCostPen: coil.totalCostPen.toString(),
    },
    purchaseItem: item
      ? {
          line: item.lineNumber,
          qty: item.qty.toString(),
          unitPrice: item.unitPrice.toString(),
          subtotal: item.subtotal.toString(),
        }
      : null,
    movements: movements.map((m) => ({
      id: m.id.toString(),
      date: day(m.operationDate),
      at: m.at.toISOString(),
      type: m.type,
      qty: m.qty.toString(),
      unitCost: m.unitCost.toString(),
      totalCost: m.totalCost.toString(),
      ref: `${m.refType}:${m.refId ?? ''}`,
      reversalOf: m.reversalOfId?.toString() ?? null,
      recostOf: m.recostOfId?.toString() ?? null,
      notes: m.notes,
      actor: m.actorId ? (users.get(m.actorId) ?? m.actorId) : null,
    })),
    audit: touching.map((l) => ({
      id: l.id.toString(),
      at: l.at.toISOString(),
      action: l.action,
      entity: l.entity,
      actor: l.actorId ? (users.get(l.actorId) ?? l.actorId) : l.actorKind,
      reason: l.reason,
      requestId: l.requestId,
      before: l.before,
      after: l.after,
    })),
  };
}

async function main(): Promise<void> {
  if (process.argv.slice(2).length > 0) throw new Error('Uso: inspect:cc55 (sin argumentos)');
  assertExecuteAllowed(false);
  assertExternalOutputsOff(process.env, (line) => {
    console.error(line);
  });
  if (!process.env.AYR_CLI_BRANCH) throw new Error('Ejecutá este subcomando mediante runApiCli');
  const db = new PrismaClient();
  try {
    const report = await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return {
          generatedAt: new Date().toISOString(),
          redate: await redatePlan(tx),
          coil: await coilAudit(tx),
        };
      },
      { timeout: 300_000, maxWait: 30_000 },
    );
    process.stdout.write(
      JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n',
    );
    const s = report.redate.sepToOct;
    console.error(
      `Re-fecha sep→oct: ${String(s.dispatches)} despachos de ${String(s.invoices)} comprobantes, ${String(s.movements)} salidas, ${String(s.items)} ítems; con negativo después: ${String(s.itemsNegativeAfter)}`,
    );
    console.error(`Auditoría de ${COIL_CODE}: ${String(report.coil?.audit.length ?? 0)} registros`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
