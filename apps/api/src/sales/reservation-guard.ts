import { BadRequestException } from '@nestjs/common';
import {
  InventoryItemType,
  ReservationStatus,
  SalesOrderStatus,
  type Prisma,
} from '@prisma/client';
import { Decimal, salesOrderCode, toDecimal } from '@ayr/shared';

/**
 * Guardrail transversal de Fase 5a (D-054, D-066): la invariante `disponible ≥ reservado`.
 *
 * Una reserva vive en su propio ledger, **fuera del kardex** (D-054): un `OUT` ficticio por
 * cada cotización confirmada ensuciaría el promedio ponderado y el valorizado (RF-90..94)
 * con una salida que todavía no ocurrió. El precio de esa decisión es exactamente el mismo
 * que pagaron D-050 (envío a corte) y D-060 (fleje asignado a una OP): **ninguna** de las
 * reglas "no tiene movimientos posteriores" que protegen al resto del sistema ve una
 * reserva, porque no hay movimiento que ver. Así que el bloqueo se aplica a mano, y en dos
 * formas distintas según qué se esté por romper:
 *
 * 1. **Cantidad** — `assertReservationInvariant`. Vive dentro de `InventoryService`, en el
 *    único punto por el que pasa toda salida de stock (§3.2), y bajo el mismo lock de saldo
 *    que el kardex ya toma. Cubre de un solo golpe la merma (RF-17), el partido (RF-15), la
 *    anulación de una compra o de una bobina, el consumo de producción y cualquier ruta
 *    futura: si el saldo resultante queda por debajo de lo reservado vivo, falla.
 * 2. **Custodia** — `assertNotReserved`. Para las operaciones que se llevan el ítem entero
 *    **sin mover kardex**, que son justo las que el punto 1 no puede ver: enviar la bobina
 *    a un tercero (D-050) o asignarla a una orden de producción ajena (D-060).
 *
 * Vive en una función suelta y no en un servicio por el mismo motivo que
 * `production-assignments.ts`: la consultan `inventory`, `coils`, `cutting` y `production`,
 * y hacerla un provider inyectable metería a `sales` en un ciclo de módulos con los cuatro.
 */

/** Coordenadas de un ítem en el kardex; el mismo par que usa `inventory_balances`. */
export interface ReservedItemRef {
  itemType: InventoryItemType;
  itemId: string;
}

export interface ActiveReservation {
  reservationId: string;
  itemType: InventoryItemType;
  itemId: string;
  qty: Decimal;
  unit: string;
  orderId: string;
  orderCode: string;
}

/**
 * Reservas `ACTIVA` sobre esos ítems. Solo `ACTIVE` cuenta: una `CONSUMIDA` ya se convirtió
 * en material que salió y una `LIBERADA` dejó de prometer nada (D-054).
 */
