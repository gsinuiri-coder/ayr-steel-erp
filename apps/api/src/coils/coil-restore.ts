import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  CoilStatus,
  InventoryItemType,
  InventoryRefType,
  ReservationStatus,
  type InventoryMovement,
  type Prisma,
} from '@prisma/client';
import {
  businessToday,
  Decimal,
  toDecimal,
  toFixedString,
  type CoilRestorePlanDto,
} from '@ayr/shared';
import type { AuditService } from '../audit/audit.service';
import type { InventoryService } from '../inventory/inventory.service';

/**
 * D-375 — restaurar una bobina anulada que vino de una compra.
 *
 * La anulación (de la bobina o de su compra) solo revirtió el ingreso `PURCHASE` y puso la
 * bobina en `CANCELLED`; el film no se toca. Restaurar es **la misma bobina** (mismo id y
 * código) con un ingreso nuevo, append-only, que repite el revertido: misma cantidad, mismo
 * costo en soles y referencia a la misma compra. La compra se lee y no se modifica, aunque esté
 * anulada (decisión del dueño).
 *
 * El modo lo decide este clasificador, no el usuario:
 * - `EN_SU_FECHA`: el ingreso vuelve a la fecha del revertido. Solo si ninguna salida
 *   existente desde esa fecha queda con otro costo, y si la fecha no es anterior al piso de
 *   la carga histórica.
 * - `A_HOY`: el ingreso va con fecha de hoy. La producción con la bobina no puede tener fecha
 *   anterior (guard de `InventoryService.record`).
 * - `BLOQUEADA`: con el motivo. Una salida propia **viva** bloquea; una revertida no
 *   (decisión del dueño): su neto es cero.
 */

export type CoilRestoreMode = CoilRestorePlanDto['mode'];

export type RestoreMovement = Pick<
  InventoryMovement,
  | 'id'
  | 'type'
  | 'refType'
  | 'refId'
  | 'qty'
  | 'unit'
  | 'unitCost'
  | 'operationDate'
  | 'reversalOfId'
>;

export interface RestoreContext {
  coil: { id: string; code: string; status: CoilStatus; purchaseId: string | null };
  movements: readonly RestoreMovement[];
  activeReservations: number;
  liveChildren: number;
  /** `YYYY-MM-DD`. */
  today: string;
  /** `YYYY-MM-DD`, piso de la carga histórica. */
  historicalFloor: string;
}

export interface CoilRestoreClassification {
  mode: CoilRestoreMode;
  date: string | null;
  reasons: string[];
  /** El ingreso `PURCHASE` revertido que se repite. */
  entry: RestoreMovement | null;
}

const day = (d: Date): string => d.toISOString().slice(0, 10);

/** Ids de los movimientos que tienen una reversa. */
function reversedIds(movements: readonly RestoreMovement[]): Set<bigint> {
  return new Set(movements.flatMap((m) => (m.reversalOfId === null ? [] : [m.reversalOfId])));
}

