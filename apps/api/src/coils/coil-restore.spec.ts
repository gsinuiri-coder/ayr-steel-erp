import { BadRequestException, ConflictException } from '@nestjs/common';
import { CoilStatus, Prisma } from '@prisma/client';
import { assertCoilOutNotBeforeEntry } from '../inventory/inventory.service';
import { assertStripsNotAssigned } from '../production/production-assignments';

jest.mock('../production/production-assignments', () => ({
  assertStripsNotAssigned: jest.fn().mockResolvedValue(undefined),
}));
import {
  classifyCoilRestore,
  restoreCoilInTx,
  undoCoilRestoreBatch,
  type RestoreContext,
  type RestoreMovement,
} from './coil-restore';

/**
 * D-375: el clasificador decide el modo (en su fecha / a hoy / bloqueada). Cada caso parte de
 * una bobina anulada sana (`base`) y cambia una sola cosa.
 */
const PURCHASE = 'purchase-1';
const D = (v: string) => new Prisma.Decimal(v);
const date = (d: string) => new Date(`${d}T00:00:00.000Z`);

function mov(
  partial: Partial<RestoreMovement> & Pick<RestoreMovement, 'id' | 'type'>,
): RestoreMovement {
  return {
    refType: 'PURCHASE',
    refId: PURCHASE,
    qty: D('4150'),
    unit: 'KGM',
    unitCost: D('2.6938'),
    operationDate: date('2026-08-14'),
    reversalOfId: null,
    ...partial,
  };
}

function base(): RestoreContext {
  return {
    coil: {
      id: 'coil-1',
      code: 'IMPO-AZUL-4150-23',
      status: CoilStatus.CANCELLED,
      purchaseId: PURCHASE,
    },
    movements: [
      mov({ id: 10n, type: 'IN' }),
      mov({ id: 11n, type: 'OUT', reversalOfId: 10n, operationDate: date('2026-09-28') }),
    ],
    activeReservations: 0,
    liveChildren: 0,
    today: '2026-10-01',
    historicalFloor: '2026-08-01',
  };
}

