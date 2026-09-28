import { CoilStatus, type Prisma } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import {
  autoTerminateEmptyCoils,
  planAutoReopen,
  planAutoTerminate,
  reopenAutoTerminatedCoils,
  type AutoReopenResult,
  type AutoTerminatePlan,
} from './coil-auto-terminate';

/**
 * D-360 — **terminación única** de las bobinas que ya estaban vigentes con saldo 0 antes de que
 * la terminación automática existiera. La regla es la misma que la del disparo en línea
 * (`planAutoTerminate`: exactamente 0, sin montaje vivo ni reserva, sin kardex); lo único propio
 * es la causa: un **lote** (`BATCH`, `refId` = el `batchId` de la corrida), que es lo que hace
 * posible deshacer exactamente esa corrida y nada más (`undoTerminateZeroCoils`).
 */

export const BATCH_LABEL = (batchId: string): string =>
  `terminación única de bobinas en 0 kg (lote ${batchId})`;

/** Las vigentes: las únicas que la regla puede terminar. */
async function openCoilIds(tx: Prisma.TransactionClient): Promise<string[]> {
  const rows = await tx.coil.findMany({
    where: { status: CoilStatus.OPEN },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Dry-run: qué terminaría la corrida hoy. Solo lee. */
export async function planTerminateZeroCoils(
  tx: Prisma.TransactionClient,
): Promise<AutoTerminatePlan> {
  return planAutoTerminate(tx, await openCoilIds(tx));
}

export async function executeTerminateZeroCoils(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  input: { actorId: string; batchId: string; operationDate: string },
): Promise<AutoTerminatePlan> {
  return autoTerminateEmptyCoils(tx, audit, {
    actorId: input.actorId,
    coilIds: await openCoilIds(tx),
    cause: { kind: 'BATCH', refId: input.batchId, label: BATCH_LABEL(input.batchId) },
    operationDate: input.operationDate,
  });
}

/** Las bobinas que terminó ese lote, según su auditoría. */
export async function coilsOfBatch(
  tx: Prisma.TransactionClient,
  batchId: string,
): Promise<{ id: string; code: string; status: CoilStatus }[]> {
  const rows = await tx.auditLog.findMany({
    where: {
      entity: 'coils',
      action: 'coils.close',
      after: { path: ['autoTerminated', 'refId'], equals: batchId },
    },
    select: { entityId: true, after: true },
  });
  const ids = rows
    .filter((r) => {
      const after = r.after as { autoTerminated?: { kind?: unknown } } | null;
      return after?.autoTerminated?.kind === 'BATCH';
    })
    .map((r) => r.entityId)
    .filter((id): id is string => id !== null);
  if (ids.length === 0) return [];
  return tx.coil.findMany({
    where: { id: { in: ids } },
    select: { id: true, code: true, status: true },
    orderBy: { code: 'asc' },
  });
}

/** Dry-run de la reversa: qué reabriría. Solo lee. */
export async function planUndoTerminateZeroCoils(
  tx: Prisma.TransactionClient,
  batchId: string,
): Promise<AutoReopenResult> {
  const coils = await coilsOfBatch(tx, batchId);
  return planAutoReopen(tx, {
    coilIds: coils.map((c) => c.id),
    cause: { kind: 'BATCH', refId: batchId },
  });
}

/**
 * La reversa masiva: reabre **exactamente** las bobinas de esa corrida cuyo último cambio de
 * estado sigue siendo la terminación del lote. Una que ya se reabrió o que se terminó después
 * por otra causa no se toca y queda anotada (regla común de `reopenAutoTerminatedCoils`).
 */
export async function undoTerminateZeroCoils(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  input: { actorId: string; batchId: string; operationDate: string },
): Promise<AutoReopenResult> {
  const coils = await coilsOfBatch(tx, input.batchId);
  return reopenAutoTerminatedCoils(tx, audit, {
    actorId: input.actorId,
    coilIds: coils.map((c) => c.id),
    cause: { kind: 'BATCH', refId: input.batchId },
    label: `reversa de la ${BATCH_LABEL(input.batchId)}`,
    operationDate: input.operationDate,
  });
}

const SKIP_LABELS: Record<AutoTerminatePlan['skipped'][number]['reason'], string> = {
  MOUNTED: 'montada en una OP viva (se termina al liberarla o al cerrar la OP)',
  RESERVED: 'ANOMALÍA: en 0 con reserva viva sobre el rollo',
  NEGATIVE: 'ANOMALÍA: saldo negativo',
};

/** El texto de la lista que revisa el dueño (dry-run y ejecución). */
export function formatTerminatePlan(
  plan: AutoTerminatePlan,
  header: { branch: string; mode: string; batchId?: string },
): string {
  const lines = [
    `Terminación única de bobinas en 0 kg (D-360) — rama ${header.branch} — ${header.mode}`,
    ...(header.batchId ? [`Lote: ${header.batchId}`] : []),
    `Fecha: ${new Date().toISOString()}`,
    '',
    `Se terminan: ${String(plan.terminate.length)}`,
    ...plan.terminate.map((c) => `  ${c.code}`),
    '',
    `Omitidas: ${String(plan.skipped.length)}`,
    ...plan.skipped.map((c) => `  ${c.code} — ${SKIP_LABELS[c.reason]} (${c.detail})`),
  ];
  return `${lines.join('\n')}\n`;
}

export function formatUndo(
  result: AutoReopenResult,
  header: { branch: string; mode: string; batchId: string },
): string {
  const lines = [
    `Reversa de la terminación única (D-360) — rama ${header.branch} — ${header.mode}`,
    `Lote: ${header.batchId}`,
    '',
    `Se reabren: ${String(result.reopened.length)}`,
    ...result.reopened.map((c) => `  ${c.code}`),
    '',
    `No se tocan: ${String(result.skipped.length)}`,
    ...result.skipped.map(
      (c) =>
        `  ${c.code} — ${c.reason === 'NOT_CLOSED' ? 'ya no está terminada' : 'terminada después por otra causa'}`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
