import { Prisma } from '@prisma/client';
import { Decimal } from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { reservedByItem } from '../sales/reserved-ledger';
import { OPENING_MOVE_ACTION } from './opening-date-move';
import {
  ADDED_OUT_REASON,
  OpeningDateMoveService,
  openingPlanSignature,
} from './opening-date-move.service';

jest.mock('../sales/reserved-ledger', () => ({ reservedByItem: jest.fn() }));

beforeEach(() => {
  jest.mocked(reservedByItem).mockResolvedValue(new Map([['upvc', new Decimal(12)]]));
});

/**
 * D-285 a nivel servicio: con una `tx` falsa, el plan simula la carga inicial refechada, agrega
 * la salida que le falta al despacho de UPVC y pasa todo al plan de despacho; la ejecución se
 * niega si la excepción ya se aplicó o si el plan cambió, y escribe en el orden de los pasos.
 */

const D = (v: string): Prisma.Decimal => new Prisma.Decimal(v);
const day = (v: string): Date => new Date(`${v}T00:00:00.000Z`);
const ADMIN = { id: 'admin', role: 'ADMINISTRADOR' } as RequestUser;

function fakeTx(opts: { appliedAudit?: boolean; importDate?: string; locked?: boolean } = {}) {
  const updates: { id: bigint; date: string }[] = [];
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn((strings: TemplateStringsArray) =>
      Promise.resolve(
        strings.join('?').includes('pg_try_advisory_xact_lock')
          ? [{ locked: opts.locked ?? true }]
          : [{ set_config: 'on' }],
      ),
    ),
    auditLog: {
      findFirst: jest.fn().mockResolvedValue(opts.appliedAudit === true ? { id: 'a' } : null),
    },
    inventoryMovement: {
      findMany: jest.fn(({ where }: { where: { refType?: string } }) =>
        Promise.resolve(
          where.refType === 'IMPORT'
            ? [
                {
                  id: 7n,
                  itemType: 'PRODUCT',
                  itemId: 'upvc',
                  operationDate: day(opts.importDate ?? '2026-09-22'),
                },
              ]
            : [
                {
                  id: 7n,
                  itemType: 'PRODUCT',
                  itemId: 'upvc',
                  type: 'IN',
                  qty: D('970'),
                  refType: 'IMPORT',
                  operationDate: day(opts.importDate ?? '2026-09-22'),
                  at: new Date('2026-09-22T15:00:00Z'),
                },
              ],
        ),
      ),
      groupBy: jest.fn().mockResolvedValue([]),
      update: jest.fn(
        ({ where, data }: { where: { id: bigint }; data: { operationDate: Date } }) => {
          updates.push({ id: where.id, date: data.operationDate.toISOString().slice(0, 10) });
          return Promise.resolve({});
        },
      ),
    },
    dispatchItem: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'di-1',
          itemType: 'PRODUCT',
          itemId: 'upvc',
          reserveQty: D('50'),
          product: { sku: 'UPVC36MT', businessLine: { inventoryStrategy: 'WEIGHTED_AVERAGE' } },
          dispatch: { seq: 4, dispatchDate: day('2026-08-11'), salesOrder: { seq: 22 } },
        },
      ]),
    },
    inventoryBalance: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { itemType: 'PRODUCT', itemId: 'upvc', avgCost: D('43.2203'), qty: D('970') },
        ]),
    },
    product: { findMany: jest.fn().mockResolvedValue([{ id: 'upvc', sku: 'UPVC36MT' }]) },
    coil: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return { tx, updates };
}

