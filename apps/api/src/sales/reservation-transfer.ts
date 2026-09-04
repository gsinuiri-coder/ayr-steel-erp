import { BadRequestException } from '@nestjs/common';
import { InventoryItemType, ReservationStatus, type Prisma } from '@prisma/client';
import { Decimal, toDecimal } from '@ayr/shared';

/**
 * El traslado de la reserva del insumo al producto terminado (D-088).
 *
 * Vive junto a `reservation-guard.ts` y no dentro de él porque resuelve un problema
 * distinto: aquel **defiende** una promesa contra el resto del sistema, y este la **mueve**
 * de un ítem a otro cuando la producción convierte materia prima en producto.
 *
 * El caso es el de una cobertura (D-083). Al confirmar el pedido, la línea reserva kilos de
 * una bobina: el producto terminado todavía no existe, así que lo que hay que proteger es
 * la materia prima. Cuando la OP reporta largos, esos kilos salen de la bobina y entran
 * metros al producto — y la promesa tiene que viajar con ellos, o el material quedaría en
 * el almacén sin nada que lo proteja mientras el pedido lo sigue prometiendo al cliente.
 *
 * Son **dos filas** y no una mutada, y esa es la decisión de D-088: la reserva de bobina
 * describe un hecho que ocurrió y se cumplió, y la de producto describe uno nuevo. Con dos
 * filas, además, la producción parcial funciona sola —reportar 3 de 5 planchas deja viva la
 * promesa de bobina por lo que falta y abre la de producto por lo hecho— y las dos mitades
 * de la invariante `disponible ≥ reservado` son ciertas en cada paso intermedio.
 */

/**
 * Abre o aumenta la reserva de un pedido sobre un ítem. Idempotente por el índice único
 * `(línea, itemType, itemId)`: la segunda corrida de la misma OP suma a la fila que ya
 * existe en vez de abrir una nueva.
 *
 * **Revive una reserva `RELEASED`**, y no es un descuido: la que libera `reduceReservation`
 * al llegar a cero es exactamente esta, y volver a producir contra la misma línea tiene que
 * poder reabrirla. Una liberación **manual** (D-054) sobre esta fila tendría el mismo
 * efecto, pero esa la hace un administrador sobre la reserva de materia prima, no sobre los
 * metros ya fabricados, que es material que existe y que el pedido sigue prometiendo.
 *
 * **No revalida la invariante**, por el mismo motivo que `restoreReservation`: la misma
 * transacción que sube la reserva es la que mete el material al kardex.
 */
export async function upsertItemReservation(
  tx: Prisma.TransactionClient,
  input: {
    salesOrderId: string;
    salesOrderItemId: string;
    itemType: InventoryItemType;
    itemId: string;
    qty: Decimal;
    unit: string;
    actorId: string;
  },
): Promise<string> {
  const key = {
    salesOrderItemId_itemType_itemId: {
      salesOrderItemId: input.salesOrderItemId,
      itemType: input.itemType,
      itemId: input.itemId,
    },
  };
  const existing = await tx.reservation.findUnique({ where: key, select: { id: true, qty: true } });
  if (!existing) {
    const created = await tx.reservation.create({
      data: {
        salesOrderId: input.salesOrderId,
        salesOrderItemId: input.salesOrderItemId,
        itemType: input.itemType,
        itemId: input.itemId,
        qty: input.qty.toFixed(3),
        unit: input.unit,
        status: ReservationStatus.ACTIVE,
        createdById: input.actorId,
      },
      select: { id: true },
    });
    return created.id;
  }

  await tx.reservation.update({
    where: key,
    data: {
      qty: toDecimal(existing.qty.toString()).plus(input.qty).toFixed(3),
      status: ReservationStatus.ACTIVE,
      consumedAt: null,
      releasedAt: null,
      releasedById: null,
    },
  });
  return existing.id;
}

/**
 * Descuenta de una reserva lo que una **reversa de producción** devolvió al insumo: los
 * metros que dejaron de existir porque volvieron a ser kilos de bobina.
 *
 * Al llegar a cero la deja `RELEASED` y no `CONSUMED`, y la diferencia importa:
 * `CONSUMED` significa "la promesa se cumplió, el material salió al cliente", que es lo que
 * dice un despacho; acá la promesa **no** se cumplió, simplemente dejó de estar respaldada
 * por este ítem y volvió a estarlo por la bobina. Que sea `RELEASED` es además lo que evita
 * que la reserva de producto quede contando como una promesa viva sobre un saldo que ya no
 * existe.
 *
 * Devuelve lo que efectivamente se descontó.
 */
