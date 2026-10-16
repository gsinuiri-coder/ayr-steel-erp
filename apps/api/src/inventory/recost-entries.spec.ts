import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal } from '@ayr/shared';
import type { Env } from '../config/env';
import { InventoryService } from './inventory.service';
import * as recostPlan from './inventory-recost';

/**
 * cc55 (D-665) — `InventoryService.recostEntries`: fija el costo de entradas ya registradas (su
 * costo efectivo más lo agregado) y deja que `recostForward` (D-649) escriba los ajustes. Base
 * falsa; contra la base, `recost.db-spec.ts`.
 */
function build(
  rows: { id: bigint; totalCost: string }[],
  recosts: { recostOfId: bigint; total: string }[] = [],
) {
  const tx = {
    inventoryMovement: {
      findMany: jest.fn().mockResolvedValue(
        rows.map((r) => ({
          id: r.id,
          itemType: 'PRODUCT',
          itemId: 'p1',
          totalCost: new Prisma.Decimal(r.totalCost),
        })),
      ),
      groupBy: jest.fn().mockResolvedValue(
        recosts.map((g) => ({
          recostOfId: g.recostOfId,
          _sum: { totalCost: new Prisma.Decimal(g.total) },
        })),
      ),
    },
  };
  const service = new InventoryService(
    {} as never,
    { ROOFING_THICKNESS_TOLERANCE_MM: '0.02' } as Env,
    { write: jest.fn() } as never,
  );
  const forward = jest
    .spyOn(service, 'recostForward')
    .mockResolvedValue({ pending: false, rowsReplayed: 0, adjusted: [] });
  return { service, tx, forward };
}

describe('InventoryService.recostEntries (cc55, D-665)', () => {
  it('fija cada entrada en su costo efectivo más lo agregado y siembra desde esa fila', async () => {
    const { service, tx, forward } = build(
      [
        { id: 1n, totalCost: '100' },
        { id: 2n, totalCost: '200' },
      ],
      // La entrada 2 ya tenía un recosteo de +5: su costo efectivo es 205.
      [{ recostOfId: 2n, total: '5' }],
    );
    await service.recostEntries(
      tx as never,
      [
        { movementId: 1n, addPen: new Decimal('10') },
        { movementId: 2n, addPen: new Decimal('20') },
      ],
      { actorId: 'u1', note: 'Cierre de OP-000001' },
    );
    const [, seeds, ctx] = forward.mock.calls[0] as unknown as [
      unknown,
      { atMovementId: bigint }[],
      { actorId: string; note: string; overrides: Map<string, Decimal> },
    ];
    expect(seeds.map((s) => s.atMovementId)).toEqual([1n, 2n]);
    expect(ctx.note).toBe('Cierre de OP-000001');
    expect([...ctx.overrides].map(([k, v]) => [k, v.toFixed(4)])).toEqual([
      ['1', '110.0000'],
      ['2', '225.0000'],
    ]);
  });

  it('sin nada que agregar no recostea', async () => {
    const { service, tx, forward } = build([]);
    await expect(
      service.recostEntries(tx as never, [{ movementId: 1n, addPen: new Decimal(0) }], {
        actorId: 'u1',
        note: 'x',
      }),
    ).resolves.toBeNull();
    expect(forward).not.toHaveBeenCalled();
  });

  it('una fila que no es entrada se rechaza antes de escribir', async () => {
    const { service, tx, forward } = build([]);
    await expect(
      service.recostEntries(tx as never, [{ movementId: 9n, addPen: new Decimal(5) }], {
        actorId: 'u1',
        note: 'x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(forward).not.toHaveBeenCalled();
  });
});

describe('recostForward con costos fijados (cc55, D-665)', () => {
  it('pasa los costos fijados al plan, también en la vuelta bajo lock', async () => {
    const service = new InventoryService(
      {} as never,
      { ROOFING_THICKNESS_TOLERANCE_MM: '0.02' } as Env,
      { write: jest.fn() } as never,
    );
    const plan = jest
      .spyOn(recostPlan, 'planRecost')
      .mockResolvedValue({ items: [], rowsReplayed: 2, overLimit: false });
    const overrides = new Map([['1', new Decimal('130')]]);
    const outcome = await service.recostForward(
      {} as never,
      [{ itemType: 'PRODUCT', itemId: 'p1', atMovementId: 1n }],
      { actorId: 'u1', overrides, note: 'Cierre de prueba' },
    );
    expect(outcome).toEqual({ pending: false, rowsReplayed: 2, adjusted: [] });
    expect(plan).toHaveBeenCalledTimes(2);
    for (const call of plan.mock.calls) expect(call[3]).toBe(overrides);
    plan.mockRestore();
  });
});