describe('classifyCoilRestore (D-375)', () => {
  it('una bobina anulada sin salidas vuelve en su fecha, con su cantidad y su costo', () => {
    const r = classifyCoilRestore(base());
    expect(r).toMatchObject({ mode: 'EN_SU_FECHA', date: '2026-08-14', reasons: [] });
    expect(r.entry?.id).toBe(10n);
  });

  it('con correcciones de costo previas, repite el último ingreso revertido (el que deshizo la anulación)', () => {
    const ctx = base();
    ctx.movements = [
      mov({ id: 1n, type: 'IN', unitCost: D('2.87') }),
      mov({ id: 2n, type: 'OUT', reversalOfId: 1n, unitCost: D('2.87') }),
      mov({ id: 3n, type: 'IN', unitCost: D('2.6938') }),
      mov({ id: 4n, type: 'OUT', reversalOfId: 3n, operationDate: date('2026-09-28') }),
    ];
    const r = classifyCoilRestore(ctx);
    expect(r.mode).toBe('EN_SU_FECHA');
    expect(r.entry?.id).toBe(3n);
    expect(r.entry?.unitCost.toString()).toBe('2.6938');
  });

  it('una venta revertida no bloquea (decisión del dueño) y, con el mismo costo, sigue en su fecha', () => {
    const ctx = base();
    ctx.movements = [
      mov({ id: 1n, type: 'IN', unitCost: D('3.43'), operationDate: date('2026-08-01') }),
      mov({
        id: 2n,
        type: 'OUT',
        refType: 'SALE',
        refId: 'des-1',
        unitCost: D('3.43'),
        operationDate: date('2026-08-01'),
      }),
      mov({
        id: 3n,
        type: 'IN',
        refType: 'SALE',
        refId: 'des-1',
        reversalOfId: 2n,
        unitCost: D('3.43'),
        operationDate: date('2026-09-28'),
      }),
      mov({
        id: 4n,
        type: 'OUT',
        reversalOfId: 1n,
        unitCost: D('3.43'),
        operationDate: date('2026-09-28'),
      }),
    ];
    expect(classifyCoilRestore(ctx)).toMatchObject({ mode: 'EN_SU_FECHA', date: '2026-08-01' });
  });

  it('a hoy si una salida existente desde esa fecha tiene otro costo (recostearía)', () => {
    const ctx = base();
    ctx.movements = [
      ...ctx.movements,
      mov({
        id: 12n,
        type: 'OUT',
        refType: 'SALE',
        refId: 'des-1',
        unitCost: D('3.00'),
        operationDate: date('2026-08-20'),
      }),
      mov({
        id: 13n,
        type: 'IN',
        refType: 'SALE',
        refId: 'des-1',
        reversalOfId: 12n,
        unitCost: D('3.00'),
        operationDate: date('2026-09-20'),
      }),
    ];
    const r = classifyCoilRestore(ctx);
    expect(r).toMatchObject({ mode: 'A_HOY', date: '2026-10-01' });
    expect(r.reasons[0]).toMatch(/recostearía/);
  });

  it('a hoy si la fecha original es anterior al piso de la carga histórica', () => {
    const ctx = base();
    ctx.movements = [
      mov({ id: 10n, type: 'IN', operationDate: date('2026-07-13') }),
      mov({ id: 11n, type: 'OUT', reversalOfId: 10n, operationDate: date('2026-09-21') }),
    ];
    const r = classifyCoilRestore(ctx);
    expect(r).toMatchObject({ mode: 'A_HOY', date: '2026-10-01' });
    expect(r.reasons[0]).toMatch(/piso de la carga histórica/);
  });

  it.each<[string, (ctx: RestoreContext) => void, RegExp]>([
    [
      'no anulada (ya restaurada)',
      (c) => {
        c.coil.status = CoilStatus.OPEN;
      },
      /no está anulada/,
    ],
    [
      'sin compra',
      (c) => {
        c.coil.purchaseId = null;
      },
      /no vino de una compra/,
    ],
    [
      'sin ingreso de compra revertido',
      (c) => {
        c.movements = [mov({ id: 10n, type: 'IN', refType: 'IMPORT', refId: null })];
      },
      /ingreso de compra revertido/,
    ],
    [
      'con una salida propia viva',
      (c) => {
        c.movements = [
          ...c.movements,
          mov({
            id: 12n,
            type: 'OUT',
            refType: 'PRODUCTION',
            refId: 'op-1',
            qty: D('100'),
            operationDate: date('2026-08-20'),
          }),
        ];
      },
      /salida\(s\) propia\(s\) vivas \(PRODUCTION\)/,
    ],
    [
      'con reservas activas',
      (c) => {
        c.activeReservations = 1;
      },
      /reservas activas/,
    ],
    [
      'con flejes hijos vigentes',
      (c) => {
        c.liveChildren = 1;
      },
      /flejes hijos/,
    ],
    [
      'con un ingreso vivo',
      (c) => {
        c.movements = [
          ...c.movements,
          mov({ id: 12n, type: 'IN', refType: 'ADJUSTMENT', refId: null }),
        ];
      },
      /ingreso vivo/,
    ],
  ])('bloquea: %s', (_label, change, message) => {
    const ctx = base();
    change(ctx);
    const r = classifyCoilRestore(ctx);
    expect(r.mode).toBe('BLOQUEADA');
    expect(r.date).toBeNull();
    expect(r.reasons.join(' ')).toMatch(message);
  });
});

