import {
  ReservationStatus,
  Role,
  TemporaryReservationStatus,
  type InventoryItemType,
  type Prisma,
} from '@prisma/client';
import { Decimal, quotationCode, toDecimal } from '@ayr/shared';

/**
 * La suma de "reservado" del sistema: firme (`reservations`) más temporal vigente
 * (`quotation_reservations`, D-185).
 *
 * **Módulo hoja: no importa nada de `sales`.** Lo usan `reservation-guard.ts` y
 * `raw-material.ts`, que ya se importan entre sí; si esto viviera en cualquiera de los dos, el
 * otro cerraría un ciclo — la misma clase de defecto que D-130 encontró en `@ayr/shared`.
 */

/**
 * D-185: una reserva temporal **descuenta disponible hoy** si está `ACTIVE` y todavía no
 * venció. La expiración es perezosa —no hay job—, así que el vencimiento se evalúa en cada
 * lectura con este predicado: una vencida sin marcar cuenta como liberada en todo el sistema.
 */
export function liveTemporaryWhere(now: Date = new Date()): Prisma.QuotationReservationWhereInput {
  return { status: TemporaryReservationStatus.ACTIVE, expiresAt: { gt: now } };
}

/** Quién va a leer el mensaje que nombra a los titulares de una reserva. */
export interface HolderViewer {
  id: string;
  role: Role;
}

/**
 * D-275 (criterio de D-267): cómo se nombra una reserva temporal en un mensaje. A un VENDEDOR no
 * se le nombra la cotización de otro vendedor (o sin vendedor): lee «cotización no disponible».
 * La suya y todo rol no VENDEDOR ven el código. Sin `viewer` (herramientas de ADMINISTRADOR,
 * producción) no se oculta.
 */
export function temporaryHolderCode(
  quotation: { seq: number; sellerId: string | null },
  viewer?: HolderViewer,
): string {
  const foreign = viewer?.role === Role.VENDEDOR && quotation.sellerId !== viewer.id;
  return `${foreign ? 'cotización no disponible' : quotationCode(quotation.seq)} (reserva temporal)`;
}

/**
 * De quién **no** es lo reservado que se está contando. Las dos primeras son las del ledger
 * firme (ver `RawMaterialScope`); `exceptQuotationIds` es la reserva temporal propia — la
 * vista previa de confirmar la necesita para no restarse a sí misma.
 */
export interface ReservedScope {
  exceptReservationIds?: string[];
  exceptSalesOrderIds?: string[];
  exceptQuotationIds?: string[];
}

export function firmScopeWhere(scope: ReservedScope): Prisma.ReservationWhereInput {
  const reservationIds = scope.exceptReservationIds ?? [];
  const salesOrderIds = scope.exceptSalesOrderIds ?? [];
  return {
    ...(reservationIds.length === 0 ? {} : { id: { notIn: reservationIds } }),
    ...(salesOrderIds.length === 0 ? {} : { salesOrderId: { notIn: salesOrderIds } }),
  };
}

export function temporaryScopeWhere(scope: ReservedScope): Prisma.QuotationReservationWhereInput {
  const quotationIds = scope.exceptQuotationIds ?? [];
  return quotationIds.length === 0 ? {} : { quotationId: { notIn: quotationIds } };
}

/**
 * **Lo reservado vivo de un conjunto de ítems del mismo tipo: firme más temporal vigente.**
 *
 * Existe por D-185: antes cada lectura de disponible hacía su propio `groupBy` sobre
 * `reservations`, y agregar la reserva temporal obligaba a acordarse de sumarla en cada una.
 * Una que se olvidara prometería dos veces el mismo kilo — la temporal en una pantalla y la
 * firme en otra.
 */
export async function reservedByItem(
  tx: Prisma.TransactionClient,
  itemType: InventoryItemType,
  itemIds: readonly string[],
  scope: ReservedScope = {},
): Promise<Map<string, Decimal>> {
  const ids = [...new Set(itemIds)].filter((id) => id !== '');
  const out = new Map<string, Decimal>();
  if (ids.length === 0) return out;
  const [firm, temporary] = await Promise.all([
    tx.reservation.groupBy({
      by: ['itemId'],
      where: {
        status: ReservationStatus.ACTIVE,
        itemType,
        itemId: { in: ids },
        ...firmScopeWhere(scope),
      },
      _sum: { qty: true },
    }),
    tx.quotationReservation.groupBy({
      by: ['itemId'],
      where: {
        ...liveTemporaryWhere(),
        itemType,
        itemId: { in: ids },
        ...temporaryScopeWhere(scope),
      },
      _sum: { qty: true },
    }),
  ]);
  for (const row of [...firm, ...temporary]) {
    if (row._sum.qty === null) continue;
    out.set(
      row.itemId,
      (out.get(row.itemId) ?? new Decimal(0)).plus(toDecimal(row._sum.qty.toString())),
    );
  }
  return out;
}

/**
 * D-185: marca `EXPIRED` las temporales vencidas. No es la regla —la regla es
 * `liveTemporaryWhere`, que ya las ignora—: es la limpieza que deja la lista y el historial
 * diciendo la verdad. La llaman las escrituras que tocan reservas temporales.
 */
export async function sweepExpiredTemporaryReservations(
  tx: Prisma.TransactionClient,
  where: Prisma.QuotationReservationWhereInput = {},
): Promise<number> {
  const now = new Date();
  const result = await tx.quotationReservation.updateMany({
    where: { ...where, status: TemporaryReservationStatus.ACTIVE, expiresAt: { lte: now } },
    data: { status: TemporaryReservationStatus.EXPIRED, endedAt: now, endReason: 'Venció' },
  });
  return result.count;
}
