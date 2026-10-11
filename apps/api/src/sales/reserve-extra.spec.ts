import { InventoryItemType, Prisma, ReservationStatus } from '@prisma/client';
import { Decimal } from '@ayr/shared';
import { SalesOrdersService } from './sales-orders.service';

/**
 * cc45 (D-604): `reserveExtra` suma lo nuevo a la reserva de la línea por la misma puerta que
 * confirmar (`reserveLines`, acá de mentira) y revive una fila liberada o consumida desde cero.
 */

const D = (v: string) => new Prisma.Decimal(v);
type Write = (item: unknown, reserved: Decimal, shortfall: Decimal) => Promise<void>;

function serviceWith(
  existing: { qty: string; shortfallQty: string; status: ReservationStatus } | null,
  split: { reserved: string; shortfall: string },
) {
  const service = Object.create(SalesOrdersService.prototype) as SalesOrdersService;
  const internals = service as unknown as {
    reserveLines: (tx: unknown, items: unknown[], holder: string, write: Write) => Promise<number>;
  };
  internals.reserveLines = jest.fn(async (_tx, items, _holder, write) => {
    await write(items[0], new Decimal(split.reserved), new Decimal(split.shortfall));
    return 1;
  });
  const tx = {
    reservation: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          existing === null
            ? null
            : { ...existing, qty: D(existing.qty), shortfallQty: D(existing.shortfallQty) },
        ),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
  return { service, tx, internals };
}

const line = {
  id: 'i-1',
  lineNumber: 1,
  productId: 'p-1',
  reserveItemType: InventoryItemType.RAW_MATERIAL,
  reserveItemId: 'spec-1',
  reserveQty: '100.000',
  reserveUnit: 'KGM',
};
const actor = { id: 'u-1' } as never;

describe('cc45 — reserveExtra', () => {
  it('suma a una reserva activa lo reservado y el faltante', async () => {
    const { service, tx, internals } = serviceWith(
      { qty: '30', shortfallQty: '5', status: ReservationStatus.ACTIVE },
      { reserved: '10', shortfall: '2' },
    );
    const out = await service.reserveExtra(tx as never, actor, 'o-1', line, '12.000');
    expect(out.reserved.toFixed(3)).toBe('10.000');
    expect(internals.reserveLines).toHaveBeenCalledWith(
      tx,
      [expect.objectContaining({ reserveQty: '12.000' })],
      'el pedido',
      expect.any(Function),
      actor,
      undefined,
    );
    expect(tx.reservation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          qty: '40.000',
          shortfallQty: '7.000',
          status: ReservationStatus.ACTIVE,
        }),
      }),
    );
  });

  it('una consumida revive desde cero y conserva su faltante; una liberada, desde cero', async () => {
    let h = serviceWith(
      { qty: '25', shortfallQty: '3', status: ReservationStatus.CONSUMED },
      { reserved: '10', shortfall: '0' },
    );
    await h.service.reserveExtra(h.tx as never, actor, 'o-1', line, '10.000');
    expect(h.tx.reservation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ qty: '10.000', shortfallQty: '3.000' }),
      }),
    );

    h = serviceWith(
      { qty: '25', shortfallQty: '3', status: ReservationStatus.RELEASED },
      { reserved: '10', shortfall: '0' },
    );
    await h.service.reserveExtra(h.tx as never, actor, 'o-1', line, '10.000');
    expect(h.tx.reservation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ qty: '10.000', shortfallQty: '0.000' }),
      }),
    );
  });

  it('sin fila, la crea con lo reservado', async () => {
    const { service, tx } = serviceWith(null, { reserved: '8', shortfall: '0' });
    await service.reserveExtra(tx as never, actor, 'o-1', line, '8.000');
    expect(tx.reservation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ qty: '8.000' }) }),
    );
  });
});
