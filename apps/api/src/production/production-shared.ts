import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  ProductionOrderKind,
  ProductionOrderStatus,
  ProductionReportStatus,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
import {
  DRYWALL_TOLERANCE_OVERRIDE_REASON_LABELS,
  DRYWALL_TOLERANCE_OVERRIDE_REASONS,
  drywallToleranceOverrideLabel,
  productionOrderCode,
  TOLERANCE_OVERRIDE_REASON_LABELS,
  TOLERANCE_OVERRIDE_REASONS,
  TOLERANCE_OVERRIDE_REASONS_OVER,
  toleranceOverrideLabel,
  type ANY_TOLERANCE_OVERRIDE_REASONS,
  type Decimal,
  type DrywallToleranceOverrideInput,
  type MountedKgExcess,
  type ToleranceOverrideInput,
} from '@ayr/shared';
import { z } from 'zod';
import { restoreReservation } from '../sales/reservation-guard';

/**
 * Lo que las dos ramas de producción comparten (D-087).
 *
 * `production_orders` es una sola tabla para drywall y coberturas —un mismo correlativo, los
 * mismos estados, el mismo ledger de reservas y la misma auditoría— pero los servicios que
 * la operan son dos, porque el material, la receta y la merma no se parecen en nada. Estas
 * funciones son la mitad que sí es idéntica, y viven sueltas por el mismo motivo que
 * `production-assignments.ts` y `reservation-guard.ts`: convertirlas en un provider metería
 * a los dos servicios en un ciclo de módulos sin ganar nada.
 */

/** La orden bloqueada, con lo mínimo que las dos ramas necesitan para decidir. */
export interface LockedOrder {
  id: string;
  seq: number;
  kind: ProductionOrderKind;
  status: ProductionOrderStatus;
  businessLineId: string;
  productId: string;
  notes: string | null;
  closedAt: Date | null;
  reservationId: string | null;
}

/**
 * `SELECT … FOR UPDATE` sobre la orden y después su lectura. El lock va primero y siempre:
 * reportar, cerrar, revertir y anular compiten por las mismas filas de asignación, y sin él
 * dos de esas operaciones simultáneas ven cada una un estado que la otra está por cambiar.
 */
