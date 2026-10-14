import type {
  InventoryItemType,
  InventoryMovementType,
  InventoryRefType,
  Prisma,
} from '@prisma/client';
import { Decimal, toDecimal } from '@ayr/shared';
import {
  prorateDelta,
  RECOST_MAX_ROWS,
  replayItem,
  stockBefore,
  rowCostOfRecost,
  type ExternalCost,
  type RecostRow,
  type RecostRule,
} from './recost-engine';

/**
 * cc53 (D-649) — **el plan del recosteo por fecha**: solo lecturas. Recorre el kardex del ítem (y,
 * en cascada, el de lo que se fabricó o se partió con él), decide qué filas cambian de costo y
 * devuelve los ajustes. Los escribe `InventoryService.recostForward`, la única puerta (regla dura
 * 8); este archivo no escribe nada.
 */

export interface RecostItem {
  itemType: InventoryItemType;
  itemId: string;
}

/** Desde dónde se recalcula un ítem: después de un movimiento, o su historia completa. */
export interface RecostSeed extends RecostItem {
  /** Se recalculan las filas posteriores a este movimiento (en orden de fecha y registro). */
  afterMovementId?: bigint;
  /** Se recalcula desde la primera fila (corrección histórica, `recosteo:historico`). */
  fromStart?: boolean;
}

/** Una fila del kardex con lo que el recosteo necesita para escribir su ajuste. */
export interface MovementMeta {
  id: bigint;
  businessLineId: string;
  itemType: InventoryItemType;
  itemId: string;
  type: InventoryMovementType;
  qty: Decimal;
  unit: string;
  recorded: Decimal;
  effective: Decimal;
  refType: InventoryRefType;
  refId: string | null;
  reversalOfId: bigint | null;
  operationDate: Date;
}

export interface PlannedAdjust {
  movement: MovementMeta;
  /** Costo de fila que pasa a tener. */
  target: Decimal;
  /** Diferencia en costo de fila. */
  delta: Decimal;
}

export interface RecostPlan {
  /** Ítems alcanzados, con sus ajustes (puede haber ítems sin ninguno). */
  items: { item: RecostItem; adjusts: PlannedAdjust[] }[];
  /** Filas reproducidas en total. */
  rowsReplayed: number;
  /** Se pasó del tope de D-649: no se ajusta nada en línea. */
  overLimit: boolean;
}

const ZERO = new Decimal(0);
/** Refs cuyo `OUT` alimenta entradas de otro ítem (D-597, D-608, producción y su cierre). */
const CASCADE_REF_TYPES: readonly InventoryRefType[] = ['PRODUCTION', 'SPLIT', 'CUTTING', 'SCRAP'];

const itemKey = (i: RecostItem) => `${i.itemType}:${i.itemId}`;

const movementSelect = {
  id: true,
  businessLineId: true,
  itemType: true,
  itemId: true,
  type: true,
  qty: true,
  unit: true,
  totalCost: true,
  refType: true,
  refId: true,
  reversalOfId: true,
  recostOfId: true,
  operationDate: true,
} satisfies Prisma.InventoryMovementSelect;

type RawMovement = Prisma.InventoryMovementGetPayload<{ select: typeof movementSelect }>;

/**
 * Las filas «de verdad» (sin los recosteos), cada una con su costo efectivo: el grabado más lo que
 * sus recosteos le sumaron.
 */
function foldRecosts(raw: readonly RawMovement[]): MovementMeta[] {
  const extra = new Map<bigint, Decimal>();
  const byId = new Map(raw.map((m) => [m.id, m]));
  for (const m of raw) {
    if (m.recostOfId === null) continue;
    const target = byId.get(m.recostOfId);
    if (!target) continue;
    const add = rowCostOfRecost(target.type, toDecimal(m.totalCost.toString()));
    extra.set(m.recostOfId, (extra.get(m.recostOfId) ?? ZERO).plus(add));
  }
  return raw
    .filter((m) => m.recostOfId === null)
    .map((m) => {
      const recorded = toDecimal(m.totalCost.toString());
      return {
        id: m.id,
        businessLineId: m.businessLineId,
        itemType: m.itemType,
        itemId: m.itemId,
        type: m.type,
        qty: toDecimal(m.qty.toString()),
        unit: m.unit,
        recorded,
        effective: recorded.plus(extra.get(m.id) ?? ZERO),
        refType: m.refType,
        refId: m.refId,
        reversalOfId: m.reversalOfId,
        operationDate: m.operationDate,
      };
    });
}

/** La regla con que se valoriza cada fila (ver `RecostRule`). */
export function ruleOf(m: Pick<MovementMeta, 'type' | 'refType' | 'reversalOfId'>): RecostRule {
  if (m.reversalOfId !== null) return 'REVERSAL';
  if (m.type === 'IN' && m.refType === 'SALES_RETURN') return 'RETURN';
  if (m.type === 'OUT') return 'AVERAGE';
  // El sobrante y el conteo de más (D-164) entran al promedio vigente.
  if (m.type === 'IN' && m.refType === 'CLOSE_ADJUSTMENT') return 'AVERAGE';
  return 'FIXED';
}

