import { CoilStatus, ReservationStatus, type Prisma } from '@prisma/client';
import { Decimal, quotationCode, salesOrderCode, toDecimal } from '@ayr/shared';
import type { AuditService } from '../audit/audit.service';
import { findLiveStripAssignments } from '../production/production-assignments';
import { liveTemporaryWhere, reservedByItem } from '../sales/reserved-ledger';

/**
 * D-360 — **la bobina se termina sola cuando una salida la deja en exactamente 0.**
 *
 * Hasta acá solo lo hacían tres caminos, cada uno a su manera: la venta entera (D-170, con
 * auditoría), el partido (RF-15) y la recepción de corte (D-052), estos dos con un `update`
 * directo y sin auditoría de cierre. El resto —reporte, despunte, merma— dejaba el rollo
 * «Vigente» con 0 kg en la lista de bobinas y en los selectores de planta hasta que alguien lo
 * terminara a mano. Ahora todos pasan por acá.
 *
 * Reglas (decisión del dueño, C06):
 *
 * - **Sin kardex.** Con el saldo en 0 no hay remanente que liquidar (D-164): es un cambio de
 *   estado con su auditoría, nada más. Ninguna rama de este archivo llama a `record()`.
 * - **Exactamente 0.** Un saldo positivo, aunque sea 0,001 kg, sigue vigente: ese rollo lo
 *   termina una persona declarando lo que queda. Un saldo **negativo** no se termina: es una
 *   anomalía (el kardex no lo admite por `record()`), queda en la auditoría y la lista la CLI.
 * - **Montada en una OP viva → todavía no.** Se termina al liberarla o al cerrar o anular la
 *   OP, si sigue en 0. Por eso el reporte de producción y el despunte no terminan por sí
 *   mismos —la bobina está siempre montada cuando se reporta— y quien termina es el cierre.
 * - **Con reserva viva → anomalía, no se termina.** Las reservas son por SKU/kg salvo la venta
 *   de bobina entera (RF-73, D-116), que reserva el rollo concreto; ese rollo en 0 con su
 *   reserva viva quiere decir que el material salió por otro lado. Mismo criterio que D-170.
 * - **Solo se llama desde la operación que movió el saldo.** Nunca desde una lectura.
 *
 * La auditoría es `coils.close` —la misma acción que el cierre manual, como D-170— con
 * `autoTerminated: { kind, refId }`, **la marca que hace reversible la terminación**: la
 * reapertura automática solo toca las bobinas cuyo último cambio de estado es una terminación
 * de esa misma operación. Y `zeroedBy`, el movimiento de kardex que dejó el saldo en 0.
 */

export type AutoTerminateKind =
  /** Cierre de una OP (drywall o coberturas): lo montado se libera. */
  | 'PRODUCTION_ORDER_CLOSE'
  /** Anulación de una OP sin reportes: lo montado se libera. */
  | 'PRODUCTION_ORDER_CANCEL'
  /** Bajar/liberar una bobina de una OP. */
  | 'COIL_RELEASE'
  /** Merma de RF-17 (`refId` = el movimiento de la merma). */
  | 'SCRAP'
  /** Venta de bobina entera (D-170, `refId` = el despacho). */
  | 'DISPATCH'
  /** Relleno de una salida faltante de un despacho (D-285, `refId` = el despacho). */
  | 'DISPATCH_MISSING'
  /** Partido (RF-15, `refId` = el partido). */
  | 'SPLIT'
  /** Recepción de corte tercerizado (RF-41, `refId` = la fila de la bobina en el envío). */
  | 'CUTTING_RECEPTION'
  /** Terminación única de las bobinas que ya estaban en 0 (CLI, `refId` = el lote). */
  | 'BATCH';

export interface AutoTerminateCause {
  kind: AutoTerminateKind;
  refId: string;
  /** Qué la terminó, en palabras: «cierre de OP-000123». Va al motivo de la auditoría. */
  label: string;
}