export async function findActiveReservations(
  tx: Prisma.TransactionClient,
  items: ReservedItemRef[],
): Promise<ActiveReservation[]> {
  if (items.length === 0) return [];
  const rows = await tx.reservation.findMany({
    where: {
      status: ReservationStatus.ACTIVE,
      OR: items.map((i) => ({ itemType: i.itemType, itemId: i.itemId })),
    },
    select: {
      id: true,
      itemType: true,
      itemId: true,
      qty: true,
      unit: true,
      salesOrder: { select: { id: true, seq: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    reservationId: r.id,
    itemType: r.itemType,
    itemId: r.itemId,
    qty: toDecimal(r.qty.toString()),
    unit: r.unit,
    orderId: r.salesOrder.id,
    orderCode: salesOrderCode(r.salesOrder.seq),
  }));
}

/** Kilos (o unidades) reservados vivos de un ítem. Cero cuando no hay ninguna reserva. */
export async function reservedQty(
  tx: Prisma.TransactionClient,
  item: ReservedItemRef,
): Promise<Decimal> {
  const agg = await tx.reservation.aggregate({
    where: { status: ReservationStatus.ACTIVE, itemType: item.itemType, itemId: item.itemId },
    _sum: { qty: true },
  });
  return agg._sum.qty === null ? new Decimal(0) : toDecimal(agg._sum.qty.toString());
}

/**
 * La invariante, en el único punto por el que pasa toda salida de stock.
 *
 * `newQty` es el saldo que el movimiento **dejaría**. El llamador tiene que haber tomado
 * ya el lock del saldo (`FOR UPDATE`): la lectura de las reservas se hace bajo ese lock,
 * así que una confirmación de pedido concurrente no puede colarse entre el chequeo y la
 * escritura — la otra transacción se queda esperando el mismo saldo.
 *
 * Solo se comprueba cuando el saldo baja: una entrada nunca puede romper la invariante, y
 * comprobarla igual haría una consulta extra por cada ingreso de compra.
 */
export async function assertReservationInvariant(
  tx: Prisma.TransactionClient,
  item: ReservedItemRef,
  newQty: Decimal,
  previousQty: Decimal,
): Promise<void> {
  if (newQty.gte(previousQty)) return;
  const reserved = await reservedQty(tx, item);
  if (reserved.isZero() || newQty.gte(reserved)) return;

  const holders = await findActiveReservations(tx, [item]);
  const detail = holders.map((h) => `${h.orderCode} (${h.qty.toFixed(3)} ${h.unit})`).join(', ');
  throw new BadRequestException(
    `La operación dejaría ${newQty.toFixed(3)} en stock y hay ${reserved.toFixed(3)} reservados para ${detail}. Anula el pedido o libera la reserva antes de continuar.`,
  );
}

/**
 * Corta la operación si alguno de esos ítems tiene una reserva viva. `action` completa la
 * frase "… antes de <action>", igual que `assertStripsNotAssigned` (D-060), para que el
 * mensaje diga qué hacer y no solo que no se puede.
 *
 * Es el guardrail de **custodia**: se usa donde el ítem entero cambia de manos sin dejar
 * rastro en el kardex (enviar a corte, asignar a una OP). Ahí la invariante de cantidad no
 * sirve, porque el saldo no se mueve y aun así la promesa deja de poder cumplirse.
 *
 * `exceptReservationIds` es la reserva **propia**: la OP que nace del pedido tiene que
 * poder montar el material que ese mismo pedido reservó. Sin esa excepción, la reserva se
 * bloquearía a sí misma.
 */
export async function assertNotReserved(
  tx: Prisma.TransactionClient,
  items: ReservedItemRef[],
  action: string,
  exceptReservationIds: string[] = [],
): Promise<void> {
  if (items.length === 0) return;
  const reservations = await findActiveReservations(tx, items);
  const blocking = reservations.filter((r) => !exceptReservationIds.includes(r.reservationId));
  if (blocking.length === 0) return;
  const detail = blocking.map((r) => `${r.qty.toFixed(3)} ${r.unit} de ${r.orderCode}`).join(', ');
  throw new BadRequestException(
    `Hay stock reservado por un pedido en curso: ${detail}. Anula el pedido o libera la reserva antes de ${action}.`,
  );
}

/**
 * Marca una reserva como `CONSUMIDA` (D-054). La llama `production` cuando la OP nacida
 * del pedido emite material, **antes** de escribir la salida de kardex: si el orden fuera
 * el inverso, la propia reserva bloquearía la salida que viene a cumplirla.
 *
 * Devuelve `false` si la reserva ya no estaba activa, para que el llamador no dependa de
 * un estado que otra transacción pudo cambiar (una liberación manual, por ejemplo).
 *
 * A partir de acá el material deja de estar protegido por el ledger, y pasa a estarlo por
 * el guardrail de D-060: el fleje está asignado a esa OP y ninguna otra operación lo puede
 * tocar mientras la orden viva. La promesa no queda desprotegida, cambia de custodio.
 */
export async function markReservationConsumed(
  tx: Prisma.TransactionClient,
  reservationId: string,
): Promise<boolean> {
  const updated = await tx.reservation.updateMany({
    where: { id: reservationId, status: ReservationStatus.ACTIVE },
    data: { status: ReservationStatus.CONSUMED, consumedAt: new Date() },
  });
  return updated.count === 1;
}

/**
 * Descuenta de una reserva lo que un **despacho** acaba de sacar (D-074, Fase 5b).
 *
 * La diferencia con `markReservationConsumed` es la razón de que exista: la orden de
 * producción se lleva el material **entero** y cambia de custodio (D-060), así que
 * consumir la reserva completa es exacto. Un despacho, en cambio, puede llevarse **una
 * parte** de la línea, y marcar toda la reserva consumida dejaría el resto —material que
 * el pedido sigue prometiendo— sin nada que lo proteja: cualquier merma, corte o venta se
 * lo llevaría. Es el mismo agujero que la auditoría de 5a encontró en el otro sentido.
 *
 * Por eso `reservations.qty` significa **lo que todavía está prometido**, no la promesa
 * original: esa vive en `sales_order_items.reserve_qty`, que no se toca nunca, así que
 * bajar esta cifra no pierde información. Cuando llega a cero, la reserva pasa a
 * `CONSUMIDA`.
 *
 * Se llama **antes** de escribir la salida de kardex, por el mismo motivo que
 * `markReservationConsumed`: si fuera al revés, la propia reserva bloquearía contra la
 * invariante de D-066 justo la salida que viene a cumplirla.
 *
 * Devuelve lo que efectivamente se descontó, que puede ser menos que `qty` si la reserva
 * ya estaba liberada a mano o parcialmente consumida.
 */
export async function consumeReservationQty(
  tx: Prisma.TransactionClient,
  reservationId: string,
  qty: Decimal,
): Promise<Decimal> {
  const reservation = await tx.reservation.findUnique({
    where: { id: reservationId },
    select: { id: true, status: true, qty: true },
  });
  if (!reservation) return new Decimal(0);
  if (reservation.status !== ReservationStatus.ACTIVE) return new Decimal(0);

  const outstanding = toDecimal(reservation.qty.toString());
  const consumed = Decimal.min(outstanding, qty);
  const remaining = outstanding.minus(consumed);

  await tx.reservation.updateMany({
    where: { id: reservationId, status: ReservationStatus.ACTIVE },
    data: remaining.lte(0)
      ? { qty: '0', status: ReservationStatus.CONSUMED, consumedAt: new Date() }
      : { qty: remaining.toFixed(3) },
  });
  return consumed;
}

/**
 * La mitad simétrica: devuelve a la reserva lo que la reversa de un despacho restituyó.
 *
 * Si la reserva había quedado `CONSUMIDA` por haberse despachado entera, vuelve a
 * `ACTIVA` —y el pedido, de "atendido" a lo que corresponda, que lo recalcula el
 * llamador—. Es la misma regla que `restoreReservation` aplica para la producción: toda
 * reversa aguas abajo restaura la promesa, o el material vuelve al almacén desprotegido
 * mientras el pedido lo sigue prometiendo.
 *
 * **No revalida la invariante**, y por el mismo motivo que `restoreReservation`: la misma
 * transacción que sube la reserva es la que devuelve el material al kardex, así que el
 * saldo sube y baja a la vez. Comprobarla acá solo podría hacer fallar una reversa
 * legítima.
 *
 * Devuelve `false` si la reserva ya no existe o si su pedido está anulado: ahí la promesa
 * dejó de existir y revivirla sería inventar un compromiso.
 */
export async function restoreReservationQty(
  tx: Prisma.TransactionClient,
  reservationId: string,
  qty: Decimal,
): Promise<boolean> {
  const reservation = await tx.reservation.findUnique({
    where: { id: reservationId },
    select: { id: true, status: true, qty: true, salesOrder: { select: { status: true } } },
  });
  if (!reservation) return false;
  if (reservation.status === ReservationStatus.RELEASED) return false;
  if (reservation.salesOrder.status === SalesOrderStatus.CANCELLED) return false;

  const restored = toDecimal(reservation.qty.toString()).plus(qty);
  await tx.reservation.update({
    where: { id: reservationId },
    data: { qty: restored.toFixed(3), status: ReservationStatus.ACTIVE, consumedAt: null },
  });
  return true;
}

/**
 * Devuelve una reserva `CONSUMIDA` a `ACTIVA` cuando la orden de producción que la consumió
 * deshace lo que hizo (revertir el último reporte vigente, o anularse).
 *
 * Sin esto, revertir la producción devolvía el material al almacén **sin ninguna reserva que
 * lo protegiera**: el pedido seguía vivo prometiéndolo y cualquier merma, corte o venta se
 * lo llevaba. Restaurar el estado anterior es exactamente lo que hacen el resto de reversas
 * del proyecto — `cutting.reverse` devuelve la fila a `SENT` y la madre a `IN_THIRD_PARTY`
 * (D-052), `revertSplit` devuelve los kilos a la madre— y "append-only" acá significa que la
 * fila nunca se borra, no que su estado sea de ida sola.
 *
 * **No revalida la invariante a propósito.** La misma transacción que restaura la reserva es
 * la que devuelve el material que esa reserva cubría, y mientras la OP lo tuvo montado el
 * guardrail de D-060 se lo bloqueó a todos los demás: no hay nadie que se haya podido llevar
 * ese saldo en el medio. Volver a comprobarla solo podría hacer fallar una reversa de
 * producción legítima, que es justo el residuo que Fase 3b costó una sesión entera resolver.
 *
 * Devuelve `false` si no había nada que restaurar (reserva liberada a mano, pedido anulado):
 * en esos casos la promesa ya no existe y revivirla sería inventar un compromiso.
 */
export async function restoreReservation(
  tx: Prisma.TransactionClient,
  reservationId: string,
): Promise<boolean> {
  const reservation = await tx.reservation.findUnique({
    where: { id: reservationId },
    select: {
      id: true,
      status: true,
      salesOrderId: true,
      salesOrder: { select: { status: true } },
    },
  });
  if (!reservation) return false;
  if (reservation.status !== ReservationStatus.CONSUMED) return false;
  if (reservation.salesOrder.status === SalesOrderStatus.CANCELLED) return false;

  const restored = await tx.reservation.updateMany({
    where: { id: reservationId, status: ReservationStatus.CONSUMED },
    data: { status: ReservationStatus.ACTIVE, consumedAt: null },
  });
  if (restored.count !== 1) return false;

  // El pedido vuelve a "confirmado": ya no hay producción en curso contra él.
  await tx.salesOrder.updateMany({
    where: { id: reservation.salesOrderId, status: SalesOrderStatus.IN_PRODUCTION },
    data: { status: SalesOrderStatus.CONFIRMED },
  });
  return true;
}

/** Bloquea las filas de esas bobinas (`FOR UPDATE`) y luego aplica `assertNotReserved`. */
export async function assertCoilsNotReserved(
  tx: Prisma.TransactionClient,
  coilIds: string[],
  action: string,
  exceptReservationIds: string[] = [],
): Promise<void> {
  if (coilIds.length === 0) return;
  const sorted = [...new Set(coilIds)].sort();
  // Mismo lock, mismo orden y mismo motivo que `assertStripsNotAssigned` (D-060): sin él
  // queda una ventana en la que el chequeo ve el ledger vacío, una confirmación de pedido
  // commitea, y la operación sigue adelante sobre material ya prometido.
  await tx.$queryRaw`
    SELECT "id" FROM "coils" WHERE "id" = ANY(${sorted}::uuid[]) ORDER BY "id" FOR UPDATE
  `;
  await assertNotReserved(
    tx,
    sorted.map((id) => ({ itemType: InventoryItemType.COIL, itemId: id })),
    action,
    exceptReservationIds,
  );
}
