import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  ProductionOrderKind,
  ProductionOrderStatus,
  ProductionReportStatus,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
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
  bomId: string;
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
      bomId: true,
      notes: true,
      closedAt: true,
      reservationId: true,
    },
  });
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
): Promise<boolean> {
  const stillReported = await tx.productionReport.count({
    where: { productionOrderId: orderId, status: ProductionReportStatus.ACTIVE },
  });
  if (stillReported > 0) return false;
  return restoreReservation(tx, reservationId);
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