export type AutoTerminateSkipReason =
  /** Montada en una OP viva: se termina al liberarla o al cerrar/anular la OP. */
  | 'MOUNTED'
  /** Anomalía: en 0 con una reserva viva sobre el rollo (venta de bobina entera). */
  | 'RESERVED'
  /** Anomalía: saldo negativo. */
  | 'NEGATIVE';

export interface PlannedCoil {
  id: string;
  code: string;
}

export interface AutoTerminatePlan {
  /** Vigentes en exactamente 0, sin montaje vivo ni reserva: las que se terminan. */
  terminate: PlannedCoil[];
  skipped: (PlannedCoil & {
    reason: AutoTerminateSkipReason;
    detail: string;
    /** En una reserva viva: los documentos que la tienen (`PED-…`, `COT-…`). */
    holders?: string[];
  })[];
}

/** Las anomalías se auditan; la montada no, porque se va a terminar sola más adelante. */
export function isAnomaly(reason: AutoTerminateSkipReason): boolean {
  return reason !== 'MOUNTED';
}

/**
 * Qué bobinas de la lista se terminarían ahora. **Solo lee.** Mira únicamente las vigentes
 * (`OPEN`): una terminada, anulada o en corte no se toca. Tres consultas más una si hay
 * candidatas en 0, sin importar cuántas bobinas vengan.
 */
export async function planAutoTerminate(
  tx: Prisma.TransactionClient,
  coilIds: readonly string[],
): Promise<AutoTerminatePlan> {
  const ids = [...new Set(coilIds)].filter((id) => id !== '');
  const plan: AutoTerminatePlan = { terminate: [], skipped: [] };
  if (ids.length === 0) return plan;

  const [coils, balances] = await Promise.all([
    tx.coil.findMany({
      where: { id: { in: ids }, status: CoilStatus.OPEN },
      select: { id: true, code: true },
      orderBy: { code: 'asc' },
    }),
    tx.inventoryBalance.findMany({
      where: { itemType: 'COIL', itemId: { in: ids } },
      select: { itemId: true, qty: true },
    }),
  ]);
  // Sin fila de saldo es 0: toda bobina nace con su entrada, pero la regla no lo supone.
  const qtyById = new Map(balances.map((b) => [b.itemId, toDecimal(b.qty.toString())]));
  const qtyOf = (id: string): Decimal => qtyById.get(id) ?? new Decimal(0);

  const zero: PlannedCoil[] = [];
  for (const { id, code } of coils) {
    const coil = { id, code };
    const qty = qtyOf(coil.id);
    if (qty.isNegative()) {
      plan.skipped.push({ ...coil, reason: 'NEGATIVE', detail: `saldo ${qty.toFixed(3)} kg` });
    } else if (qty.isZero()) {
      zero.push(coil);
    }
  }
  if (zero.length === 0) return plan;

  const zeroIds = zero.map((c) => c.id);
  const [mounts, reserved] = await Promise.all([
    findLiveStripAssignments(tx, zeroIds),
    reservedByItem(tx, 'COIL', zeroIds),
  ]);
  const mountedIn = new Map<string, string[]>();
  for (const m of mounts)
    mountedIn.set(m.coilId, [...(mountedIn.get(m.coilId) ?? []), m.orderCode]);

  // Quién reserva: solo se pregunta si hay anomalía, que es el caso raro (hoy, cero).
  const reservedIds = zero
    .filter((c) => !mountedIn.has(c.id) && (reserved.get(c.id) ?? new Decimal(0)).gt(0))
    .map((c) => c.id);
  const holders =
    reservedIds.length === 0
      ? new Map<string, string[]>()
      : await reservationHolders(tx, reservedIds);

  for (const coil of zero) {
    const orders = mountedIn.get(coil.id);
    const reservedKg = reserved.get(coil.id) ?? new Decimal(0);
    if (orders) {
      plan.skipped.push({ ...coil, reason: 'MOUNTED', detail: `montada en ${orders.join(', ')}` });
    } else if (reservedKg.gt(0)) {
      const by = holders.get(coil.id) ?? [];
      plan.skipped.push({
        ...coil,
        reason: 'RESERVED',
        detail:
          `en 0 kg con ${reservedKg.toFixed(3)} kg reservados sobre el rollo` +
          (by.length === 0 ? '' : ` por ${by.join(', ')}`),
        holders: by,
      });
    } else {
      plan.terminate.push(coil);
    }
  }
  return plan;
}

