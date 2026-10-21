import type { Prisma } from '@prisma/client';
import { Decimal, toFixedString, type RecostPendingDto } from '@ayr/shared';
/** Un ítem del kardex (los de materia prima no tienen kardex propio). */
export interface PendingItem {
  itemType: 'COIL' | 'PRODUCT';
  itemId: string;
}

/**
 * cc63 (RC-01 de audit-02): los recosteos por fecha que superaron el tope y quedaron pendientes.
 * La marca es la auditoría que ya escribía `recostForward` (`inventory.recost-pending`); se resuelve
 * con otra fila de auditoría (`inventory.recost-pending-resolved`) que nombra las marcas que cerró.
 * Así no hace falta tabla nueva y lo pendiente es lo que no tiene su «resuelto».
 */
export const RECOST_PENDING_ACTION = 'inventory.recost-pending';
export const RECOST_RESOLVED_ACTION = 'inventory.recost-pending-resolved';

interface AuditRow {
  id: bigint;
  at: Date;
  after: Prisma.JsonValue;
}

/** Los ítems de una marca (`recostItems: ["COIL:<id>", …]`), sin repetir. */
export function pendingItems(after: Prisma.JsonValue): PendingItem[] {
  const raw = (after as { recostItems?: unknown } | null)?.recostItems;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PendingItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const [itemType, itemId] = entry.split(':');
    if ((itemType !== 'COIL' && itemType !== 'PRODUCT') || !itemId || seen.has(entry)) continue;
    seen.add(entry);
    out.push({ itemType, itemId });
  }
  return out;
}

/** Las marcas que ninguna fila de «resuelto» nombró. */
export function unresolvedPending(
  pending: readonly AuditRow[],
  resolved: readonly { after: Prisma.JsonValue }[],
): AuditRow[] {
  const closed = new Set(
    resolved.flatMap((r) => {
      const ids = (r.after as { pendingAuditIds?: unknown } | null)?.pendingAuditIds;
      return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
    }),
  );
  return pending.filter((p) => !closed.has(p.id.toString()));
}

/** Lo pendiente, más viejo primero, con el código o SKU de cada ítem. */
export async function listPendingRecosts(
  db: Prisma.TransactionClient,
): Promise<RecostPendingDto[]> {
  const [pending, resolved] = await Promise.all([
    db.auditLog.findMany({
      where: { action: RECOST_PENDING_ACTION },
      select: { id: true, at: true, after: true },
      orderBy: { id: 'asc' },
    }),
    db.auditLog.findMany({ where: { action: RECOST_RESOLVED_ACTION }, select: { after: true } }),
  ]);
  const open = unresolvedPending(pending, resolved);
  if (open.length === 0) return [];
  const items = open.flatMap((p) => pendingItems(p.after));
  const coilIds = items.filter((i) => i.itemType === 'COIL').map((i) => i.itemId);
  const productIds = items.filter((i) => i.itemType === 'PRODUCT').map((i) => i.itemId);
  const [coils, products] = await Promise.all([
    coilIds.length > 0
      ? db.coil.findMany({ where: { id: { in: coilIds } }, select: { id: true, code: true } })
      : [],
    productIds.length > 0
      ? db.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true } })
      : [],
  ]);
  const label = new Map<string, string>([
    ...coils.map((c) => [`COIL:${c.id}`, c.code] as const),
    ...products.map((p) => [`PRODUCT:${p.id}`, p.sku] as const),
  ]);
  return open.map((p) => ({
    auditId: p.id.toString(),
    at: p.at.toISOString(),
    rowsReplayed: Number((p.after as { rowsReplayed?: unknown } | null)?.rowsReplayed ?? 0),
    items: pendingItems(p.after).map((i) => ({
      ...i,
      label: label.get(`${i.itemType}:${i.itemId}`) ?? i.itemId,
    })),
  }));
}

/** Lo que hizo (o haría, en el dry-run) completar los pendientes. */
export interface CompletedRecosts {
  pendingAuditIds: string[];
  items: { itemType: 'COIL' | 'PRODUCT'; itemId: string; label: string; adjusts: number }[];
  adjusts: number;
  /** Suma de los cambios de costo, con signo (4 decimales). */
  deltaPen: string;
}

/**
 * cc63 (RC-01, RC-03): completa los recosteos pendientes. Cada ítem se recostea desde su primera
 * fila por la puerta de siempre (`recostForward` en modo histórico, sin tope), una sola vez aunque
 * figure en varias marcas; así también se corrige la salida que agotó el ítem con un valor sin
 * recostear (RC-03). Deja una fila de «resuelto» que nombra las marcas que cerró. El llamador abre
 * la transacción (la CLI la revierte en el dry-run).
 */
export async function completePendingRecosts(
  tx: Prisma.TransactionClient,
  deps: {
    recostForward: (
      tx: Prisma.TransactionClient,
      seeds: { itemType: 'COIL' | 'PRODUCT'; itemId: string; fromStart: true }[],
      ctx: { actorId: string; historic: { label: string } },
    ) => Promise<{ adjusted: { item: { itemType: string; itemId: string }; delta: Decimal }[] }>;
    write: (
      tx: Prisma.TransactionClient,
      entry: {
        actorId: string;
        action: string;
        entity: string;
        entityId: string;
        after: Prisma.InputJsonValue;
      },
    ) => Promise<unknown>;
  },
  actorId: string,
): Promise<CompletedRecosts> {
  const open = await listPendingRecosts(tx);
  if (open.length === 0) return { pendingAuditIds: [], items: [], adjusts: 0, deltaPen: '0.0000' };
  const byKey = new Map<string, CompletedRecosts['items'][number]>();
  for (const p of open) {
    for (const i of p.items) byKey.set(`${i.itemType}:${i.itemId}`, { ...i, adjusts: 0 });
  }
  const seeds = [...byKey.values()].map((i) => ({
    itemType: i.itemType,
    itemId: i.itemId,
    fromStart: true as const,
  }));
  const outcome = await deps.recostForward(tx, seeds, {
    actorId,
    historic: { label: 'Recosteo pendiente completado' },
  });
  let delta = new Decimal(0);
  for (const a of outcome.adjusted) {
    const row = byKey.get(`${a.item.itemType}:${a.item.itemId}`);
    if (row) row.adjusts += 1;
    delta = delta.plus(a.delta);
  }
  const result: CompletedRecosts = {
    pendingAuditIds: open.map((p) => p.auditId),
    items: [...byKey.values()],
    adjusts: outcome.adjusted.length,
    deltaPen: toFixedString(delta, 'MONEY'),
  };
  await deps.write(tx, {
    actorId,
    action: RECOST_RESOLVED_ACTION,
    entity: 'inventory_movements',
    entityId: result.pendingAuditIds.join(',').slice(0, 80),
    after: {
      pendingAuditIds: result.pendingAuditIds,
      items: result.items.map((i) => `${i.itemType}:${i.itemId}`),
      adjusts: result.adjusts,
      deltaPen: result.deltaPen,
    },
  });
  return result;
}