export function classifyCoilRestore(ctx: RestoreContext): CoilRestoreClassification {
  const blocked = (reason: string, entry: RestoreMovement | null = null) => ({
    mode: 'BLOQUEADA' as const,
    date: null,
    reasons: [reason],
    entry,
  });
  if (ctx.coil.status !== CoilStatus.CANCELLED) {
    return blocked(
      ctx.coil.status === CoilStatus.OPEN || ctx.coil.status === CoilStatus.CLOSED
        ? 'La bobina no está anulada (¿ya se restauró?)'
        : `La bobina no está anulada: está ${ctx.coil.status}`,
    );
  }
  if (ctx.coil.purchaseId === null) return blocked('La bobina no vino de una compra');

  const reversed = reversedIds(ctx.movements);
  // Salidas propias: todo OUT que no sea la reversa de un ingreso. Vivas bloquean, y es lo
  // primero que se informa: es la razón que el usuario puede ir a resolver.
  const ownOuts = ctx.movements.filter((m) => m.type === 'OUT' && m.reversalOfId === null);
  const liveOwnOuts = ownOuts.filter((m) => !reversed.has(m.id));
  if (liveOwnOuts.length > 0) {
    const kinds = [...new Set(liveOwnOuts.map((m) => m.refType))].join(', ');
    return blocked(
      `La bobina tiene ${String(liveOwnOuts.length)} salida(s) propia(s) vivas (${kinds})`,
    );
  }

  const purchaseIns = ctx.movements.filter(
    (m) =>
      m.type === 'IN' &&
      m.reversalOfId === null &&
      m.refType === InventoryRefType.PURCHASE &&
      m.refId === ctx.coil.purchaseId,
  );
  // El último ingreso de compra revertido es el que la anulación deshizo; los anteriores, si
  // los hay, son correcciones de costo que ya se habían reemplazado.
  const entry = [...purchaseIns]
    .filter((m) => reversed.has(m.id))
    .sort((a, b) => (a.id < b.id ? 1 : -1))[0];
  if (!entry) return blocked('No se encontró el ingreso de compra revertido por la anulación');

  const liveIns = ctx.movements.filter(
    (m) => m.type === 'IN' && m.reversalOfId === null && !reversed.has(m.id),
  );
  if (liveIns.length > 0) return blocked('La bobina ya tiene un ingreso vivo en el kardex', entry);
  if (ctx.activeReservations > 0) return blocked('La bobina tiene reservas activas', entry);
  if (ctx.liveChildren > 0) return blocked('La bobina tiene flejes hijos vigentes', entry);

  const balance = ctx.movements.reduce(
    (acc, m) =>
      m.type === 'IN'
        ? acc.plus(toDecimal(m.qty.toString()))
        : m.type === 'OUT'
          ? acc.minus(toDecimal(m.qty.toString()))
          : acc,
    new Decimal(0),
  );
  if (!balance.isZero()) {
    return blocked(`El saldo de la bobina no es cero (${balance.toFixed(3)} kg)`, entry);
  }

  const entryDate = day(entry.operationDate);
  const entryCost = toDecimal(entry.unitCost.toString());
  const reasons: string[] = [];
  // Recosteo: una salida existente (viva o revertida) desde la fecha del ingreso con otro
  // costo quedaría valorizada distinto al reinsertar la entrada antes que ella.
  const recost = ownOuts.filter(
    (m) => day(m.operationDate) >= entryDate && !toDecimal(m.unitCost.toString()).equals(entryCost),
  );
  if (recost.length > 0) {
    reasons.push(
      `${String(recost.length)} salida(s) desde el ${entryDate} tienen otro costo: reinsertar la entrada en su fecha las recostearía`,
    );
  }
  if (entryDate < ctx.historicalFloor) {
    reasons.push(
      `La fecha ${entryDate} es anterior al piso de la carga histórica (${ctx.historicalFloor})`,
    );
  }
  if (reasons.length > 0) return { mode: 'A_HOY', date: ctx.today, reasons, entry };
  return { mode: 'EN_SU_FECHA', date: entryDate, reasons: [], entry };
}

/** Lee lo que el clasificador necesita. Con `lock`, bloquea la fila de la bobina antes. */
export async function loadRestoreContext(
  tx: Prisma.TransactionClient,
  coilId: string,
  historicalFloor: string,
  lock: boolean,
): Promise<{
  ctx: RestoreContext;
  coil: {
    id: string;
    code: string;
    status: CoilStatus;
    purchaseId: string | null;
    businessLineId: string;
    operationDate: Date;
    purchase: { series: string; number: string; status: string } | null;
  };
}> {
  if (lock) {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "coils" WHERE "id" = ${coilId}::uuid FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundException('Bobina no encontrada');
  }
  const coil = await tx.coil.findUnique({
    where: { id: coilId },
    select: {
      id: true,
      code: true,
      status: true,
      purchaseId: true,
      businessLineId: true,
      operationDate: true,
      purchase: { select: { series: true, number: true, status: true } },
    },
  });
  if (!coil) throw new NotFoundException('Bobina no encontrada');
  const [movements, activeReservations, liveChildren] = await Promise.all([
    tx.inventoryMovement.findMany({
      where: { itemType: InventoryItemType.COIL, itemId: coilId },
      select: {
        id: true,
        type: true,
        refType: true,
        refId: true,
        qty: true,
        unit: true,
        unitCost: true,
        operationDate: true,
        reversalOfId: true,
      },
      orderBy: [{ operationDate: 'asc' }, { id: 'asc' }],
    }),
    tx.reservation.count({
      where: { itemType: InventoryItemType.COIL, itemId: coilId, status: ReservationStatus.ACTIVE },
    }),
    tx.coil.count({ where: { parentCoilId: coilId, status: { not: CoilStatus.CANCELLED } } }),
  ]);
  return {
    ctx: {
      coil: { id: coil.id, code: coil.code, status: coil.status, purchaseId: coil.purchaseId },
      movements,
      activeReservations,
      liveChildren,
      today: businessToday(),
      historicalFloor,
    },
    coil,
  };
}

