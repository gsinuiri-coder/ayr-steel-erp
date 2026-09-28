import { CoilStatus, Prisma } from '@prisma/client';
import {
  autoTerminateEmptyCoils,
  isAnomaly,
  planAutoTerminate,
  reopenAutoTerminatedCoils,
} from './coil-auto-terminate';

/**
 * D-360 — la bobina se termina sola en exactamente 0, con un `tx` simulado. Lo que se fija acá
 * es la regla (0 exacto, montada, reserva, negativo), que **nunca** se escribe kardex, y que la
 * reapertura solo toca lo que terminó esa misma operación y nunca falla.
 */

interface CoilSeed {
  id: string;
  code?: string;
  status?: CoilStatus;
  qty?: string | null;
  mountedIn?: number[];
  reservedKg?: string;
}

interface AuditSeed {
  entityId: string;
  action: 'coils.close' | 'coils.open';
  after: Record<string, unknown>;
}

function fakeTx(coils: CoilSeed[], audits: AuditSeed[] = []) {
  const byId = new Map(coils.map((c) => [c.id, c]));
  const inList = (where: { id?: { in: string[] }; itemId?: { in: string[] } }) =>
    where.id?.in ?? where.itemId?.in ?? [];
  const tx = {
    coil: {
      findMany: jest.fn((args: { where: { id: { in: string[] }; status?: CoilStatus } }) =>
        Promise.resolve(
          args.where.id.in
            .map((id) => byId.get(id))
            .filter((c): c is CoilSeed => c !== undefined)
            .filter(
              (c) =>
                args.where.status === undefined ||
                (c.status ?? CoilStatus.OPEN) === args.where.status,
            )
            .map((c) => ({
              id: c.id,
              code: c.code ?? c.id.toUpperCase(),
              status: c.status ?? CoilStatus.OPEN,
            }))
            // El helper pide `orderBy: code asc`.
            .sort((a, b) => (a.code < b.code ? -1 : 1)),
        ),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    inventoryBalance: {
      findMany: jest.fn((args: { where: { itemId: { in: string[] } } }) =>
        Promise.resolve(
          inList(args.where)
            .map((id) => byId.get(id))
            .filter((c): c is CoilSeed => c !== undefined && c.qty !== null)
            .map((c) => ({ itemId: c.id, qty: new Prisma.Decimal(c.qty ?? '0') })),
        ),
      ),
    },
    productionOrderConsumption: {
      findMany: jest.fn((args: { where: { coilId: { in: string[] } } }) =>
        Promise.resolve(
          args.where.coilId.in.flatMap((id) =>
            (byId.get(id)?.mountedIn ?? []).map((seq) => ({
              coilId: id,
              assignedKg: new Prisma.Decimal('100'),
              consumedKg: new Prisma.Decimal('100'),
              coil: { code: id.toUpperCase() },
              productionOrder: { id: `o${String(seq)}`, seq, reservationId: null },
            })),
          ),
        ),
      ),
    },
    reservation: {
      groupBy: jest.fn((args: { where: { itemId: { in: string[] } } }) =>
        Promise.resolve(
          args.where.itemId.in
            .filter((id) => byId.get(id)?.reservedKg !== undefined)
            .map((id) => ({
              itemId: id,
              _sum: { qty: new Prisma.Decimal(byId.get(id)!.reservedKg!) },
            })),
        ),
      ),
    },
    quotationReservation: { groupBy: jest.fn().mockResolvedValue([]) },
    inventoryMovement: {
      findMany: jest.fn((args: { where: { itemId: { in: string[] } } }) =>
        Promise.resolve(
          args.where.itemId.in.map((id, i) => ({
            id: BigInt(100 + i),
            itemId: id,
            refType: 'SCRAP',
            refId: `ref-${id}`,
          })),
        ),
      ),
      create: jest.fn(),
    },
    auditLog: {
      findMany: jest.fn((args: { where: { entityId: { in: string[] } } }) =>
        Promise.resolve(
          // El helper pide `orderBy: id desc`: la semilla va de la más nueva a la más vieja.
          audits.filter((a) => args.where.entityId.in.includes(a.entityId)),
        ),
      ),
    },
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  return { tx: tx as unknown as Prisma.TransactionClient, raw: tx, audit };
}

const CAUSE = { kind: 'SCRAP' as const, refId: 'mv-1', label: 'merma de 5.000 kg (RF-17)' };

function writesOf(audit: {
  write: jest.Mock;
}): { action: string; entityId: string; after: Record<string, unknown> }[] {
  return (
    audit.write.mock.calls as [
      unknown,
      { action: string; entityId: string; after: Record<string, unknown> },
    ][]
  ).map((c) => c[1]);
}

describe('planAutoTerminate (D-360)', () => {
  it('solo termina en exactamente 0: 0,001 kg sigue vigente', async () => {
    const { tx } = fakeTx([
      { id: 'zero', qty: '0.000' },
      { id: 'almost', qty: '0.001' },
      { id: 'full', qty: '1500.000' },
    ]);
    const plan = await planAutoTerminate(tx, ['zero', 'almost', 'full']);
    expect(plan.terminate.map((c) => c.id)).toEqual(['zero']);
    expect(plan.skipped).toEqual([]);
  });

  it('sin fila de saldo cuenta como 0', async () => {
    const { tx } = fakeTx([{ id: 'norow', qty: null }]);
    const plan = await planAutoTerminate(tx, ['norow']);
    expect(plan.terminate.map((c) => c.id)).toEqual(['norow']);
  });

  it('negativa: anomalía, no se termina', async () => {
    const { tx } = fakeTx([{ id: 'neg', qty: '-2.500' }]);
    const plan = await planAutoTerminate(tx, ['neg']);
    expect(plan.terminate).toEqual([]);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ id: 'neg', reason: 'NEGATIVE', detail: 'saldo -2.500 kg' }),
    ]);
  });

  it('montada en una OP viva: se deja para el cierre o la liberación', async () => {
    const { tx } = fakeTx([{ id: 'm', qty: '0', mountedIn: [12] }]);
    const plan = await planAutoTerminate(tx, ['m']);
    expect(plan.terminate).toEqual([]);
    expect(plan.skipped).toEqual([expect.objectContaining({ id: 'm', reason: 'MOUNTED' })]);
    expect(plan.skipped[0]!.detail).toContain('OP-');
    expect(isAnomaly('MOUNTED')).toBe(false);
  });

  it('en 0 con reserva viva sobre el rollo: anomalía, no se termina', async () => {
    const { tx } = fakeTx([{ id: 'r', qty: '0', reservedKg: '4200.000' }]);
    const plan = await planAutoTerminate(tx, ['r']);
    expect(plan.terminate).toEqual([]);
    expect(plan.skipped).toEqual([expect.objectContaining({ id: 'r', reason: 'RESERVED' })]);
    expect(isAnomaly('RESERVED')).toBe(true);
  });

  it('una bobina que no está vigente no se toca', async () => {
    const { tx } = fakeTx([
      { id: 'closed', qty: '0', status: CoilStatus.CLOSED },
      { id: 'third', qty: '0', status: CoilStatus.IN_THIRD_PARTY },
    ]);
    const plan = await planAutoTerminate(tx, ['closed', 'third']);
    expect(plan).toEqual({ terminate: [], skipped: [] });
  });

  it('lista vacía: ninguna consulta', async () => {
    const { tx, raw } = fakeTx([]);
    expect(await planAutoTerminate(tx, ['', ''])).toEqual({ terminate: [], skipped: [] });
    expect(raw.coil.findMany).not.toHaveBeenCalled();
  });

  it('presupuesto fijo: cuatro consultas con una bobina o con cincuenta', async () => {
    const count = (raw: ReturnType<typeof fakeTx>['raw']) =>
      raw.coil.findMany.mock.calls.length +
      raw.inventoryBalance.findMany.mock.calls.length +
      raw.productionOrderConsumption.findMany.mock.calls.length +
      raw.reservation.groupBy.mock.calls.length +
      raw.quotationReservation.groupBy.mock.calls.length;
    const one = fakeTx([{ id: 'a', qty: '0' }]);
    await planAutoTerminate(one.tx, ['a']);
    const many = fakeTx(Array.from({ length: 50 }, (_, i) => ({ id: `c${String(i)}`, qty: '0' })));
    await planAutoTerminate(
      many.tx,
      Array.from({ length: 50 }, (_, i) => `c${String(i)}`),
    );
    expect(count(one.raw)).toBe(5);
    expect(count(many.raw)).toBe(5);
  });
});

