import { Prisma } from '@prisma/client';
import {
  hasLandedRecost,
  landedCostEntries,
  landedCostKey,
  landedCostNote,
  landedCostShares,
} from './landed-cost-recost';

/** cc58 (D-686): las piezas del flete por recosteo de entradas, sin base. */
const D = (v: string) => new Prisma.Decimal(v);

describe('landedCostNote', () => {
  it('nombra el servicio y su documento, igual al recibir y al anular', () => {
    expect(
      landedCostNote({ id: 'p-1', serviceKind: 'FREIGHT', series: 'F002', number: '123' }),
    ).toBe('Flete F002-123 (D-686, compra p-1)');
    // Mismo número, otra compra (otro proveedor): otra nota (revisión P1-1).
    expect(landedCostNote({ id: 'p-2', serviceKind: null, series: 'F002', number: '123' })).toBe(
      'Servicio F002-123 (D-686, compra p-2)',
    );
  });
});

describe('hasLandedRecost', () => {
  it('mira el neto de los recosteos de la entrada con la marca del flete', async () => {
    const aggregate = jest
      .fn()
      .mockResolvedValueOnce({ _sum: { totalCost: D('60') } })
      // Alta y anulación: neto cero, ya no bloquea (P2-5 de la autorrevisión).
      .mockResolvedValueOnce({ _sum: { totalCost: D('0') } })
      .mockResolvedValueOnce({ _sum: { totalCost: null } });
    const tx = { inventoryMovement: { aggregate } } as never;
    expect(await hasLandedRecost(tx, 7n)).toBe(true);
    expect(await hasLandedRecost(tx, 8n)).toBe(false);
    expect(await hasLandedRecost(tx, 9n)).toBe(false);
    expect(aggregate).toHaveBeenCalledWith({
      where: { recostOfId: 7n, notes: { contains: '(D-686, compra ' } },
      _sum: { totalCost: true },
    });
  });

  it('la llave del servicio va también en la nota de su anulación', () => {
    expect(landedCostKey('p-1')).toBe('(D-686, compra p-1)');
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
    totalCost: D('1000'),
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

  it('una entrada reemplazada después del flete no se resta a ciegas', async () => {
    // «Editar compra recibida» la revirtió a su costo grabado (1000): el flete quedó en el saldo.
    const replaced = entry(1n, {
      totalCost: D('1000'),
      reversals: [{ id: 9n, totalCost: D('1000') }],
    });
    const t = tx([{ totalCost: D('60'), recostOf: replaced }], 'BOB-7');
    (t as { inventoryMovement: Record<string, unknown> }).inventoryMovement.aggregate = jest
      .fn()
      .mockResolvedValue({ _sum: { totalCost: D('60') } });
    await expect(landedCostShares(t, 'p-1', 'n')).rejects.toThrow('BOB-7');
  });

  it('una entrada anulada con su costo efectivo ya se llevó el flete: no se resta (P1-2)', async () => {
    const annulled = entry(1n, {
      totalCost: D('1000'),
      reversals: [{ id: 9n, totalCost: D('1060') }],
    });
    const t = tx([{ totalCost: D('60'), recostOf: annulled }]);
    (t as { inventoryMovement: Record<string, unknown> }).inventoryMovement.aggregate = jest
      .fn()
      .mockResolvedValue({ _sum: { totalCost: D('60') } });
    expect(await landedCostShares(t, 'p-1', 'n')).toEqual([]);
  });
});
