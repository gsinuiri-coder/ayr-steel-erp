import { Prisma } from '@prisma/client';
import { Decimal } from '@ayr/shared';
import { planRecost } from './inventory-recost';

/**
 * cc55 (D-665) — el plan del recosteo con **costos fijados de antemano** (`initialOverrides`) y la
 * semilla en una fila (`atMovementId`): lo que `recostEntries` le pide al motor. Base falsa: el
 * kardex de un ítem (una entrada de un parte y la salida del despacho del mismo día).
 */
const row = (over: Record<string, unknown>) => ({
  businessLineId: 'bl',
  itemType: 'PRODUCT',
  itemId: 'p1',
  unit: 'MTR',
  refType: 'PRODUCTION',
  refId: 'r1',
  reversalOfId: null,
  recostOfId: null,
  operationDate: new Date('2026-10-05T00:00:00.000Z'),
  ...over,
});

function fakeTx() {
  const kardex = [
    row({
      id: 1n,
      type: 'IN',
      qty: new Prisma.Decimal('10'),
      totalCost: new Prisma.Decimal('100'),
    }),
    row({
      id: 2n,
      type: 'OUT',
      qty: new Prisma.Decimal('10'),
      totalCost: new Prisma.Decimal('100'),
      refType: 'SALE',
      refId: 'd1',
    }),
  ];
  return {
    inventoryMovement: { findMany: jest.fn().mockResolvedValue(kardex) },
    salesReturnItem: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

describe('planRecost con costos fijados (cc55, D-665)', () => {
  it('la entrada fijada arrastra a la salida del mismo día', async () => {
    const plan = await planRecost(
      fakeTx() as never,
      [{ itemType: 'PRODUCT', itemId: 'p1', atMovementId: 1n }],
      500,
      new Map([['1', new Decimal('130')]]),
    );
    expect(plan.overLimit).toBe(false);
    const adjusts = plan.items.flatMap((i) => i.adjusts);
    expect(adjusts.map((a) => [a.movement.id, a.delta.toFixed(4)])).toEqual([
      [1n, '30.0000'],
      [2n, '30.0000'],
    ]);
  });

  it('sin costos fijados, la misma semilla no cambia nada', async () => {
    const plan = await planRecost(
      fakeTx() as never,
      [{ itemType: 'PRODUCT', itemId: 'p1', atMovementId: 1n }],
      500,
    );
    expect(plan.items.flatMap((i) => i.adjusts)).toEqual([]);
  });

  it('una semilla en una fila que no está no reproduce nada', async () => {
    const plan = await planRecost(
      fakeTx() as never,
      [{ itemType: 'PRODUCT', itemId: 'p1', atMovementId: 99n }],
      500,
      new Map([['1', new Decimal('130')]]),
    );
    expect(plan.items.flatMap((i) => i.adjusts)).toEqual([]);
  });
});
