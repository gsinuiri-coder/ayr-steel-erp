import { BadRequestException } from '@nestjs/common';
import { InventoryItemType, Prisma, Role, type Prisma as PrismaTypes } from '@prisma/client';
import { Decimal } from '@ayr/shared';
import { assertReservationInvariant, findActiveReservations } from './reservation-guard';

/**
 * D-275 (criterio de D-267): el rechazo de la invariante `disponible ≥ reservado` nombra a los
 * titulares de la reserva. Un VENDEDOR llega a él despachando una línea cuya reserva liberó un
 * administrador; ahí no se le nombra la reserva temporal de la cotización de otro vendedor.
 */

const ITEM = { itemType: InventoryItemType.PRODUCT, itemId: 'producto-1' };

function fakeTx() {
  const dec = (v: string) => new Prisma.Decimal(v);
  const tx = {
    reservation: {
      findMany: jest.fn(() =>
        Promise.resolve([
          {
            id: 'firme-1',
            itemType: ITEM.itemType,
            itemId: ITEM.itemId,
            qty: dec('2'),
            unit: 'UND',
            salesOrder: { id: 'pedido-1', seq: 7 },
          },
        ]),
      ),
      groupBy: jest.fn(() => Promise.resolve([{ itemId: ITEM.itemId, _sum: { qty: dec('2') } }])),
    },
    quotationReservation: {
      findMany: jest.fn(() =>
        Promise.resolve([
          {
            id: 'temporal-a',
            itemType: ITEM.itemType,
            itemId: ITEM.itemId,
            qty: dec('5'),
            unit: 'UND',
            quotation: { id: 'cot-a', seq: 21, sellerId: 'vendedor-a' },
          },
          {
            id: 'temporal-b',
            itemType: ITEM.itemType,
            itemId: ITEM.itemId,
            qty: dec('3'),
            unit: 'UND',
            quotation: { id: 'cot-b', seq: 22, sellerId: 'vendedor-b' },
          },
          {
            id: 'temporal-sin-vendedor',
            itemType: ITEM.itemType,
            itemId: ITEM.itemId,
            qty: dec('1'),
            unit: 'UND',
            quotation: { id: 'cot-c', seq: 23, sellerId: null },
          },
        ]),
      ),
      groupBy: jest.fn(() => Promise.resolve([{ itemId: ITEM.itemId, _sum: { qty: dec('9') } }])),
    },
  };
  return tx as unknown as PrismaTypes.TransactionClient;
}

describe('reservation-guard — titulares por lector (D-275)', () => {
  it('a un VENDEDOR le nombra su cotización y no la de otro ni la sin vendedor', async () => {
    const holders = await findActiveReservations(fakeTx(), [ITEM], {
      id: 'vendedor-a',
      role: Role.VENDEDOR,
    });
    expect(holders.map((h) => h.orderCode)).toEqual([
      'PED-000007',
      'COT-000021 (reserva temporal)',
      'cotización no disponible (reserva temporal)',
      'cotización no disponible (reserva temporal)',
    ]);
  });

  it('otro rol, o sin lector, ve todos los códigos', async () => {
    const expected = [
      'PED-000007',
      'COT-000021 (reserva temporal)',
      'COT-000022 (reserva temporal)',
      'COT-000023 (reserva temporal)',
    ];
    const asAdmin = await findActiveReservations(fakeTx(), [ITEM], {
      id: 'admin',
      role: Role.ADMINISTRADOR,
    });
    expect(asAdmin.map((h) => h.orderCode)).toEqual(expected);
    const unnamed = await findActiveReservations(fakeTx(), [ITEM]);
    expect(unnamed.map((h) => h.orderCode)).toEqual(expected);
  });

  it('el rechazo de la invariante que ve un VENDEDOR no contiene el código ajeno', async () => {
    const attempt = assertReservationInvariant(fakeTx(), ITEM, new Decimal(4), new Decimal(10), {
      id: 'vendedor-b',
      role: Role.VENDEDOR,
    });
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    const message = await attempt.catch((e: unknown) => (e instanceof Error ? e.message : ''));
    expect(message).toContain('COT-000022 (reserva temporal)');
    expect(message).toContain('cotización no disponible (reserva temporal) (5.000 UND)');
    expect(message).not.toContain('COT-000021');
    expect(message).not.toContain('COT-000023');
  });
});