interface LoadedItem {
  item: RecostItem;
  metas: MovementMeta[];
  rows: RecostRow[];
  index: Map<string, number>;
}

async function loadItem(tx: Prisma.TransactionClient, item: RecostItem): Promise<LoadedItem> {
  const raw = await tx.inventoryMovement.findMany({
    where: { itemType: item.itemType, itemId: item.itemId },
    orderBy: [{ operationDate: 'asc' }, { at: 'asc' }, { id: 'asc' }],
    select: movementSelect,
  });
  const metas = foldRecosts(raw);
  const returnIds = metas.filter((m) => ruleOf(m) === 'RETURN').map((m) => m.id);
  const returnSource = new Map<bigint, bigint>();
  if (returnIds.length > 0) {
    const links = await tx.salesReturnItem.findMany({
      where: { movementId: { in: returnIds } },
      select: { movementId: true, dispatchItem: { select: { movementId: true } } },
    });
    for (const l of links) {
      if (l.dispatchItem.movementId !== null)
        returnSource.set(l.movementId, l.dispatchItem.movementId);
    }
  }
  const rows = metas.map((m): RecostRow => ({
    id: m.id.toString(),
    type: m.type,
    qty: m.qty,
    recorded: m.recorded,
    effective: m.effective,
    rule: ruleOf(m),
    sourceId:
      m.reversalOfId !== null
        ? m.reversalOfId.toString()
        : (returnSource.get(m.id)?.toString() ?? null),
  }));
  return { item, metas, rows, index: new Map(rows.map((r, i) => [r.id, i])) };
}

/** Las filas de otro ítem que una devolución necesita (con su costo efectivo). */
async function loadExternal(
  tx: Prisma.TransactionClient,
  ids: bigint[],
): Promise<Map<string, ExternalCost>> {
  const out = new Map<string, ExternalCost>();
  if (ids.length === 0) return out;
  const raw = await tx.inventoryMovement.findMany({
    where: { OR: [{ id: { in: ids } }, { recostOfId: { in: ids } }] },
    select: movementSelect,
  });
  for (const m of foldRecosts(raw)) {
    out.set(m.id.toString(), {
      type: m.type,
      qty: m.qty,
      effective: m.effective,
      corrected: m.effective,
    });
  }
  return out;
}

/**
 * Arma el plan. `seeds` dice desde dónde se recalcula cada ítem; la cascada agrega los ítems que
 * derivan de una salida que cambió (el producto de una producción, las hijas de un partido, los
 * flejes de un corte, el ajuste de cierre de la OP). Cada ítem se vuelve a reproducir si su origen
 * cambia después; termina porque el kardex no tiene ciclos (lo fabricado es posterior a lo
 * consumido). Si el total de filas reproducidas pasa de `maxRows`, corta con `overLimit`.
 */
