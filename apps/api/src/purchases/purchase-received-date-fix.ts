import type { Prisma, InventoryMovement, Purchase } from '@prisma/client';
import { Decimal } from '@ayr/shared';
import type { InventoryService } from '../inventory/inventory.service';
import type { AuditService } from '../audit/audit.service';
import { lockRawMaterialCoils } from '../sales/raw-material';

const day = (date: Date): string => date.toISOString().slice(0, 10);
const limaDay = (date: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
const midnightLima = (date: string): Date => new Date(`${date}T05:00:00.000Z`);
const key = (m: Pick<InventoryMovement, 'itemType' | 'itemId'>): string =>
  `${m.itemType}:${m.itemId}`;

/** Mismo orden de locks que InventoryService: bobinas compatibles y luego saldos. */
async function lockPlanItems(
  tx: Prisma.TransactionClient,
  itemKeys: readonly string[],
  toleranceMm: string,
): Promise<void> {
  const keys = [...new Set(itemKeys)].sort();
  const coilIds = keys.filter((k) => k.startsWith('COIL:')).map((k) => k.slice(5));
  await lockRawMaterialCoils(tx, coilIds, toleranceMm);
  for (const itemKey of keys) {
    const [itemType, itemId] = itemKey.split(':') as [InventoryMovement['itemType'], string];
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "inventory_balances"
      WHERE "item_type" = ${itemType}::"InventoryItemType" AND "item_id" = ${itemId}::uuid
      FOR UPDATE
    `;
    if (rows.length !== 1) throw new Error(`No existe saldo bloqueable para ${itemKey}`);
  }
}

export interface ReceivedDateCase {
  purchaseId: string;
  document: string;
  type: string;
  currentDate: string;
  destinationDate: string;
  currentReceivedAt: string;
  movementIds: string[];
  items: { key: string; qty: string; currentDate: string }[];
  safe: boolean;
  reasons: string[];
}

/** Un lote explícito nunca amplía su alcance cuando aparezcan compras nuevas. */
export function selectSafeCases(
  cases: readonly ReceivedDateCase[],
  selectedIds?: readonly string[],
): ReceivedDateCase[] {
  if (selectedIds === undefined) return cases.filter((c) => c.safe);
  const selected = new Set(selectedIds);
  if (selected.size !== selectedIds.length) throw new Error('Hay compras repetidas en --only');
  for (const id of selected) {
    const found = cases.find((c) => c.purchaseId === id);
    if (!found) throw new Error(`La compra ${id} no pertenece al conjunto candidato`);
    if (!found.safe) throw new Error(`La compra ${id} está excluida: ${found.reasons.join('; ')}`);
  }
  return cases.filter((c) => selected.has(c.purchaseId));
}

export interface MovementForClassification {
  id: bigint;
  itemType: InventoryMovement['itemType'];
  itemId: string;
  type: InventoryMovement['type'];
  refType: InventoryMovement['refType'];
  refId: string | null;
  qty: Prisma.Decimal;
  operationDate: Date;
  reversalOfId: bigint | null;
}

/** Una salida posterior podría cambiar de costo; IMPORT posterior podría duplicar la apertura. */
export function classifyReceivedDate(
  purchase: Pick<Purchase, 'id' | 'type' | 'issueDate' | 'receivedAt' | 'series' | 'number'>,
  own: readonly MovementForClassification[],
  history: readonly MovementForClassification[],
): ReceivedDateCase | null {
  if (!purchase.receivedAt) return null;
  const currentDate = limaDay(purchase.receivedAt);
  const destinationDate = day(purchase.issueDate);
  if (destinationDate >= currentDate || !own.some((m) => day(m.operationDate) === currentDate))
    return null;
  const reasons: string[] = [];
  const active = own.filter((m) => m.reversalOfId === null);
  if (
    active.length === 0 ||
    active.some((m) => m.type !== 'IN' || day(m.operationDate) !== currentDate)
  )
    reasons.push('Movimientos de compra mixtos o fecha ya corregida');
  if (
    own.some((m) => m.reversalOfId !== null) ||
    history.some((m) => m.reversalOfId !== null && active.some((a) => a.id === m.reversalOfId))
  )
    reasons.push('La compra ya tiene reversas');
  const itemKeys = new Set(active.map(key));
  const related = history.filter((m) => itemKeys.has(key(m)) && !active.some((a) => a.id === m.id));
  if (
    related.some(
      (m) =>
        m.refType === 'IMPORT' &&
        day(m.operationDate) >= destinationDate &&
        day(m.operationDate) <= currentDate,
    )
  )
    reasons.push('Apertura posterior a la fecha destino: posible stock duplicado');
  if (
    related.some(
      (m) => m.type === 'OUT' && m.reversalOfId === null && day(m.operationDate) >= destinationDate,
    )
  )
    reasons.push('Salida posterior: mover la entrada puede recostearla');
  if (related.some((m) => m.type === 'ADJUST' && day(m.operationDate) >= destinationDate))
    reasons.push('Ajuste de costo posterior');
  // Proyecta el saldo evento por evento. Una entrada adelantada y su reversa en el día viejo
  // nunca deben crear un negativo de paso; se comprueba también si el histórico ya es anómalo.
  for (const itemKey of itemKeys) {
    const events = history
      .filter((m) => key(m) === itemKey)
      .map((m) => ({
        date: day(m.operationDate),
        rank: 0,
        id: m.id,
        delta:
          m.type === 'IN'
            ? new Decimal(m.qty.toString())
            : m.type === 'OUT'
              ? new Decimal(m.qty.toString()).negated()
              : new Decimal(0),
      }));
    const ownForItem = active.filter((m) => key(m) === itemKey);
    for (const m of ownForItem) {
      events.push({
        date: destinationDate,
        rank: 1,
        id: m.id,
        delta: new Decimal(m.qty.toString()),
      });
      events.push({
        date: currentDate,
        rank: 1,
        id: m.id,
        delta: new Decimal(m.qty.toString()).negated(),
      });
    }
    events.sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    let qty = new Decimal(0);
    if (
      events.some((e) => {
        qty = qty.plus(e.delta);
        return qty.isNegative();
      })
    ) {
      reasons.push(`Saldo intermedio negativo en ${itemKey}`);
    }
  }
  return {
    purchaseId: purchase.id,
    document: `${purchase.series}-${purchase.number}`,
    type: purchase.type,
    currentDate,
    destinationDate,
    currentReceivedAt: purchase.receivedAt.toISOString(),
    movementIds: active.map((m) => m.id.toString()),
    items: active.map((m) => ({
      key: key(m),
      qty: m.qty.toString(),
      currentDate: day(m.operationDate),
    })),
    safe: reasons.length === 0,
    reasons,
  };
}

export async function planPurchaseReceivedDates(
  tx: Prisma.TransactionClient,
): Promise<ReceivedDateCase[]> {
  const purchases = await tx.purchase.findMany({
    where: { status: 'RECEIVED', receivedAt: { not: null } },
    select: { id: true, type: true, issueDate: true, receivedAt: true, series: true, number: true },
    orderBy: [{ issueDate: 'asc' }, { id: 'asc' }],
  });
  const ids = purchases.map((p) => p.id);
  const own = await tx.inventoryMovement.findMany({
    where: { refType: 'PURCHASE', refId: { in: ids } },
    orderBy: [{ operationDate: 'asc' }, { id: 'asc' }],
  });
  const itemIds = [...new Set(own.map((m) => m.itemId))];
  const history = await tx.inventoryMovement.findMany({
    where: { itemId: { in: itemIds } },
    orderBy: [{ operationDate: 'asc' }, { id: 'asc' }],
  });
  return purchases.flatMap((p) => {
    const found = classifyReceivedDate(
      p,
      own.filter((m) => m.refId === p.id),
      history,
    );
    return found ? [found] : [];
  });
}

interface FixAuditAfter {
  batchId: string;
  purchaseId: string;
  movementIds: string[];
  oldMovementIds: string[];
  destinationDate: string;
  currentDate: string;
  oldReceivedAt: string;
}

export async function executePurchaseReceivedDates(
  tx: Prisma.TransactionClient,
  inventory: InventoryService,
  audit: AuditService,
  actorId: string,
  batchId: string,
  expected: readonly ReceivedDateCase[],
  toleranceMm: string,
  selectedIds?: readonly string[],
): Promise<ReceivedDateCase[]> {
  const expectedSelected = selectSafeCases(expected, selectedIds);
  await lockPlanItems(
    tx,
    expectedSelected.flatMap((c) => c.items.map((i) => i.key)),
    toleranceMm,
  );
  const live = await planPurchaseReceivedDates(tx);
  const signature = (rows: readonly ReceivedDateCase[]) => JSON.stringify(rows);
  if (signature(live) !== signature(expected))
    throw new Error('El plan cambió desde el dry-run; repetí la clasificación');
  const safe = selectSafeCases(live, selectedIds);
  for (const c of safe) {
    const original = await tx.inventoryMovement.findMany({
      where: { id: { in: c.movementIds.map(BigInt) } },
      orderBy: { id: 'asc' },
    });
    const replacementIds: string[] = [];
    for (const m of original) {
      // Primero entra el reemplazo: una reversa transitoria podría dejar el saldo por
      // debajo de lo reservado, aunque el estado final conserve exactamente la cantidad.
      const created = await inventory.record(tx, {
        businessLineId: m.businessLineId,
        itemType: m.itemType,
        itemId: m.itemId,
        type: 'IN',
        qty: m.qty.toString(),
        unit: m.unit,
        unitCost: m.unitCost.toString(),
        totalCost: m.totalCost.toString(),
        refType: 'PURCHASE',
        refId: c.purchaseId,
        actorId,
        operationDate: c.destinationDate,
        confirmBackdate: true,
        notes: `Fecha recibida corregida; lote ${batchId}`,
      });
      if (!created) throw new Error('La línea no genera kardex');
      await inventory.reverse(
        tx,
        m.id,
        actorId,
        `Corrección de fecha recibida ${batchId}`,
        c.currentDate,
        true,
      );
      replacementIds.push(created.id.toString());
      if (m.itemType === 'COIL')
        await tx.coil.update({
          where: { id: m.itemId },
          data: { operationDate: midnightLima(c.destinationDate) },
        });
    }
    await tx.purchase.update({
      where: { id: c.purchaseId },
      data: { receivedAt: midnightLima(c.destinationDate) },
    });
    const after: FixAuditAfter = {
      batchId,
      purchaseId: c.purchaseId,
      movementIds: replacementIds,
      oldMovementIds: c.movementIds,
      destinationDate: c.destinationDate,
      currentDate: c.currentDate,
      oldReceivedAt: c.currentReceivedAt,
    };
    await audit.write(tx, {
      actorId,
      action: 'purchases.received-date-fix',
      entity: 'purchases',
      entityId: c.purchaseId,
      before: { receivedAt: c.currentReceivedAt, movementIds: c.movementIds },
      after: { ...after },
    });
  }
  return safe;
}

export function parseFixAudit(after: unknown): FixAuditAfter {
  if (typeof after !== 'object' || after === null) throw new Error('Auditoría de lote inválida');
  const a = after as Partial<FixAuditAfter>;
  if (
    !a.batchId ||
    !a.purchaseId ||
    !a.destinationDate ||
    !a.currentDate ||
    !a.oldReceivedAt ||
    !Array.isArray(a.movementIds) ||
    !Array.isArray(a.oldMovementIds)
  )
    throw new Error('Auditoría de lote incompleta');
  return a as FixAuditAfter;
}

export async function undoPurchaseReceivedDates(
  tx: Prisma.TransactionClient,
  inventory: InventoryService,
  audit: AuditService,
  actorId: string,
  batchId: string,
  toleranceMm: string,
): Promise<string[]> {
  const logs = await tx.auditLog.findMany({
    where: { action: 'purchases.received-date-fix', after: { path: ['batchId'], equals: batchId } },
    orderBy: { id: 'desc' },
  });
  if (logs.length === 0) throw new Error('Lote inexistente');
  const undone = await tx.auditLog.count({
    where: {
      action: 'purchases.received-date-fix.undo',
      after: { path: ['batchId'], equals: batchId },
    },
  });
  if (undone > 0) throw new Error('Lote ya revertido');
  // Si alguien movió uno de estos ítems tras el lote, deshacer la entrada retrofechada
  // puede recostear esa salida o dejar negativo un día anterior. Preflight de TODO el
  // lote antes de la primera reversa: el undo nunca opera a medias.
  const lastBatchMovementByItem = new Map<string, bigint>();
  const oldMovementIds: bigint[] = [];
  for (const log of logs) {
    const a = parseFixAudit(log.after);
    oldMovementIds.push(...a.oldMovementIds.map(BigInt));
    for (const id of a.movementIds) {
      const movement = await tx.inventoryMovement.findUniqueOrThrow({ where: { id: BigInt(id) } });
      const itemKey = key(movement);
      const previous = lastBatchMovementByItem.get(itemKey) ?? 0n;
      if (movement.id > previous) lastBatchMovementByItem.set(itemKey, movement.id);
    }
  }
  // La ejecución ingresa primero y reversa después. Esas reversas también tienen IDs
  // posteriores a las nuevas entradas: son parte del lote, no actividad de terceros.
  const ownReversals = await tx.inventoryMovement.findMany({
    where: {
      reversalOfId: { in: oldMovementIds },
      type: 'OUT',
      refType: 'PURCHASE',
      notes: `Corrección de fecha recibida ${batchId}`,
    },
    select: { id: true, reversalOfId: true },
  });
  if (ownReversals.length !== oldMovementIds.length ||
      new Set(ownReversals.map((m) => m.reversalOfId?.toString())).size !== oldMovementIds.length)
    throw new Error('Reversas del lote incompletas; no se puede deshacer');
  const ownReversalIds = ownReversals.map((m) => m.id);
  await lockPlanItems(tx, [...lastBatchMovementByItem.keys()], toleranceMm);
  for (const [itemKey, lastId] of lastBatchMovementByItem) {
    const [itemType, itemId] = itemKey.split(':') as [InventoryMovement['itemType'], string];
    const newer = await tx.inventoryMovement.findFirst({
      where: { itemType, itemId, id: { gt: lastId }, NOT: { id: { in: ownReversalIds } } },
      select: { id: true },
    });
    if (newer) throw new Error(`Undo bloqueado: ${itemKey} tiene movimientos posteriores al lote`);
  }
  const ids: string[] = [];
  for (const log of logs) {
    const a = parseFixAudit(log.after);
    const purchase = await tx.purchase.findUniqueOrThrow({ where: { id: a.purchaseId } });
    if (purchase.receivedAt?.toISOString() !== midnightLima(a.destinationDate).toISOString())
      throw new Error(`La compra ${a.purchaseId} cambió; no se puede deshacer`);
    for (const id of [...a.movementIds].reverse()) {
      const m = await tx.inventoryMovement.findUniqueOrThrow({ where: { id: BigInt(id) } });
      // El undo conserva la misma invariante de reservas: reingresa primero el saldo viejo.
      await inventory.record(tx, {
        businessLineId: m.businessLineId,
        itemType: m.itemType,
        itemId: m.itemId,
        type: 'IN',
        qty: m.qty.toString(),
        unit: m.unit,
        unitCost: m.unitCost.toString(),
        totalCost: m.totalCost.toString(),
        refType: 'PURCHASE',
        refId: a.purchaseId,
        actorId,
        operationDate: a.currentDate,
        confirmBackdate: true,
        notes: `Undo fecha recibida; lote ${batchId}`,
      });
      await inventory.reverse(
        tx,
        m.id,
        actorId,
        `Undo fecha recibida ${batchId}`,
        a.destinationDate,
        true,
      );
      if (m.itemType === 'COIL')
        await tx.coil.update({
          where: { id: m.itemId },
          data: { operationDate: midnightLima(a.currentDate) },
        });
    }
    await tx.purchase.update({
      where: { id: a.purchaseId },
      data: { receivedAt: new Date(a.oldReceivedAt) },
    });
    ids.push(a.purchaseId);
    await audit.write(tx, {
      actorId,
      action: 'purchases.received-date-fix.undo',
      entity: 'purchases',
      entityId: a.purchaseId,
      before: { receivedAt: midnightLima(a.destinationDate).toISOString() },
      after: { batchId, receivedAt: a.oldReceivedAt },
    });
  }
  return ids;
}