export async function reduceReservation(
  tx: Prisma.TransactionClient,
  reservationId: string,
  qty: Decimal,
  actorId: string,
): Promise<Decimal> {
  const reservation = await tx.reservation.findUnique({
    where: { id: reservationId },
    select: { id: true, status: true, qty: true },
  });
  if (!reservation) return new Decimal(0);
  if (reservation.status !== ReservationStatus.ACTIVE) return new Decimal(0);

  const outstanding = toDecimal(reservation.qty.toString());
  const reduced = Decimal.min(outstanding, qty);
  const remaining = outstanding.minus(reduced);

  await tx.reservation.updateMany({
    where: { id: reservationId, status: ReservationStatus.ACTIVE },
    data: remaining.lte(0)
      ? {
          qty: '0',
          status: ReservationStatus.RELEASED,
          releasedAt: new Date(),
          releasedById: actorId,
        }
      : { qty: remaining.toFixed(3) },
  });
  return reduced;
}

/** La reserva de una línea sobre un ítem concreto, exista o no. */
export async function findLineReservation(
  tx: Prisma.TransactionClient,
  salesOrderItemId: string,
  itemType: InventoryItemType,
  itemId: string,
): Promise<{ id: string; qty: Decimal; status: ReservationStatus; unit: string } | null> {
  const row = await tx.reservation.findUnique({
    where: { salesOrderItemId_itemType_itemId: { salesOrderItemId, itemType, itemId } },
    select: { id: true, qty: true, status: true, unit: true },
  });
  return row === null
    ? null
    : { id: row.id, qty: toDecimal(row.qty.toString()), status: row.status, unit: row.unit };
}

/**
 * **Qué respalda hoy a esta línea de pedido**, que es lo que el despacho necesita saber
 * para escribir su salida de kardex.
 *
 * No es lo mismo que `sales_order_items.reserve_*`: ese campo guarda lo que se prometió el
 * día que se confirmó el pedido y no se toca nunca (es el registro del compromiso), pero en
 * una cobertura el material que de verdad sale del almacén es el **producto terminado** que
 * la OP fabricó, no la bobina que se prometió. Despachar contra las coordenadas congeladas
 * habría sacado los kilos de la bobina por segunda vez — la primera la hizo el reporte de
 * producción— y el kardex habría descontado material que salió una sola vez.
 *
 * La regla es corta: si la línea tiene una reserva viva sobre **su propio producto**, esa
 * manda; si no, manda la congelada. Con eso, perfiles, trading y la venta directa de bobina
 * (RF-73, cuya reserva es sobre la bobina y ahí sí es correcta) siguen comportándose
 * exactamente igual que antes de Fase 6.
 */
export async function resolveDispatchTarget(
  tx: Prisma.TransactionClient,
  item: {
    id: string;
    lineNumber: number;
    productId: string;
    reserveItemType: InventoryItemType;
    reserveItemId: string;
    reserveUnit: string;
  },
): Promise<{
  itemType: InventoryItemType;
  itemId: string;
  unit: string;
  reservationId: string | null;
  /** `true` cuando el despacho sale del producto fabricado y no del insumo prometido. */
  fromProduction: boolean;
}> {
  // La línea ya está respaldada por el propio producto desde que se confirmó (perfiles,
  // trading, plancha de catálogo vendida de stock): no hay traslado que resolver.
  const backedByProduct =
    item.reserveItemType === InventoryItemType.PRODUCT && item.reserveItemId === item.productId;

  const onProduct = backedByProduct
    ? null
    : await findLineReservation(tx, item.id, InventoryItemType.PRODUCT, item.productId);

  if (onProduct !== null && onProduct.status === ReservationStatus.ACTIVE) {
    return {
      itemType: InventoryItemType.PRODUCT,
      itemId: item.productId,
      unit: onProduct.unit,
      reservationId: onProduct.id,
      fromProduction: true,
    };
  }

  // **Una línea que se fabrica contra el pedido no vuelve nunca al insumo.** Es el hueco que
  // la auditoría encontró en el segundo despacho: cuando el primero consume entera la reserva
  // de producto (queda `CONSUMIDA`), o cuando se despacha antes de producir, caer a las
  // coordenadas congeladas emitía una salida de **kilos de bobina** por una venta de planchas
  // — el mismo material saliendo dos veces del kardex, que es exactamente lo que D-088 vino a
  // cerrar.
  //
  // Lo que separa "se fabrica contra el pedido" de "se vende la bobina tal cual" (RF-73) **no**
  // son los subítems de largo: una plancha de catálogo fabricada contra pedido tiene línea
  // simple y también hay que producirla. Lo que los separa es la **receta**: un producto de
  // `trading` que vende una bobina no tiene, y uno de coberturas sí.
  if (!backedByProduct) {
    const madeToOrder =
      onProduct !== null ||
      (await tx.productBom.count({ where: { productId: item.productId, isActive: true } })) > 0;
    if (madeToOrder) {
      throw new BadRequestException(
        `La línea ${item.lineNumber} se fabrica contra el pedido y no tiene producto terminado reservado: produce lo que falta antes de despacharlo`,
      );
    }
  }

  const frozen = await findLineReservation(tx, item.id, item.reserveItemType, item.reserveItemId);
  return {
    itemType: item.reserveItemType,
    itemId: item.reserveItemId,
    unit: item.reserveUnit,
    reservationId: frozen?.id ?? null,
    fromProduction: false,
  };
}