/**
 * Los documentos que reservan cada rollo (pedido con reserva firme, cotización con reserva
 * temporal vigente, D-185): lo que la anomalía nombra para que alguien pueda ir a verlo.
 */
async function reservationHolders(
  tx: Prisma.TransactionClient,
  coilIds: string[],
): Promise<Map<string, string[]>> {
  const [firm, temporary] = await Promise.all([
    tx.reservation.findMany({
      where: { itemType: 'COIL', itemId: { in: coilIds }, status: ReservationStatus.ACTIVE },
      select: { itemId: true, salesOrder: { select: { seq: true } } },
    }),
    tx.quotationReservation.findMany({
      where: { itemType: 'COIL', itemId: { in: coilIds }, ...liveTemporaryWhere() },
      select: { itemId: true, quotation: { select: { seq: true } } },
    }),
  ]);
  const out = new Map<string, string[]>();
  const add = (id: string, code: string): void => {
    const list = out.get(id) ?? [];
    if (!list.includes(code)) list.push(code);
    out.set(id, list);
  };
  for (const r of firm) add(r.itemId, salesOrderCode(r.salesOrder.seq));
  for (const r of temporary) add(r.itemId, quotationCode(r.quotation.seq));
  return out;
}

export interface AutoTerminateInput {
  actorId: string;
  coilIds: readonly string[];
  cause: AutoTerminateCause;
  /** D-124: la fecha de negocio de la operación que la dejó en 0. */
  operationDate: string;
  /** Campos extra para la auditoría (p. ej. `closedByDispatch` de D-170). */
  extra?: Record<string, string>;
}

/**
 * Termina, **dentro de la transacción de la operación**, las bobinas de la lista que quedaron
 * en exactamente 0. Devuelve el plan aplicado. Nunca mueve kardex.
 */
export async function autoTerminateEmptyCoils(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  input: AutoTerminateInput,
): Promise<AutoTerminatePlan> {
  const plan = await planAutoTerminate(tx, input.coilIds);

  for (const coil of plan.skipped) {
    if (!isAnomaly(coil.reason)) continue;
    await audit.write(tx, {
      actorId: input.actorId,
      action: 'coils.auto-terminate-skipped',
      entity: 'coils',
      entityId: coil.id,
      after: {
        reason: coil.reason,
        detail: coil.detail,
        holders: coil.holders ?? [],
        autoTerminated: { kind: input.cause.kind, refId: input.cause.refId },
        operationDate: input.operationDate,
      },
    });
  }
  if (plan.terminate.length === 0) return plan;

  const ids = plan.terminate.map((c) => c.id);
  const zeroedBy = await lastMovementByCoil(tx, ids);
  await tx.coil.updateMany({
    where: { id: { in: ids }, status: CoilStatus.OPEN },
    data: { status: CoilStatus.CLOSED },
  });
  for (const coil of plan.terminate) {
    await audit.write(tx, {
      actorId: input.actorId,
      // La misma acción que el cierre manual (RF-19) y que D-170: quien audita una bobina
      // quiere ver todos sus cierres juntos.
      action: 'coils.close',
      entity: 'coils',
      entityId: coil.id,
      before: { status: CoilStatus.OPEN },
      after: {
        status: CoilStatus.CLOSED,
        reason: `Terminada automáticamente: ${input.cause.label} (D-360)`,
        // Sin ajuste: el saldo ya estaba en 0.
        adjustment: null,
        operationDate: input.operationDate,
        autoTerminated: { kind: input.cause.kind, refId: input.cause.refId },
        zeroedBy: zeroedBy.get(coil.id) ?? null,
        ...input.extra,
      },
    });
  }
  return plan;
}