export async function lockOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<LockedOrder> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "production_orders" WHERE "id" = ${orderId}::uuid FOR UPDATE
  `;
  if (locked.length === 0) throw new NotFoundException('Orden de producción no encontrada');
  return tx.productionOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      id: true,
      seq: true,
      kind: true,
      status: true,
      businessLineId: true,
      productId: true,
      notes: true,
      closedAt: true,
      reservationId: true,
    },
  });
}

/**
 * D-388: la acción de auditoría del reporte de coberturas autorizado fuera de la tolerancia del
 * 1 %. La escribe el reporte y la lee el detalle de la orden para su etiqueta: un solo nombre.
 */
export const TOLERANCE_OVERRIDE_AUDIT_ACTION = 'production.roofing.report-tolerance-override';

/** D-388: lo que el detalle de la orden lee de esa entrada (el resto queda para quien audita). */
export const toleranceOverrideAuditSchema = z.object({
  reportId: z.string(),
  reason: z.enum(TOLERANCE_OVERRIDE_REASONS),
  detail: z.string().nullable(),
  differenceKg: z.string(),
  differencePct: z.string(),
});

/** D-465: la acción propia del reporte de drywall autorizado fuera de la tolerancia del 1 %. */
export const DRYWALL_TOLERANCE_OVERRIDE_AUDIT_ACTION =
  'production.drywall.report-tolerance-override';

/** D-465: las dos acciones que leen la etiqueta «Fuera de tolerancia» (detalle, merma y Panel). */
export const TOLERANCE_OVERRIDE_AUDIT_ACTIONS = [
  TOLERANCE_OVERRIDE_AUDIT_ACTION,
  DRYWALL_TOLERANCE_OVERRIDE_AUDIT_ACTION,
];

const drywallToleranceOverrideAuditSchema = toleranceOverrideAuditSchema.extend({
  reason: z.enum(DRYWALL_TOLERANCE_OVERRIDE_REASONS),
});

/**
 * D-465: una entrada de auditoría de casilla, de cualquiera de las dos líneas, con su motivo en
 * palabras; `null` si no es una de ellas o no se lee.
 */
export function readToleranceOverrideAudit(row: { action: string; after: unknown }): {
  reportId: string;
  reason: (typeof ANY_TOLERANCE_OVERRIDE_REASONS)[number];
  detail: string | null;
  label: string;
  differenceKg: string;
  differencePct: string;
} | null {
  if (row.action === DRYWALL_TOLERANCE_OVERRIDE_AUDIT_ACTION) {
    const parsed = drywallToleranceOverrideAuditSchema.safeParse(row.after);
    if (!parsed.success) return null;
    const { reason, detail } = parsed.data;
    return {
      ...parsed.data,
      label: drywallToleranceOverrideLabel({ reason, ...(detail === null ? {} : { detail }) }),
    };
  }
  if (row.action !== TOLERANCE_OVERRIDE_AUDIT_ACTION) return null;
  const parsed = toleranceOverrideAuditSchema.safeParse(row.after);
  if (!parsed.success) return null;
  const { reason, detail } = parsed.data;
  return {
    ...parsed.data,
    label: toleranceOverrideLabel({ reason, ...(detail === null ? {} : { detail }) }),
  };
}

/** D-465: el `after` de la auditoría propia del reporte de drywall autorizado fuera de tolerancia. */
export function drywallToleranceOverrideAuditAfter(input: {
  reportId: string;
  orderId: string;
  orderSeq: number;
  strips: readonly { coilId: string; coilCode: string; kg: Decimal }[];
  realKg: string;
  override: DrywallToleranceOverrideInput;
  excess: MountedKgExcess;
}): Prisma.InputJsonObject {
  const { override, excess } = input;
  return {
    reportId: input.reportId,
    productionOrderId: input.orderId,
    productionOrderCode: productionOrderCode(input.orderSeq),
    strips: input.strips.map((s) => ({
      coilId: s.coilId,
      coilCode: s.coilCode,
      kg: s.kg.toFixed(3),
    })),
    theoreticalKg: excess.theoreticalKg,
    realKg: input.realKg,
    differenceKg: excess.excessKg,
    differencePct: excess.excessPct,
    severe: excess.severe,
    reason: override.reason,
    reasonLabel: DRYWALL_TOLERANCE_OVERRIDE_REASON_LABELS[override.reason],
    detail: override.detail === undefined || override.detail === '' ? null : override.detail,
  };
}

/**
 * D-388: el rechazo de `mountedKgForReport`. Con código (la franja 1–5 % sin casilla, o más del
 * 5 %) el cuerpo lleva el código y las cifras, que la pantalla lee para ofrecer la casilla; sin
 * código es el mensaje de siempre.
 */
export function mountedKgRejection(result: {
  message: string;
  code?: string;
  excess?: MountedKgExcess;
}): BadRequestException {
  return new BadRequestException(
    result.code === undefined
      ? result.message
      : {
          statusCode: 400,
          error: 'Bad Request',
          code: result.code,
          message: result.message,
          excess: result.excess,
        },
  );
}

/**
 * cc28 (P2-2 de cc20): cuando una fila pasa la tolerancia y la orden tiene **otra** bobina montada
 * con saldo, el rechazo lo dice: lo que falta en esta bobina puede haber salido de la otra, y la
 * casilla («bobina más liviana») dejaría esta en cero con un faltante que está en aquella. Solo es
 * texto: ni el rechazo ni la casilla cambian. `null` si no hay otra bobina con saldo.
 */
export function otherMountedCoilsHint(
  current: string,
  mounted: readonly { code: string; remainingKg: Decimal }[],
): string | null {
  const others = mounted.filter((m) => m.code !== current && m.remainingKg.gt(0));
  if (others.length === 0) return null;
  const list = others.map((m) => `${m.code} (${m.remainingKg.toFixed(3)} kg)`).join(', ');
  return `La orden tiene otra bobina montada con saldo: ${list}. Si parte de estas planchas salió de ahí, repórtala con esa bobina en vez de confirmar la casilla.`;
}

/**
 * D-388: la casilla que de verdad se aplicó. Solo cuenta si el reporte pasó la tolerancia y
 * entró por la franja autorizada: una casilla dentro del 1 % no deja rastro.
 */
export function appliedToleranceOverride(
  mounted: { overridden: boolean; excess: MountedKgExcess | null },
  override: ToleranceOverrideInput | undefined,
): { override: ToleranceOverrideInput; excess: MountedKgExcess } | null {
  if (!mounted.overridden || mounted.excess === null || override === undefined) return null;
  return { override, excess: mounted.excess };
}

/** D-388: el `after` de la auditoría propia del reporte autorizado fuera de tolerancia. */
export function toleranceOverrideAuditAfter(input: {
  reportId: string;
  orderId: string;
  orderSeq: number;
  coilId: string;
  coilCode: string;
  realKg: string;
  applied: { override: ToleranceOverrideInput; excess: MountedKgExcess };
}): Prisma.InputJsonObject {
  const { override, excess } = input.applied;
  return {
    reportId: input.reportId,
    productionOrderId: input.orderId,
    productionOrderCode: productionOrderCode(input.orderSeq),
    coilId: input.coilId,
    coilCode: input.coilCode,
    theoreticalKg: excess.theoreticalKg,
    realKg: input.realKg,
    differenceKg: excess.excessKg,
    differencePct: excess.excessPct,
    // D-389: pasó el 5 % (aviso fuerte). Sin tope, es la marca para revisar después.
    severe: excess.severe,
    reason: override.reason,
    reasonLabel: TOLERANCE_OVERRIDE_REASON_LABELS[override.reason],
    detail: override.detail === undefined || override.detail === '' ? null : override.detail,
  };
}

/** Corta si la orden ya es terminal. `action` completa "no se puede <action>". */
export function assertLive(order: { status: ProductionOrderStatus }, action: string): void {
  if (
    order.status === ProductionOrderStatus.CLOSED ||
    order.status === ProductionOrderStatus.CANCELLED
  ) {
    throw new BadRequestException(
      `La orden está ${order.status === ProductionOrderStatus.CLOSED ? 'cerrada' : 'anulada'}: no se puede ${action}`,
    );
  }
}

/**
 * Corta si la orden no es de la rama que la está operando. Cada servicio expone sus propias
 * rutas, así que esto solo puede fallar si alguien manda el id de una OP de la otra clase —
 * pero entonces la operación seguiría adelante con la aritmética equivocada, que es
 * exactamente el error que más caro sale de encontrar después.
 */
export function assertKind(order: LockedOrder, expected: ProductionOrderKind): void {
  if (order.kind === expected) return;
  throw new BadRequestException(
    expected === ProductionOrderKind.ROOFING
      ? 'Esa orden es de perfiles de drywall: opérala desde producción de drywall'
      : 'Esa orden es de coberturas: opérala desde producción de coberturas',
  );
}

/** `DRAFT` cuando la orden se quedó sin material tomado ni piezas vigentes. */
export async function recomputeStatus(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<void> {
  const [assigned, reports] = await Promise.all([
    tx.productionOrderConsumption.count({
      where: { productionOrderId: orderId, releasedAt: null },
    }),
    tx.productionReport.count({
      where: { productionOrderId: orderId, status: ProductionReportStatus.ACTIVE },
    }),
  ]);
  await tx.productionOrder.update({
    where: { id: orderId },
    data: {
      status:
        assigned === 0 && reports === 0
          ? ProductionOrderStatus.DRAFT
          : ProductionOrderStatus.IN_PROGRESS,
    },
  });
}

/**
 * Devuelve la reserva del pedido a `ACTIVA` cuando la orden deja de tener material en juego:
 * ningún reporte vigente. Es la mitad simétrica de `markReservationConsumed` (D-066): la
 * reserva se consume con el primer reporte y vuelve cuando el último se revierte o la orden
 * se anula.
 *
 * Con reportes vigentes no restaura nada: parte del material ya salió del insumo y sigue
 * representado en producto terminado, así que la promesa sigue cumplida en esa medida.
 */
export async function restoreReservationIfIdle(
  tx: Prisma.TransactionClient,
  orderId: string,
  reservationId: string,
  /** D-134: tolerancia de espesor, para revalidar el agregado si la promesa es genérica. */
  toleranceMm?: string,
): Promise<boolean> {
  const stillReported = await tx.productionReport.count({
    where: { productionOrderId: orderId, status: ProductionReportStatus.ACTIVE },
  });
  if (stillReported > 0) return false;
  return restoreReservation(tx, reservationId, toleranceMm);
}

/** Nombres de los usuarios que firmaron una orden y sus reportes, para el DTO. */
export async function resolveActorNames(
  db: PrismaClient | Prisma.TransactionClient,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(users.map((u) => [u.id, u.name]));
}

/**
 * D-389: el motivo tiene que aplicar a la dirección del exceso. El reporte que pasa lo montado es
 * un exceso **hacia arriba** —la bobina rindió más que su nominal—: «Bobina más pesada» no lo
 * explica y se rechaza (la pantalla tampoco lo ofrece).
 */
export function assertToleranceReasonApplies(reason: ToleranceOverrideInput['reason']): void {
  if (!TOLERANCE_OVERRIDE_REASONS_OVER.includes(reason)) {
    throw new BadRequestException(
      `«${TOLERANCE_OVERRIDE_REASON_LABELS[reason]}» no explica que lo reportado pase lo montado: elige otro motivo`,
    );
  }
}