describe('autoTerminateEmptyCoils (D-360)', () => {
  it('termina sin kardex, con la causa y el movimiento que la dejó en 0', async () => {
    const { tx, raw, audit } = fakeTx([{ id: 'c1', code: 'IMPO-1', qty: '0' }]);
    const plan = await autoTerminateEmptyCoils(tx, audit as never, {
      actorId: 'u1',
      coilIds: ['c1'],
      cause: CAUSE,
      operationDate: '2026-09-28',
    });

    expect(plan.terminate).toEqual([{ id: 'c1', code: 'IMPO-1' }]);
    expect(raw.coil.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['c1'] }, status: CoilStatus.OPEN },
      data: { status: CoilStatus.CLOSED },
    });
    // **Nunca** kardex: ni un movimiento nuevo.
    expect(raw.inventoryMovement.create).not.toHaveBeenCalled();
    const [close] = writesOf(audit);
    expect(close).toEqual(
      expect.objectContaining({
        action: 'coils.close',
        entityId: 'c1',
        after: expect.objectContaining({
          status: CoilStatus.CLOSED,
          reason: 'Terminada automáticamente: merma de 5.000 kg (RF-17) (D-360)',
          adjustment: null,
          operationDate: '2026-09-28',
          autoTerminated: { kind: 'SCRAP', refId: 'mv-1' },
          zeroedBy: { movementId: '100', refType: 'SCRAP', refId: 'ref-c1' },
        }) as unknown,
      }),
    );
  });

  it('lleva los campos extra (closedByDispatch de D-170)', async () => {
    const { tx, audit } = fakeTx([{ id: 'c1', qty: '0' }]);
    await autoTerminateEmptyCoils(tx, audit as never, {
      actorId: 'u1',
      coilIds: ['c1'],
      cause: { kind: 'DISPATCH', refId: 'd1', label: 'vendida entera' },
      operationDate: '2026-09-28',
      extra: { closedByDispatch: 'DES-000001' },
    });
    expect(writesOf(audit)[0]!.after).toEqual(
      expect.objectContaining({ closedByDispatch: 'DES-000001' }),
    );
  });

  it('audita las anomalías y no audita la montada', async () => {
    const { tx, raw, audit } = fakeTx([
      { id: 'neg', qty: '-1' },
      { id: 'res', qty: '0', reservedKg: '10' },
      { id: 'mnt', qty: '0', mountedIn: [3] },
    ]);
    const plan = await autoTerminateEmptyCoils(tx, audit as never, {
      actorId: 'u1',
      coilIds: ['neg', 'res', 'mnt'],
      cause: CAUSE,
      operationDate: '2026-09-28',
    });
    expect(plan.terminate).toEqual([]);
    expect(raw.coil.updateMany).not.toHaveBeenCalled();
    const writes = writesOf(audit);
    expect(writes.map((w) => [w.action, w.entityId])).toEqual([
      ['coils.auto-terminate-skipped', 'neg'],
      ['coils.auto-terminate-skipped', 'res'],
    ]);
  });
});

