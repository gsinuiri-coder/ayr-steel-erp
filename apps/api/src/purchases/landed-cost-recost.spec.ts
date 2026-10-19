import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { landedCostEntries, landedCostNote, landedCostShares } from './landed-cost-recost';

/** cc58 (D-686): las piezas del flete por recosteo de entradas, sin base. */
const D = (v: string) => new Prisma.Decimal(v);

describe('landedCostNote', () => {
  it('nombra el servicio y su documento, igual al recibir y al anular', () => {
    expect(landedCostNote({ serviceKind: 'FREIGHT', series: 'F002', number: '123' })).toBe(
      'Flete F002-123 (D-686)',
    );
    expect(landedCostNote({ serviceKind: null, series: 'F002', number: '9' })).toBe(
      'Servicio F002-9 (D-686)',
    );
  });
});

describe('landedCostEntries', () => {
  it('lee solo las entradas vivas de la compra de bobinas y descarta las de cero kilos', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 1n, itemId: 'c-1', qty: D('600') },
      { id: 2n, itemId: 'c-2', qty: D('0') },
    ]);
    const out = await landedCostEntries({ inventoryMovement: { findMany } } as never, 'p-1', [
      { id: 'c-1' },
      { id: 'c-2' },
    ]);
    expect(out.map((e) => [e.id, e.itemId, e.qty.toString()])).toEqual([[1n, 'c-1', '600']]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: 'IN',
          refType: 'PURCHASE',
          refId: 'p-1',
          recostOfId: null,
          reversalOfId: null,
          reversals: { none: {} },
        }),
      }),
    );
  });

  it('sin bobinas no consulta', async () => {
    const findMany = jest.fn();
    expect(await landedCostEntries({ inventoryMovement: { findMany } } as never, 'p', [])).toEqual(
      [],
    );
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('landedCostShares', () => {
  const entry = (id: bigint, over: Record<string, unknown> = {}) => ({
    id,
    itemId: `c-${String(id)}`,
    qty: D('1000'),
    reversalOfId: null,
    reversals: [],
    ...over,
  });
  const tx = (rows: unknown[], code = 'BOB-1') =>
    ({
      inventoryMovement: { findMany: jest.fn().mockResolvedValue(rows) },
      coil: { findUnique: jest.fn().mockResolvedValue({ code }) },
    }) as never;

  it('suma por entrada lo que el servicio le sumó y descarta lo que quedó en cero', async () => {
    const shares = await landedCostShares(
      tx([
        { totalCost: D('60'), recostOf: entry(1n) },
        { totalCost: D('40'), recostOf: entry(2n) },
        { totalCost: D('5'), recostOf: entry(1n) },
        { totalCost: D('0'), recostOf: entry(3n) },
        { totalCost: D('1'), recostOf: null },
      ]),
      'p-1',
      'Flete F002-1 (D-686)',
    );
    expect(shares.map((s) => [s.movementId, s.amountPen.toString()])).toEqual([
      [1n, '65'],
      [2n, '40'],
    ]);
  });

  it('una entrada reemplazada o anulada después del flete no se resta a ciegas', async () => {
    await expect(
      landedCostShares(
        tx([{ totalCost: D('60'), recostOf: entry(1n, { reversals: [{ id: 9n }] }) }]),
        'p-1',
        'n',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      landedCostShares(
        tx([{ totalCost: D('60'), recostOf: entry(1n, { reversalOfId: 5n }) }], 'BOB-7'),
        'p-1',
        'n',
      ),
    ).rejects.toThrow('BOB-7');
  });
});