/** El último movimiento de kardex de cada bobina: el que la dejó en 0. Una consulta. */
async function lastMovementByCoil(
  tx: Prisma.TransactionClient,
  coilIds: string[],
): Promise<Map<string, { movementId: string; refType: string; refId: string | null }>> {
  const rows = await tx.inventoryMovement.findMany({
    where: { itemType: 'COIL', itemId: { in: coilIds } },
    orderBy: [{ itemId: 'asc' }, { id: 'desc' }],
    distinct: ['itemId'],
    select: { id: true, itemId: true, refType: true, refId: true },
  });
  return new Map(
    rows.map((r) => [
      r.itemId,
      { movementId: r.id.toString(), refType: r.refType, refId: r.refId },
    ]),
  );
}

export type AutoReopenSkipReason =
  /** La bobina no está terminada (ya se reabrió, o nunca se terminó). */
  | 'NOT_CLOSED'
  /** Su última terminación no es de esta operación (otra causa, o manual). */
  | 'OTHER_CAUSE';

export interface AutoReopenResult {
  reopened: PlannedCoil[];
  /** Solo las que **esta** operación había terminado alguna vez y ya no se tocan. */
  skipped: (PlannedCoil & { reason: AutoReopenSkipReason })[];
}

export interface AutoReopenInput {
  actorId: string;
  coilIds: readonly string[];
  cause: Pick<AutoTerminateCause, 'kind' | 'refId'>;
  /**
   * Revisión C06 (P1): lo que esta reversa **anula**, para reconocer como propia una
   * terminación de otra causa cuyo `zeroedBy` es uno de estos movimientos o referencias. Es
   * el caso de la bobina que la terminación única (lote) terminó después de que esta misma
   * merma o esta misma OP la dejara en 0: la terminación referencia la operación por el
   * movimiento que la dejó en 0, y la reversa la reabre igual.
   */
  zeroedBy?: { movementIds?: readonly string[]; refIds?: readonly string[] };
  /** Estado al que vuelve (por defecto vigente); la reversa de corte la devuelve al tercero. */
  targetStatus?: CoilStatus;
  /** Qué la reabre, en palabras: «reapertura de OP-000123». */
  label: string;
  operationDate: string;
}

/**
 * La reversa de la operación que terminó la bobina la **reabre**: la reversa le devuelve
 * kilos, y dejarla terminada con saldo es el estado que nadie sabría de dónde salió (D-170).
 *
 * **Solo las que terminó esa misma operación**, y eso lo dice la auditoría, no el estado: el
 * último `coils.close`/`coils.open` de la bobina tiene que ser un `coils.close` con
 * `autoTerminated` igual a esta causa. Si la bobina ya está vigente o la terminó después otra
 * cosa (una persona, otra operación), no se toca y queda anotado en la auditoría
 * (`coils.auto-reopen-skipped`). **Nunca falla por el estado de la bobina**: la reversa
 * registra y sigue.
 */
export async function reopenAutoTerminatedCoils(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  input: AutoReopenInput,
): Promise<AutoReopenResult> {
  const result = await planAutoReopen(tx, input);
  await applyAutoReopen(tx, audit, input, result);
  return result;
}

/** Qué reabriría la reversa. **Solo lee** (dos consultas). */
export async function planAutoReopen(
  tx: Prisma.TransactionClient,
  input: Pick<AutoReopenInput, 'coilIds' | 'cause' | 'zeroedBy'>,
): Promise<AutoReopenResult> {
  const result: AutoReopenResult = { reopened: [], skipped: [] };
  const ids = [...new Set(input.coilIds)].filter((id) => id !== '');
  if (ids.length === 0) return result;

  const history = await tx.auditLog.findMany({
    where: {
      entity: 'coils',
      entityId: { in: ids },
      action: { in: ['coils.close', 'coils.open'] },
    },
    orderBy: { id: 'desc' },
    select: { entityId: true, action: true, after: true },
  });
  const byCoil = new Map<string, typeof history>();
  for (const row of history) {
    if (row.entityId === null) continue;
    byCoil.set(row.entityId, [...(byCoil.get(row.entityId) ?? []), row]);
  }
  const mine = (row: { action: string; after: Prisma.JsonValue }): boolean =>
    isCause(row, input.cause) || isZeroedBy(row, input.zeroedBy);
  const touched = ids.filter((id) => (byCoil.get(id) ?? []).some(mine));
  if (touched.length === 0) return result;

  const coils = await tx.coil.findMany({
    where: { id: { in: touched } },
    select: { id: true, code: true, status: true },
    orderBy: { code: 'asc' },
  });
  for (const coil of coils) {
    const last = byCoil.get(coil.id)?.[0];
    const planned = { id: coil.id, code: coil.code };
    if (coil.status !== CoilStatus.CLOSED) {
      result.skipped.push({ ...planned, reason: 'NOT_CLOSED' });
    } else if (last?.action !== 'coils.close' || !mine(last)) {
      result.skipped.push({ ...planned, reason: 'OTHER_CAUSE' });
    } else {
      result.reopened.push(planned);
    }
  }
  return result;
}