export function toPlanDto(
  coil: {
    id: string;
    code: string;
    purchase: { series: string; number: string; status: string } | null;
  },
  result: CoilRestoreClassification,
): CoilRestorePlanDto {
  return {
    coilId: coil.id,
    code: coil.code,
    mode: result.mode,
    date: result.date,
    originalDate: result.entry ? day(result.entry.operationDate) : null,
    qty: result.entry ? toFixedString(toDecimal(result.entry.qty.toString()), 'KG') : null,
    unitCostPen: result.entry
      ? toFixedString(toDecimal(result.entry.unitCost.toString()), 'MONEY')
      : null,
    purchaseDocument: coil.purchase ? `${coil.purchase.series}-${coil.purchase.number}` : null,
    purchaseStatus: coil.purchase?.status ?? null,
    reasons: result.reasons,
  };
}

export const COIL_RESTORE_ACTION = 'coils.restore';
export const COIL_RESTORE_UNDO_ACTION = 'coils.restore.undo';

/**
 * Restaura una bobina dentro de la transacción del llamador. Reclasifica con la fila bloqueada:
 * lo que se mostró en el modal o en el dry-run puede haber cambiado.
 */
export async function restoreCoilInTx(
  tx: Prisma.TransactionClient,
  inventory: InventoryService,
  audit: AuditService,
  args: {
    actorId: string;
    coilId: string;
    reason: string;
    batchId: string;
    historicalFloor: string;
  },
): Promise<CoilRestorePlanDto & { movementId: string }> {
  const { ctx, coil } = await loadRestoreContext(tx, args.coilId, args.historicalFloor, true);
  const result = classifyCoilRestore(ctx);
  if (result.mode === 'BLOQUEADA' || !result.entry || !result.date) {
    const reason = result.reasons.join('; ');
    throw coil.status === CoilStatus.CANCELLED
      ? new BadRequestException(`No se puede restaurar ${coil.code}: ${reason}`)
      : new ConflictException(`No se puede restaurar ${coil.code}: ${reason}`);
  }
  const entry = result.entry;
  const movement = await inventory.record(tx, {
    businessLineId: coil.businessLineId,
    itemType: InventoryItemType.COIL,
    itemId: coil.id,
    type: 'IN',
    qty: entry.qty.toString(),
    unit: entry.unit,
    unitCost: entry.unitCost.toString(),
    refType: InventoryRefType.PURCHASE,
    refId: coil.purchaseId ?? undefined,
    notes: `Restauración de bobina anulada (D-375, lote ${args.batchId}): ${args.reason}`,
    actorId: args.actorId,
    operationDate: result.date,
    // Retrofecha consciente: la clasificación ya comprobó que no recostea ninguna salida.
    confirmBackdate: true,
  });
  if (!movement) throw new BadRequestException('La línea de la bobina no lleva inventario');

  const data: Prisma.CoilUpdateInput = { status: CoilStatus.OPEN };
  if (result.mode === 'A_HOY') data.operationDate = new Date(`${result.date}T00:00:00.000Z`);
  await tx.coil.update({ where: { id: coil.id }, data });

  const plan = toPlanDto(coil, result);
  await audit.write(tx, {
    actorId: args.actorId,
    action: COIL_RESTORE_ACTION,
    entity: 'coils',
    entityId: coil.id,
    reason: args.reason,
    before: {
      status: CoilStatus.CANCELLED,
      code: coil.code,
      operationDate: day(coil.operationDate),
      reversedEntryId: entry.id.toString(),
    },
    after: {
      status: CoilStatus.OPEN,
      mode: result.mode,
      date: result.date,
      originalDate: plan.originalDate,
      qty: plan.qty,
      unitCostPen: plan.unitCostPen,
      purchaseDocument: plan.purchaseDocument,
      movementId: movement.id.toString(),
      batchId: args.batchId,
      reason: args.reason,
    },
  });
  return { ...plan, movementId: movement.id.toString() };
}