export async function planRecost(
  tx: Prisma.TransactionClient,
  seeds: readonly RecostSeed[],
  maxRows: number = RECOST_MAX_ROWS,
): Promise<RecostPlan> {
  const loaded = new Map<string, LoadedItem>();
  const start = new Map<string, number>();
  const overrides = new Map<string, Decimal>();
  const results = new Map<string, ReturnType<typeof replayItem>>();
  const queue: string[] = [];
  let rowsReplayed = 0;

  const ensure = async (item: RecostItem): Promise<LoadedItem> => {
    const key = itemKey(item);
    let l = loaded.get(key);
    if (!l) {
      l = await loadItem(tx, item);
      loaded.set(key, l);
    }
    return l;
  };
  const enqueue = (key: string, from: number) => {
    const prev = start.get(key);
    if (prev === undefined || from < prev) start.set(key, from);
    if (!queue.includes(key)) queue.push(key);
  };

  for (const seed of seeds) {
    const l = await ensure(seed);
    let from = 0;
    if (!seed.fromStart && seed.afterMovementId !== undefined) {
      const at = l.index.get(seed.afterMovementId.toString());
      from = at === undefined ? l.rows.length : at + 1;
    }
    enqueue(itemKey(seed), from);
  }

  /** El costo vigente de una fila de cualquier ítem cargado: el corregido si ya se reprodujo. */
  const bestCost = (key: string, id: string, fallback: Decimal): Decimal =>
    results.get(key)?.corrected.get(id) ?? fallback;

  let guard = 0;
  while (queue.length > 0) {
    guard += 1;
    if (guard > 10_000) throw new Error('Recosteo: la cascada no converge');
    const key = queue.shift();
    const l = key === undefined ? undefined : loaded.get(key);
    if (key === undefined || l === undefined) continue;
    const from = start.get(key) ?? 0;
    const needed = l.rows
      .slice(from)
      .flatMap((r) =>
        (r.rule === 'REVERSAL' || r.rule === 'RETURN') && r.sourceId && !l.index.has(r.sourceId)
          ? [BigInt(r.sourceId)]
          : [],
      );
    const external = await loadExternal(tx, needed);
    // Una devolución cuya salida es de otro ítem ya recalculado toma ese costo.
    for (const [id, cost] of external) {
      for (const [otherKey, other] of loaded) {
        const i = other.index.get(id);
        if (i !== undefined)
          external.set(id, { ...cost, corrected: bestCost(otherKey, id, cost.corrected) });
      }
    }
    rowsReplayed += l.rows.length - from;
    if (rowsReplayed > maxRows) {
      return { items: [], rowsReplayed, overLimit: true };
    }
    const result = replayItem(l.rows, { start: from, overrides, external });
    results.set(key, result);

    // Cascada: las salidas que alimentan otro ítem y cambiaron de costo.
    const changedRefs = new Map<string, { refType: InventoryRefType; refId: string }>();
    for (const m of l.metas.slice(from)) {
      if (m.type !== 'OUT' || m.reversalOfId !== null || m.refId === null) continue;
      if (!CASCADE_REF_TYPES.includes(m.refType)) continue;
      const corrected = result.corrected.get(m.id.toString()) ?? m.effective;
      if (corrected.eq(m.effective)) continue;
      changedRefs.set(`${m.refType}:${m.refId}`, { refType: m.refType, refId: m.refId });
    }
    if (changedRefs.size === 0) continue;
    const refs = [...changedRefs.values()];
    const raw = await tx.inventoryMovement.findMany({
      where: {
        OR: refs.flatMap((r): Prisma.InventoryMovementWhereInput[] =>
          r.refType === 'SCRAP'
            ? [
                { refType: r.refType, refId: r.refId },
                { refType: 'PRODUCTION' as const, refId: r.refId, type: 'ADJUST' as const },
              ]
            : [{ refType: r.refType, refId: r.refId }],
        ),
      },
      select: movementSelect,
    });
    const group = foldRecosts(raw);
    for (const ref of refs) {
      const sources = group.filter(
        (m) =>
          m.refType === ref.refType &&
          m.refId === ref.refId &&
          m.type === 'OUT' &&
          m.reversalOfId === null,
      );
      // La merma de una OP (`SCRAP`, ref = OP) entra al producto por el ajuste de cierre; el resto,
      // por las entradas con el mismo ref (producto del reporte, hijas, flejes).
      const isTarget = (m: MovementMeta): boolean => {
        if (m.refId !== ref.refId || m.reversalOfId !== null) return false;
        return ref.refType === 'SCRAP'
          ? m.refType === 'PRODUCTION' && m.type === 'ADJUST'
          : m.refType === ref.refType && m.type === 'IN';
      };
      const targets = group.filter(isTarget);
      if (targets.length === 0) continue;
      // Lo que cambió el material, contra lo que valía al grabar (las entradas derivadas se
      // grabaron con el costo grabado de sus salidas).
      const sourceDelta = sources.reduce((s, m) => {
        const k = itemKey(m);
        return s.plus(bestCost(k, m.id.toString(), m.effective).minus(m.recorded));
      }, ZERO);
      const parts = prorateDelta(
        sourceDelta,
        targets.map((t) => ({ id: t.id.toString(), recorded: t.recorded, qty: t.qty })),
      );
      for (const t of targets) {
        const value = t.recorded.plus(parts.get(t.id.toString()) ?? ZERO);
        const id = t.id.toString();
        const current = overrides.get(id) ?? t.effective;
        if (value.eq(current) && overrides.has(id)) continue;
        if (value.eq(t.effective) && !overrides.has(id)) continue;
        overrides.set(id, value);
        const target = await ensure(t);
        const at = target.index.get(id);
        if (at !== undefined) enqueue(itemKey(t), at);
      }
    }
  }

  const items: RecostPlan['items'] = [];
  for (const [key, l] of loaded) {
    const result = results.get(key);
    const byId = new Map(l.metas.map((m) => [m.id.toString(), m]));
    items.push({
      item: l.item,
      adjusts: (result?.deltas ?? []).flatMap((d) => {
        const movement = byId.get(d.id);
        return movement ? [{ movement, target: d.target, delta: d.delta }] : [];
      }),
    });
  }
  return { items, rowsReplayed, overLimit: false };
}

/**
 * El saldo de un ítem con todo lo registrado hasta una fecha (inclusive), con la misma cuenta que
 * el motor (costos efectivos; el valor se descarta al pasar por cero). Lo que una salida nueva,
 * fechada ahí, toma como promedio (D-649).
 */
export async function stockUpToDate(
  tx: Prisma.TransactionClient,
  item: RecostItem,
  date: Date,
): Promise<{ qty: Decimal; value: Decimal }> {
  const l = await loadItem(tx, item);
  const end = l.metas.findIndex((m) => m.operationDate > date);
  return stockBefore(l.rows, end === -1 ? l.rows.length : end);
}

/** Cuántas filas tiene un ítem después de una fecha: lo que avisa el diálogo de retrofecha. */
export function laterMovementsNote(count: number): string {
  return count === 0
    ? ''
    : ` Al registrarlo, el sistema recostea por fecha hasta ${String(count)} movimiento(s) posteriores (D-649).`;
}