async function applyAutoReopen(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  input: AutoReopenInput,
  result: AutoReopenResult,
): Promise<void> {
  const target = input.targetStatus ?? CoilStatus.OPEN;
  if (result.reopened.length > 0) {
    await tx.coil.updateMany({
      where: { id: { in: result.reopened.map((c) => c.id) }, status: CoilStatus.CLOSED },
      data: { status: target },
    });
  }
  for (const coil of result.reopened) {
    await audit.write(tx, {
      actorId: input.actorId,
      action: 'coils.open',
      entity: 'coils',
      entityId: coil.id,
      before: { status: CoilStatus.CLOSED },
      after: {
        status: target,
        reason: `Reabierta automáticamente: ${input.label} (D-360)`,
        adjustment: null,
        operationDate: input.operationDate,
        autoReopened: { kind: input.cause.kind, refId: input.cause.refId },
      },
    });
  }
  for (const coil of result.skipped) {
    await audit.write(tx, {
      actorId: input.actorId,
      action: 'coils.auto-reopen-skipped',
      entity: 'coils',
      entityId: coil.id,
      after: {
        reason: coil.reason,
        detail: `${input.label}: la bobina ${coil.reason === 'NOT_CLOSED' ? 'ya no está terminada' : 'fue terminada después por otra causa'}; no se toca`,
        autoReopened: { kind: input.cause.kind, refId: input.cause.refId },
        operationDate: input.operationDate,
      },
    });
  }
}

/** La terminación automática cuyo movimiento en 0 es uno de los que anula esta reversa. */
function isZeroedBy(
  row: { action: string; after: Prisma.JsonValue },
  zeroedBy: AutoReopenInput['zeroedBy'],
): boolean {
  if (zeroedBy === undefined || row.action !== 'coils.close') return false;
  const after = row.after;
  if (after === null || typeof after !== 'object' || Array.isArray(after)) return false;
  const record = after as Record<string, unknown>;
  // Solo terminaciones automáticas: un cierre manual no se deshace por una reversa.
  if (record.autoTerminated === undefined || record.autoTerminated === null) return false;
  const z = record.zeroedBy;
  if (z === null || typeof z !== 'object' || Array.isArray(z)) return false;
  const { movementId, refId } = z as Record<string, unknown>;
  return (
    (typeof movementId === 'string' && (zeroedBy.movementIds ?? []).includes(movementId)) ||
    (typeof refId === 'string' && (zeroedBy.refIds ?? []).includes(refId))
  );
}

function isCause(
  row: { action: string; after: Prisma.JsonValue },
  cause: Pick<AutoTerminateCause, 'kind' | 'refId'>,
): boolean {
  if (row.action !== 'coils.close') return false;
  const after = row.after;
  if (after === null || typeof after !== 'object' || Array.isArray(after)) return false;
  const auto = (after as Record<string, unknown>).autoTerminated;
  if (auto === null || typeof auto !== 'object' || Array.isArray(auto)) return false;
  const { kind, refId } = auto as Record<string, unknown>;
  return kind === cause.kind && refId === cause.refId;
}