function service(tx: ReturnType<typeof fakeTx>['tx']) {
  const prisma = {
    auditLog: tx.auditLog,
    $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
  };
  const dispatches = {
    addMissingMovementInTx: jest.fn().mockResolvedValue({ movementId: 1n, totalCost: '2161.0150' }),
  };
  const invoiceDispatch = {
    buildPlan: jest.fn().mockResolvedValue({
      invoices: [
        {
          invoiceId: 'F1',
          number: 'FFA1-1',
          salesOrderId: 'ped',
          issueDate: '2026-08-05',
          orderCode: 'PED-000002',
          sellerId: null,
          lines: [
            {
              orderItemId: 'l1',
              lineNumber: 1,
              sku: 'COB030ROJO',
              qty: D('226.8'),
              reserveQty: D('226.8'),
              itemKey: 'PRODUCT:cob',
              action: 'DISPATCH',
              operationDate: '2026-09-15',
              reason: null,
            },
          ],
        },
      ],
      items: new Map(),
    }),
    executeInTx: jest.fn().mockResolvedValue({}),
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const svc = new OpeningDateMoveService(
    prisma as never,
    dispatches as never,
    invoiceDispatch as never,
    audit as never,
    { historicalLoadStart: '2026-08-01' } as never,
  );
  return { svc, dispatches, invoiceDispatch, audit };
}

describe('OpeningDateMoveService (D-285)', () => {
  it('plan: mueve la carga inicial, agrega la salida al despacho y la pasa al plan de despacho', async () => {
    const { tx } = fakeTx();
    const { svc, invoiceDispatch } = service(tx);
    const plan = await svc.plan();
    expect(tx.$executeRaw).toHaveBeenCalled(); // READ ONLY
    expect(plan.target).toBe('2026-08-01');
    expect(plan.moves[0]).toMatchObject({ label: 'UPVC36MT', action: 'MOVE', movementIds: ['7'] });
    expect(plan.added[0]).toMatchObject({
      action: 'ADD',
      orderCode: 'PED-000022',
      dispatchCode: 'DES-000004',
      date: '2026-08-11',
    });
    expect(plan.added[0]!.costPen.toFixed(4)).toBe('2161.0150');
    const [, , sim] = invoiceDispatch.buildPlan.mock.calls[0]!;
    expect((sim as { movedOpening: Map<string, string> }).movedOpening.get('7')).toBe('2026-08-01');
    expect(
      (sim as { priorOuts: Map<string, unknown[]> }).priorOuts.get('PRODUCT:upvc'),
    ).toHaveLength(1);
  });

  it('execute: con la auditoría de la ejecución, la herramienta está deshabilitada (D-286)', async () => {
    const { tx, updates } = fakeTx({ appliedAudit: true });
    const { svc, dispatches, invoiceDispatch } = service(tx);
    await expect(svc.execute(ADMIN, 'x')).rejects.toThrow('quedó deshabilitada');
    expect(updates).toHaveLength(0);
    expect(dispatches.addMissingMovementInTx).not.toHaveBeenCalled();
    expect(invoiceDispatch.executeInTx).not.toHaveBeenCalled();
  });

  it('plan: con la auditoría de la ejecución, tampoco planifica (D-286)', async () => {
    const { tx } = fakeTx({ appliedAudit: true });
    const { svc, invoiceDispatch } = service(tx);
    await expect(svc.plan()).rejects.toThrow('quedó deshabilitada');
    expect(invoiceDispatch.buildPlan).not.toHaveBeenCalled();
  });

  it('execute: con otra corrida sosteniendo el advisory lock, no escribe (D-286)', async () => {
    const { tx, updates } = fakeTx({ locked: false });
    const { svc, dispatches } = service(tx);
    const expected = openingPlanSignature(await svc.plan());
    await expect(svc.execute(ADMIN, expected)).rejects.toThrow('ya está corriendo');
    expect(tx.auditLog.findFirst).toHaveBeenCalledTimes(1); // solo la del plan
    expect(updates).toHaveLength(0);
    expect(dispatches.addMissingMovementInTx).not.toHaveBeenCalled();
  });

  it('execute: si el plan cambió desde el dry-run, no escribe', async () => {
    const { tx, updates } = fakeTx();
    const { svc } = service(tx);
    await expect(svc.execute(ADMIN, 'otra huella')).rejects.toThrow('no coincide');
    expect(updates).toHaveLength(0);
  });

  it('execute: refecha con SET LOCAL y auditoría, agrega la salida y despacha, en ese orden', async () => {
    const { tx, updates } = fakeTx();
    const { svc, dispatches, invoiceDispatch, audit } = service(tx);
    const expected = openingPlanSignature(await svc.plan());
    await svc.execute(ADMIN, expected);

    expect(tx.$queryRaw).toHaveBeenCalled(); // set_config('ayr.opening_date_move', 'on', true)
    expect(updates).toEqual([{ id: 7n, date: '2026-08-01' }]);
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: OPENING_MOVE_ACTION,
        entity: 'inventory_movements',
        entityId: '7',
        before: { operationDate: '2026-09-22' },
      }),
    );
    expect(dispatches.addMissingMovementInTx).toHaveBeenCalledWith(
      tx,
      ADMIN,
      'di-1',
      ADDED_OUT_REASON,
    );
    expect(invoiceDispatch.executeInTx).toHaveBeenCalledWith(
      tx,
      ADMIN,
      'F1',
      expect.objectContaining({ number: 'FFA1-1' }),
    );
  });

  it('execute ya no se retoma: sin nada que mover pero con la auditoría, se niega (D-286)', async () => {
    const { tx, updates } = fakeTx({ appliedAudit: true, importDate: '2026-08-01' });
    const { svc, dispatches } = service(tx);
    await expect(svc.execute(ADMIN, 'x')).rejects.toThrow('quedó deshabilitada');
    expect(updates).toHaveLength(0);
    expect(dispatches.addMissingMovementInTx).not.toHaveBeenCalled();
  });
});
