import { BadRequestException } from '@nestjs/common';
import { ProductionOrderStatus, type Prisma } from '@prisma/client';
import { Decimal, productionOrderCode, toDecimal } from '@ayr/shared';

/**
 * Guardrail transversal de Fase 4 (D-060).
 *
 * Asignar un fleje a una orden de producción **no deja rastro en el kardex** (mismo
 * criterio que D-050 con el envío a corte tercerizado): el fleje sigue en el almacén y en
 * el saldo de la empresa hasta que un reporte de piezas lo consume de verdad. Eso
 * significa que ninguna de las reglas "no tiene movimientos posteriores" que protegen al
 * resto de operaciones (RF-16, RF-21, D-045, D-052) ve la asignación — exactamente el
 * mismo hueco que Fase 3 tuvo que tapar a mano cuando D-050 introdujo `IN_THIRD_PARTY`.
 *
 * Por eso vive en una función suelta y no en un servicio: la consultan `coils`, `cutting`
 * y `purchases`, y hacerla un provider inyectable metería a `production` en un ciclo de
 * módulos con los tres.
 */

/** Estados en los que la OP todavía retiene los flejes que se le asignaron. */
const LIVE_STATUSES = [ProductionOrderStatus.DRAFT, ProductionOrderStatus.IN_PROGRESS];

export interface StripAssignment {
  coilId: string;
  coilCode: string;
  orderId: string;
  orderCode: string;
  /**
   * D-154: kilos del rollo que el agregado de materia prima tiene que dar por perdidos
   * mientras esta orden lo retenga. **No es el rollo entero, y casi nunca es `assignedKg`.**
   *
   * Una OP que nace de un pedido (D-084) ya tiene su compromiso contado: es la reserva
   * genérica de ese pedido, que sigue viva sobre la spec y que el disponible resta como
   * `reservedGeneric`. Contar además la custodia sería **contar dos veces el mismo kilo**, y
   * ese era el defecto: planta monta el rollo entero —5 000 kg— para cortar los 200 que el
   * pedido prometió, y el agregado quedaba en cero sobre un almacén con 4 800 kg libres. Lo
   * que la orden vaya consumiendo baja las dos cifras a la vez (`consumeReservationQty` con
   * la salida de kardex), así que la cuenta se mantiene sola.
   *
   * Una corrida **a stock** (D-140) no tiene reserva que la represente, así que ahí sí manda
   * la custodia: `assignedKg − consumedKg`.
   */
  heldKg: Decimal;
}

/** Asignaciones vivas de esos flejes, si las hay. Lista vacía cuando ninguno está tomado. */
export async function findLiveStripAssignments(
  tx: Prisma.TransactionClient,
  coilIds: string[],
): Promise<StripAssignment[]> {
  if (coilIds.length === 0) return [];
  const rows = await tx.productionOrderConsumption.findMany({
    where: {
      coilId: { in: coilIds },
      releasedAt: null,
      productionOrder: { status: { in: LIVE_STATUSES } },
    },
    select: {
      coilId: true,
      assignedKg: true,
      consumedKg: true,
      coil: { select: { code: true } },
      productionOrder: { select: { id: true, seq: true, reservationId: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    coilId: r.coilId,
    coilCode: r.coil.code,
    orderId: r.productionOrder.id,
    orderCode: productionOrderCode(r.productionOrder.seq),
    heldKg:
      r.productionOrder.reservationId !== null
        ? new Decimal(0)
        : Decimal.max(
            toDecimal(r.assignedKg.toString()).minus(toDecimal(r.consumedKg.toString())),
            new Decimal(0),
          ),
  }));
}

/**
 * Corta la operación si alguno de esos flejes está tomado por una OP viva. `action`
 * completa la frase "… antes de <action>", para que el mensaje diga qué hacer y no solo
 * que no se puede.
 *
 * **Bloquea las filas de los flejes antes de mirar** (`FOR UPDATE`, en orden de id para no
 * cruzarse con otra transacción): `ProductionService.consume` toma ese mismo lock antes de
 * crear la asignación, así que sin esto quedaba una ventana en la que el chequeo veía la
 * lista vacía, un consumo concurrente commiteaba, y la operación seguía adelante anulando
 * un fleje que para entonces ya era de una orden viva. Los llamadores que ya tienen el
 * lock (los de `coils`, vía `lockCoil`) no pagan nada: volver a pedirlo es un no-op.
 */
export async function assertStripsNotAssigned(
  tx: Prisma.TransactionClient,
  coilIds: string[],
  action: string,
): Promise<void> {
  if (coilIds.length === 0) return;
  const sorted = [...new Set(coilIds)].sort();
  await tx.$queryRaw`
    SELECT "id" FROM "coils" WHERE "id" = ANY(${sorted}::uuid[]) ORDER BY "id" FOR UPDATE
  `;
  const assignments = await findLiveStripAssignments(tx, coilIds);
  if (assignments.length === 0) return;
  const detail = assignments.map((a) => `${a.coilCode} (${a.orderCode})`).join(', ');
  throw new BadRequestException(
    `Hay flejes asignados a una orden de producción en curso: ${detail}. Libéralos o anula la orden antes de ${action}.`,
  );
}
