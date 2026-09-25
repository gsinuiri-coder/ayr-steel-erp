import { InventoryItemType, ReservationStatus } from '@prisma/client';
import { reservationDispatches, type ReservationRef } from './reservation-dispatches';

/**
 * D-311 — el despacho que consumió una reserva se deriva al leer (terna línea/tipo/ítem), sin
 * columna: solo cuentan las reservas consumidas, y de varias entregas gana la última vigente.
 */

const ref = (over: Partial<ReservationRef> = {}): ReservationRef => ({
  id: 'r-1',
  status: ReservationStatus.CONSUMED,
  salesOrderItemId: 'item-1',
  itemType: InventoryItemType.COIL,
  itemId: 'coil-1',
  ...over,
});

function prismaWith(lines: unknown[]) {
  const findMany = jest.fn().mockResolvedValue(lines);
  return { prisma: { dispatchItem: { findMany } } as never, findMany };
}

describe('reservationDispatches', () => {
  it('sin reservas consumidas no consulta nada', async () => {
    const { prisma, findMany } = prismaWith([]);
    const out = await reservationDispatches(prisma, [
      ref({ status: ReservationStatus.ACTIVE }),
      ref({ id: 'r-2', status: ReservationStatus.RELEASED }),
    ]);
    expect(out.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('una reserva consumida por una entrega nombra su despacho, solo entre los vigentes', async () => {
    const { prisma, findMany } = prismaWith([
      {
        salesOrderItemId: 'item-1',
        itemType: InventoryItemType.COIL,
        itemId: 'coil-1',
        dispatch: { id: 'd-7', seq: 7 },
      },
    ]);
    const out = await reservationDispatches(prisma, [ref()]);
    expect(out.get('r-1')).toEqual({ id: 'd-7', code: 'DES-000007' });
    // Uno revertido devolvió la reserva a activa: no cuenta.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ dispatch: { status: 'ISSUED' } }) as unknown,
      }),
    );
  });

  it('con varias entregas de la misma línea gana la última', async () => {
    const line = (seq: number) => ({
      salesOrderItemId: 'item-1',
      itemType: InventoryItemType.COIL,
      itemId: 'coil-1',
      dispatch: { id: `d-${String(seq)}`, seq },
    });
    const { prisma } = prismaWith([line(3), line(9)]);
    expect((await reservationDispatches(prisma, [ref()])).get('r-1')?.code).toBe('DES-000009');
  });

  it('una reserva consumida por una OP (otra terna) no tiene despacho', async () => {
    const { prisma } = prismaWith([
      {
        salesOrderItemId: 'item-1',
        itemType: InventoryItemType.PRODUCT,
        itemId: 'prod-1',
        dispatch: { id: 'd-1', seq: 1 },
      },
    ]);
    const out = await reservationDispatches(prisma, [
      ref({ itemType: InventoryItemType.RAW_MATERIAL, itemId: 'spec-1' }),
    ]);
    expect(out.size).toBe(0);
  });
});