describe('restoreCoilInTx (D-375)', () => {
  function fakeTx(ctx: RestoreContext) {
    return {
      $queryRaw: jest.fn().mockResolvedValue([{ id: ctx.coil.id }]),
      coil: {
        findUnique: jest.fn().mockResolvedValue({
          ...ctx.coil,
          businessLineId: 'line-1',
          parentCoilId: null,
          splitId: null,
          operationDate: date('2026-08-14'),
          purchase: { series: '118', number: '315630', status: 'RECEIVED' },
        }),
        count: jest.fn().mockResolvedValue(ctx.liveChildren),
        update: jest.fn().mockResolvedValue({}),
      },
      inventoryMovement: { findMany: jest.fn().mockResolvedValue(ctx.movements) },
      reservation: { count: jest.fn().mockResolvedValue(ctx.activeReservations) },
    } as unknown as Prisma.TransactionClient & {
      coil: { update: jest.Mock };
    };
  }
  const ARGS = {
    actorId: 'admin-1',
    coilId: 'coil-1',
    reason: 'mal anulada',
    batchId: 'batch-1',
    historicalFloor: '2026-08-01',
  };

  it('registra la entrada por InventoryService.record en su fecha y deja la bobina vigente, con auditoría', async () => {
    const tx = fakeTx(base());
    const inventory = { record: jest.fn().mockResolvedValue({ id: 99n }) };
    const audit = { write: jest.fn().mockResolvedValue(undefined) };
    const r = await restoreCoilInTx(tx, inventory as never, audit as never, ARGS);

    expect(inventory.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        itemType: 'COIL',
        itemId: 'coil-1',
        type: 'IN',
        qty: '4150',
        unitCost: '2.6938',
        unit: 'KGM',
        refType: 'PURCHASE',
        refId: PURCHASE,
        operationDate: '2026-08-14',
      }),
    );
    expect(tx.coil.update).toHaveBeenCalledWith({
      where: { id: 'coil-1' },
      data: { status: 'OPEN' },
    });
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'coils.restore',
        reason: 'mal anulada',
        after: expect.objectContaining({
          mode: 'EN_SU_FECHA',
          date: '2026-08-14',
          batchId: 'batch-1',
          movementId: '99',
        }) as unknown,
      }),
    );
    expect(r.mode).toBe('EN_SU_FECHA');
  });

  it('una bobina bloqueada no escribe nada', async () => {
    const ctx = base();
    ctx.activeReservations = 1;
    const tx = fakeTx(ctx);
    const inventory = { record: jest.fn() };
    const audit = { write: jest.fn() };
    await expect(
      restoreCoilInTx(tx, inventory as never, audit as never, ARGS),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(inventory.record).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('restaurar dos veces se rechaza con 409', async () => {
    const ctx = base();
    ctx.coil.status = CoilStatus.OPEN;
    const tx = fakeTx(ctx);
    const inventory = { record: jest.fn() };
    await expect(
      restoreCoilInTx(tx, inventory as never, { write: jest.fn() } as never, ARGS),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(inventory.record).not.toHaveBeenCalled();
  });
});

describe('assertCoilOutNotBeforeEntry (D-375)', () => {
  const tx = (first: string | null) =>
    ({
      inventoryMovement: {
        findFirst: jest.fn().mockResolvedValue(first ? { operationDate: date(first) } : null),
      },
    }) as unknown as Prisma.TransactionClient;

  it('rechaza una salida anterior al primer ingreso vivo, con la fecha en el mensaje', async () => {
    await expect(
      assertCoilOutNotBeforeEntry(tx('2026-10-01'), 'coil-1', '2026-09-25'),
    ).rejects.toThrow('La producción con esta bobina no puede tener fecha anterior a 2026-10-01');
  });

  it('acepta una salida en o después del ingreso, o una bobina sin ingreso vivo', async () => {
    await expect(
      assertCoilOutNotBeforeEntry(tx('2026-10-01'), 'coil-1', '2026-10-01'),
    ).resolves.toBeUndefined();
    await expect(
      assertCoilOutNotBeforeEntry(tx(null), 'coil-1', '2026-01-01'),
    ).resolves.toBeUndefined();
  });
});

describe('undoCoilRestoreBatch (D-375)', () => {
  const LOG = {
    entityId: 'coil-1',
    before: { operationDate: '2026-08-14' },
    after: { movementId: '99', batchId: 'batch-1', date: '2026-08-14' },
  };
  function fakeTx(later: number, undone = 0) {
    return {
      auditLog: {
        findMany: jest.fn().mockResolvedValue([LOG]),
        count: jest.fn().mockResolvedValue(undone),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'coil-1' }]),
      inventoryMovement: { count: jest.fn().mockResolvedValue(later) },
      coil: {
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ status: 'OPEN', code: 'IMPO-AZUL-4150-23' }),
      },
      reservation: { count: jest.fn().mockResolvedValue(0) },
    } as unknown as Prisma.TransactionClient & { coil: { update: jest.Mock } };
  }

  it('revierte la entrada en su misma fecha y deja la bobina anulada con su fecha de antes', async () => {
    const tx = fakeTx(0);
    const inventory = { reverse: jest.fn().mockResolvedValue({}) };
    const audit = { write: jest.fn().mockResolvedValue(undefined) };
    const ids = await undoCoilRestoreBatch(
      tx,
      inventory as never,
      audit as never,
      'admin-1',
      'batch-1',
      'deshacer',
    );
    expect(ids).toEqual(['coil-1']);
    expect(inventory.reverse).toHaveBeenCalledWith(
      tx,
      99n,
      'admin-1',
      expect.stringContaining('batch-1'),
      '2026-08-14',
      true,
    );
    expect(tx.coil.update).toHaveBeenCalledWith({
      where: { id: 'coil-1' },
      data: { status: 'CANCELLED', operationDate: new Date('2026-08-14T00:00:00.000Z') },
    });
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'coils.restore.undo' }),
    );
  });

  it('no escribe nada si la bobina tuvo movimientos después de restaurarse', async () => {
    const tx = fakeTx(1);
    const inventory = { reverse: jest.fn() };
    await expect(
      undoCoilRestoreBatch(
        tx,
        inventory as never,
        { write: jest.fn() } as never,
        'admin-1',
        'batch-1',
        'deshacer',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(inventory.reverse).not.toHaveBeenCalled();
  });

  it('un lote ya deshecho no se deshace dos veces', async () => {
    const tx = fakeTx(0, 1);
    await expect(
      undoCoilRestoreBatch(
        tx,
        { reverse: jest.fn() } as never,
        { write: jest.fn() } as never,
        'admin-1',
        'batch-1',
        'x',
      ),
    ).rejects.toThrow(/ya se deshizo/);
  });
});

