import { Prisma } from '@prisma/client';
import { planRecost } from './inventory-recost';

/**
 * cc57 (A-01 de audit-01) — la cascada del recosteo no reparte a un ingreso **ya anulado**. Una
 * hija de partido corregida por D-045 deja tres filas bajo el ref del partido (el ingreso viejo, su
 * reversa y el reingreso); el cambio de la madre va entero a las hijas vivas. Base falsa; lo mismo
 * contra una base real en `recost.db-spec.ts`.
 */
const D = (v: string) => new Prisma.Decimal(v);
const at = (day: string) => new Date(`2026-08-${day}T00:00:00.000Z`);
const row = (over: Record<string, unknown>) => ({
  businessLineId: 'bl',
  itemType: 'PRODUCT',
  unit: 'NIU',
  refType: 'PURCHASE',
  refId: null,
  reversalOfId: null,
  recostOfId: null,
  ...over,
});

const mother = [
  row({
    id: 1n,
    itemId: 'm',
    type: 'IN',
    qty: D('100'),
    totalCost: D('100'),
    operationDate: at('01'),
  }),
  // Compra atrasada: a la fecha del partido el promedio pasa de 1 a 2.
  row({
    id: 2n,
    itemId: 'm',
    type: 'IN',
    qty: D('100'),
    totalCost: D('300'),
    operationDate: at('05'),
  }),
  row({
    id: 3n,
    itemId: 'm',
    type: 'OUT',
    qty: D('100'),
    totalCost: D('100'),
    refType: 'SPLIT',
    refId: 's1',
    operationDate: at('10'),
  }),
];
const split = (over: Record<string, unknown>) =>
  row({
    refType: 'SPLIT',
    refId: 's1',
    qty: D('50'),
    totalCost: D('50'),
    operationDate: at('10'),
    ...over,
  });
const child1 = [
  split({ id: 10n, itemId: 'c1', type: 'IN' }),
  split({ id: 11n, itemId: 'c1', type: 'OUT', reversalOfId: 10n }),
  split({ id: 12n, itemId: 'c1', type: 'IN' }),
];
const child2 = [split({ id: 13n, itemId: 'c2', type: 'IN' })];

function fakeTx() {
  const byItem: Record<string, unknown[]> = { m: mother, c1: child1, c2: child2 };
  return {
    inventoryMovement: {
      findMany: jest.fn(({ where }: { where: { itemId?: string; OR?: unknown } }) =>
        Promise.resolve(
          where.itemId !== undefined
            ? (byItem[where.itemId] ?? [])
            : // La consulta de la cascada: todo lo que lleva el ref del partido.
              where.OR !== undefined
              ? [mother[2], ...child1, ...child2]
              : [],
        ),
      ),
    },
    salesReturnItem: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

describe('planRecost: la cascada no reparte a un ingreso anulado (cc57, A-01)', () => {
  it('el cambio de la madre va entero a las dos hijas vivas, nada al ingreso anulado', async () => {
    const plan = await planRecost(fakeTx() as never, [
      { itemType: 'PRODUCT', itemId: 'm', fromStart: true },
    ]);
    const adjusts = plan.items.flatMap((i) => i.adjusts);
    const byMovement = new Map(adjusts.map((a) => [a.movement.id, a.delta.toFixed(4)]));
    // La salida de la madre: de 100 a 200 (se resta del saldo: −100).
    expect(byMovement.get(3n)).toBe('100.0000');
    expect(byMovement.get(12n)).toBe('50.0000');
    expect(byMovement.get(13n)).toBe('50.0000');
    expect(byMovement.has(10n)).toBe(false);
  });
});
