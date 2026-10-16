import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal } from '@ayr/shared';
import {
  applyCloseAdjustment,
  assertNoCloseRecost,
  closeRecostNote,
  recostCloseIntoEntries,
} from './close-recost';

/**
 * cc55 (D-665, E-01 de audit-01) — el despunte de una OP cuyo producto ya salió va a las entradas
 * de sus partes (`recostEntries`), y la reapertura no deshace ese cierre. Base falsa; la cadena
 * completa contra la base está en `order-qty-change.db-spec.ts` y `recost.db-spec.ts`.
 */
const entry = (id: bigint, total: string, qty: string) => ({
  id,
  totalCost: new Prisma.Decimal(total),
  qty: new Prisma.Decimal(qty),
});

describe('recostCloseIntoEntries', () => {
  const input = {
    orderSeq: 12,
    reportIds: ['r1', 'r2'],
    productId: 'p1',
    amountPen: new Decimal('30'),
    actorId: 'u1',
  };

  it('reparte el ajuste entre las entradas vivas de los partes, en proporción a lo que valían', async () => {
    const tx = {
      inventoryMovement: {
        findMany: jest.fn().mockResolvedValue([entry(1n, '100', '10'), entry(2n, '200', '20')]),
      },
    };
    const inventory = { recostEntries: jest.fn().mockResolvedValue({ pending: false }) };
    await expect(recostCloseIntoEntries(tx as never, inventory, input)).resolves.toEqual({
      pending: false,
    });
    const [, entries, ctx] = inventory.recostEntries.mock.calls[0] as [
      unknown,
      { movementId: bigint; addPen: Decimal }[],
      { actorId: string; note: string },
    ];
    expect(entries.map((e) => [e.movementId, e.addPen.toFixed(4)])).toEqual([
      [1n, '10.0000'],
      [2n, '20.0000'],
    ]);
    expect(ctx).toEqual({ actorId: 'u1', note: closeRecostNote(12) });
    // Solo entradas del producto, de esos partes, sin reversa ni recosteos.
    expect(tx.inventoryMovement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          itemId: 'p1',
          type: 'IN',
          refType: 'PRODUCTION',
          refId: { in: ['r1', 'r2'] },
          reversalOfId: null,
          recostOfId: null,
        }),
      }),
    );
  });

  it('sin monto, sin partes o sin entradas no hace nada', async () => {
    const inventory = { recostEntries: jest.fn() };
    const empty = { inventoryMovement: { findMany: jest.fn().mockResolvedValue([]) } };
    await expect(
      recostCloseIntoEntries(empty as never, inventory, { ...input, amountPen: new Decimal(0) }),
    ).resolves.toBeNull();
    await expect(
      recostCloseIntoEntries(empty as never, inventory, { ...input, reportIds: [] }),
    ).resolves.toBeNull();
    await expect(recostCloseIntoEntries(empty as never, inventory, input)).resolves.toBeNull();
    expect(inventory.recostEntries).not.toHaveBeenCalled();
  });
});

describe('assertNoCloseRecost', () => {
  const tx = (found: boolean) => ({
    productionOrder: { findUniqueOrThrow: jest.fn().mockResolvedValue({ seq: 7 }) },
    inventoryMovement: { findFirst: jest.fn().mockResolvedValue(found ? { id: 9n } : null) },
  });

  it('si el cierre pasó el despunte a los despachos, la reapertura se rechaza', async () => {
    const t = tx(true);
    const err = await assertNoCloseRecost(t as never, 'op-7', 'Las planchas de esta orden').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toContain('ya se movieron');
    expect(t.inventoryMovement.findFirst).toHaveBeenCalledWith({
      where: { recostOfId: { not: null }, notes: closeRecostNote(7) },
      select: { id: true },
    });
  });

  it('sin ese recosteo, deja seguir', async () => {
    await expect(assertNoCloseRecost(tx(false) as never, 'op-7', 'x')).resolves.toBeUndefined();
  });
});

describe('applyCloseAdjustment', () => {
  const adjust = {
    businessLineId: 'bl',
    itemType: 'PRODUCT' as const,
    itemId: 'p1',
    unit: 'MTR',
    amountPen: '30.0000',
    refType: 'PRODUCTION' as const,
    refId: 'op-1',
    actorId: 'u1',
  };
  const tx = {
    inventoryMovement: { findMany: jest.fn().mockResolvedValue([entry(1n, '100', '10')]) },
  };

  it('con saldo, el ADJUST de siempre y nada más', async () => {
    const inventory = {
      adjustCost: jest.fn().mockResolvedValue({ id: 5n }),
      recostEntries: jest.fn(),
    };
    await expect(
      applyCloseAdjustment(tx as never, inventory as never, {
        adjust,
        orderSeq: 1,
        reportIds: ['r1'],
      }),
    ).resolves.toEqual({ movement: { id: 5n }, recostedEntries: false });
    expect(inventory.recostEntries).not.toHaveBeenCalled();
  });

  it('sin saldo, recostea las entradas de los partes', async () => {
    const inventory = {
      adjustCost: jest.fn().mockResolvedValue(null),
      recostEntries: jest.fn().mockResolvedValue({ pending: false }),
    };
    await expect(
      applyCloseAdjustment(tx as never, inventory as never, {
        adjust,
        orderSeq: 1,
        reportIds: ['r1'],
      }),
    ).resolves.toEqual({ movement: null, recostedEntries: true });
    expect(inventory.recostEntries).toHaveBeenCalledTimes(1);
  });

  it('sin monto no toca el kardex', async () => {
    const inventory = { adjustCost: jest.fn(), recostEntries: jest.fn() };
    await expect(
      applyCloseAdjustment(tx as never, inventory as never, {
        adjust: { ...adjust, amountPen: '0.0000' },
        orderSeq: 1,
        reportIds: ['r1'],
      }),
    ).resolves.toEqual({ movement: null, recostedEntries: false });
    expect(inventory.adjustCost).not.toHaveBeenCalled();
  });
});