describe('undoCoilRestoreBatch — la bobina siguió en uso sin mover kardex (revisión cc08)', () => {
  const LOG = {
    entityId: 'coil-1',
    before: { operationDate: '2026-08-14' },
    after: { movementId: '99', batchId: 'batch-1', date: '2026-08-14' },
  };
  it('no deshace una bobina enviada a corte tercerizado', async () => {
    const tx = {
      auditLog: {
        findMany: jest.fn().mockResolvedValue([LOG]),
        count: jest.fn().mockResolvedValue(0),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'coil-1' }]),
      inventoryMovement: { count: jest.fn().mockResolvedValue(0) },
      coil: {
        update: jest.fn(),
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: 'IN_THIRD_PARTY', code: 'IMPO-AZUL-4150-23' }),
      },
      reservation: { count: jest.fn().mockResolvedValue(0) },
    } as unknown as Prisma.TransactionClient;
    const inventory = { reverse: jest.fn() };
    await expect(
      undoCoilRestoreBatch(
        tx,
        inventory as never,
        { write: jest.fn() } as never,
        'admin-1',
        'batch-1',
        'x',
      ),
    ).rejects.toThrow(/ya no está vigente \(IN_THIRD_PARTY\)/);
    expect(inventory.reverse).not.toHaveBeenCalled();
  });

  it('consulta los flejes montados en una OP antes de escribir', () => {
    expect(jest.isMockFunction(assertStripsNotAssigned)).toBe(true);
  });
});

describe('classifyCoilRestore — flejes e hijas (revisión cc08)', () => {
  it('una hija de partido o corte no se restaura por acá', () => {
    const ctx = base();
    ctx.coil.isChild = true;
    expect(classifyCoilRestore(ctx)).toMatchObject({ mode: 'BLOQUEADA' });
  });
});