interface RestoreAuditAfter {
  movementId: string;
  batchId: string;
  date: string;
}
interface RestoreAuditBefore {
  operationDate: string;
}

/**
 * Deshace un lote: revierte cada ingreso de restauración en su misma fecha y devuelve la bobina
 * a `CANCELLED` con su fecha de antes. Se niega, sin escribir nada, si alguna bobina del lote
 * tuvo un movimiento posterior a su restauración.
 */
export async function undoCoilRestoreBatch(
  tx: Prisma.TransactionClient,
  inventory: InventoryService,
  audit: AuditService,
  actorId: string,
  batchId: string,
  reason: string,
): Promise<string[]> {
  const logs = await tx.auditLog.findMany({
    where: { action: COIL_RESTORE_ACTION, after: { path: ['batchId'], equals: batchId } },
    select: { entityId: true, before: true, after: true },
  });
  if (logs.length === 0) throw new NotFoundException(`No hay restauraciones en el lote ${batchId}`);
  const undone = await tx.auditLog.count({
    where: { action: COIL_RESTORE_UNDO_ACTION, after: { path: ['batchId'], equals: batchId } },
  });
  if (undone > 0) throw new ConflictException(`El lote ${batchId} ya se deshizo`);

  const items = logs.map((l) => ({
    coilId: l.entityId ?? '',
    before: l.before as unknown as RestoreAuditBefore,
    after: l.after as unknown as RestoreAuditAfter,
  }));
  // Preflight de todo el lote antes de escribir.
  for (const item of items) {
    await tx.$queryRaw`SELECT "id" FROM "coils" WHERE "id" = ${item.coilId}::uuid FOR UPDATE`;
    const later = await tx.inventoryMovement.count({
      where: {
        itemType: InventoryItemType.COIL,
        itemId: item.coilId,
        id: { gt: BigInt(item.after.movementId) },
      },
    });
    if (later > 0) {
      throw new ConflictException(
        `La bobina ${item.coilId} tuvo movimientos después de restaurarse: el lote no se deshace`,
      );
    }
  }
  for (const item of items) {
    await inventory.reverse(
      tx,
      BigInt(item.after.movementId),
      actorId,
      `Deshacer restauración (D-375, lote ${batchId}): ${reason}`,
      item.after.date,
      true,
    );
    await tx.coil.update({
      where: { id: item.coilId },
      data: {
        status: CoilStatus.CANCELLED,
        operationDate: new Date(`${item.before.operationDate}T00:00:00.000Z`),
      },
    });
    await audit.write(tx, {
      actorId,
      action: COIL_RESTORE_UNDO_ACTION,
      entity: 'coils',
      entityId: item.coilId,
      reason,
      before: { status: CoilStatus.OPEN, movementId: item.after.movementId },
      after: { status: CoilStatus.CANCELLED, batchId },
    });
  }
  return items.map((i) => i.coilId);
}

/** Plan de todas las bobinas anuladas de compra, para el dry-run de la CLI. */
export async function planCoilRestores(
  tx: Prisma.TransactionClient,
  historicalFloor: string,
): Promise<CoilRestorePlanDto[]> {
  const coils = await tx.coil.findMany({
    where: { status: CoilStatus.CANCELLED, purchaseId: { not: null } },
    select: { id: true },
    orderBy: { code: 'asc' },
  });
  const plans: CoilRestorePlanDto[] = [];
  for (const { id } of coils) {
    const { ctx, coil } = await loadRestoreContext(tx, id, historicalFloor, false);
    plans.push(toPlanDto(coil, classifyCoilRestore(ctx)));
  }
  return plans;
}
