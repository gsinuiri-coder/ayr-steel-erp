import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import * as documentLocks from '../inventory/document-locks';
import { lockOrder } from './production-shared';

/**
 * cc30 (grupo C) — contrato de `lockOrder`: el pedido de la OP se lee sin bloquear y se toma antes
 * que la OP, en la misma pasada por la puerta de documentos; con `own`, la reserva de la OP va
 * detrás. Si la reserva cambió entre la lectura y la toma, la nueva se toma después.
 */
function fakeTx(rows: { reservationId: string | null; salesOrderId: string | null }[]) {
  let read = 0;
  const tx = {
    productionOrder: {
      findUniqueOrThrow: jest.fn(({ select }: { select: Record<string, unknown> }) => {
        const row = rows[Math.min(read, rows.length - 1)];
        read += 1;
        if (!row) {
          return Promise.reject(Object.assign(new Error('No encontrado'), { code: 'P2025' }));
        }
        return Promise.resolve(
          'reservation' in select
            ? {
                reservationId: row.reservationId,
                reservation: row.salesOrderId ? { salesOrderId: row.salesOrderId } : null,
              }
            : { id: 'op', reservationId: row.reservationId, status: 'IN_PROGRESS' },
        );
      }),
    },
  };
  return tx as unknown as Prisma.TransactionClient;
}

describe('cc30 — lockOrder toma pedido → OP → reserva', () => {
  let spy: jest.SpyInstance<
    ReturnType<typeof documentLocks.lockDocuments>,
    Parameters<typeof documentLocks.lockDocuments>
  >;
  beforeEach(() => {
    spy = jest.spyOn(documentLocks, 'lockDocuments').mockResolvedValue({
      quotations: [],
      salesOrders: [],
      productionOrders: [],
      quotationReservations: [],
      reservations: [],
    });
  });
  afterEach(() => {
    spy.mockRestore();
  });

  it('pedido y OP en la misma toma, y la reserva propia si se pide', async () => {
    await lockOrder(fakeTx([{ reservationId: 'r', salesOrderId: 's' }]), 'op', { own: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toEqual({
      salesOrders: ['s'],
      productionOrders: ['op'],
      reservations: ['r'],
    });
  });

  it('una OP a stock no tiene pedido que tomar', async () => {
    await lockOrder(fakeTx([{ reservationId: null, salesOrderId: null }]), 'op');
    expect(spy.mock.calls[0]?.[1]).toEqual({
      salesOrders: [undefined],
      productionOrders: ['op'],
      reservations: [],
    });
  });

  it('si la reserva cambió entre la lectura y la toma, la nueva se toma después', async () => {
    await lockOrder(
      fakeTx([
        { reservationId: 'r-vieja', salesOrderId: 's' },
        { reservationId: 'r-nueva', salesOrderId: 's' },
      ]),
      'op',
      { own: true },
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[1]).toEqual({ reservations: ['r-nueva'] });
  });

  it('una OP que no existe es un 404', async () => {
    await expect(lockOrder(fakeTx([]), 'op')).rejects.toBeInstanceOf(NotFoundException);
    expect(spy).not.toHaveBeenCalled();
  });
});