describe('reopenAutoTerminatedCoils (D-360)', () => {
  const closedBy = (entityId: string, kind: string, refId: string): AuditSeed => ({
    entityId,
    action: 'coils.close',
    after: { status: 'CLOSED', autoTerminated: { kind, refId } },
  });
  const input = {
    actorId: 'u1',
    cause: { kind: 'PRODUCTION_ORDER_CLOSE' as const, refId: 'op-1' },
    label: 'reapertura de OP-000001',
    operationDate: '2026-09-28',
  };

  it('reabre solo la que terminó esta misma operación', async () => {
    const { tx, raw, audit } = fakeTx(
      [
        { id: 'mine', status: CoilStatus.CLOSED },
        { id: 'other-op', status: CoilStatus.CLOSED },
        { id: 'manual', status: CoilStatus.CLOSED },
      ],
      [
        closedBy('mine', 'PRODUCTION_ORDER_CLOSE', 'op-1'),
        closedBy('other-op', 'PRODUCTION_ORDER_CLOSE', 'op-2'),
        {
          entityId: 'manual',
          action: 'coils.close',
          after: { status: 'CLOSED', reason: 'a mano' },
        },
      ],
    );
    const result = await reopenAutoTerminatedCoils(tx, audit as never, {
      ...input,
      coilIds: ['mine', 'other-op', 'manual'],
    });
    expect(result.reopened.map((c) => c.id)).toEqual(['mine']);
    // Las que esta operación nunca terminó ni se nombran.
    expect(result.skipped).toEqual([]);
    expect(raw.coil.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['mine'] }, status: CoilStatus.CLOSED },
      data: { status: CoilStatus.OPEN },
    });
    expect(writesOf(audit)).toEqual([
      expect.objectContaining({
        action: 'coils.open',
        entityId: 'mine',
        after: expect.objectContaining({
          autoReopened: { kind: 'PRODUCTION_ORDER_CLOSE', refId: 'op-1' },
        }) as unknown,
      }),
    ]);
    expect(raw.inventoryMovement.create).not.toHaveBeenCalled();
  });

  it('ya abierta, o terminada después por otra causa: no la toca, lo anota y no falla', async () => {
    const { tx, raw, audit } = fakeTx(
      [
        { id: 'reopened', status: CoilStatus.OPEN },
        { id: 'later', status: CoilStatus.CLOSED },
      ],
      [
        // Más nueva primero: `later` se reabrió y la terminó una persona.
        { entityId: 'later', action: 'coils.close', after: { status: 'CLOSED', reason: 'a mano' } },
        { entityId: 'later', action: 'coils.open', after: { status: 'OPEN' } },
        closedBy('later', 'PRODUCTION_ORDER_CLOSE', 'op-1'),
        { entityId: 'reopened', action: 'coils.open', after: { status: 'OPEN' } },
        closedBy('reopened', 'PRODUCTION_ORDER_CLOSE', 'op-1'),
      ],
    );
    const result = await reopenAutoTerminatedCoils(tx, audit as never, {
      ...input,
      coilIds: ['reopened', 'later'],
    });
    expect(result.reopened).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ id: 'later', reason: 'OTHER_CAUSE' }),
      expect.objectContaining({ id: 'reopened', reason: 'NOT_CLOSED' }),
    ]);
    expect(raw.coil.updateMany).not.toHaveBeenCalled();
    expect(writesOf(audit).map((w) => [w.action, w.entityId])).toEqual([
      ['coils.auto-reopen-skipped', 'later'],
      ['coils.auto-reopen-skipped', 'reopened'],
    ]);
  });

  it('revisión C06: reabre la que terminó otra causa (el lote) si el movimiento en 0 es el que se anula', async () => {
    const { tx, raw, audit } = fakeTx(
      [
        { id: 'batch', status: CoilStatus.CLOSED },
        { id: 'manual', status: CoilStatus.CLOSED },
      ],
      [
        {
          entityId: 'batch',
          action: 'coils.close',
          after: {
            autoTerminated: { kind: 'BATCH', refId: 'lote-1' },
            zeroedBy: { movementId: '77', refType: 'SCRAP', refId: 'batch' },
          },
        },
        // Un cierre manual con el mismo movimiento en 0 no se deshace por la reversa.
        {
          entityId: 'manual',
          action: 'coils.close',
          after: { zeroedBy: { movementId: '77', refType: 'SCRAP', refId: 'x' } },
        },
      ],
    );
    const result = await reopenAutoTerminatedCoils(tx, audit as never, {
      actorId: 'u1',
      coilIds: ['batch', 'manual'],
      cause: { kind: 'SCRAP', refId: '77' },
      zeroedBy: { movementIds: ['77'] },
      targetStatus: CoilStatus.IN_THIRD_PARTY,
      label: 'anulación de la merma',
      operationDate: '2026-09-28',
    });
    expect(result.reopened.map((c) => c.id)).toEqual(['batch']);
    expect(raw.coil.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['batch'] }, status: CoilStatus.CLOSED },
      data: { status: CoilStatus.IN_THIRD_PARTY },
    });
  });

  it('también por la referencia del movimiento en 0 (la OP, el partido, la recepción)', async () => {
    const { tx, audit } = fakeTx(
      [{ id: 'c', status: CoilStatus.CLOSED }],
      [
        {
          entityId: 'c',
          action: 'coils.close',
          after: {
            autoTerminated: { kind: 'BATCH', refId: 'lote-1' },
            zeroedBy: { movementId: '9', refType: 'SCRAP', refId: 'op-1' },
          },
        },
      ],
    );
    const result = await reopenAutoTerminatedCoils(tx, audit as never, {
      actorId: 'u1',
      coilIds: ['c'],
      cause: { kind: 'PRODUCTION_ORDER_CLOSE', refId: 'op-1' },
      zeroedBy: { refIds: ['op-1'] },
      label: 'reapertura',
      operationDate: '2026-09-28',
    });
    expect(result.reopened.map((c) => c.id)).toEqual(['c']);
  });

  it('sin bobinas, o sin historial de esta causa: nada', async () => {
    const empty = fakeTx([]);
    expect(
      await reopenAutoTerminatedCoils(empty.tx, empty.audit as never, { ...input, coilIds: [] }),
    ).toEqual({
      reopened: [],
      skipped: [],
    });
    const none = fakeTx([{ id: 'c', status: CoilStatus.CLOSED }], [closedBy('c', 'SCRAP', 'mv-9')]);
    const result = await reopenAutoTerminatedCoils(none.tx, none.audit as never, {
      ...input,
      coilIds: ['c'],
    });
    expect(result).toEqual({ reopened: [], skipped: [] });
    expect(none.raw.coil.findMany).not.toHaveBeenCalled();
  });
});
