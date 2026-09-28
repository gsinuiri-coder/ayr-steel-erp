import { CoilStatus, Prisma } from '@prisma/client';
import {
  BATCH_LABEL,
  coilsOfBatch,
  executeTerminateZeroCoils,
  formatSnapshot,
  formatTerminatePlan,
  formatUndo,
  planTerminateZeroCoils,
  planUndoTerminateZeroCoils,
  snapshotCoils,
  undoTerminateZeroCoils,
} from './terminate-zero-coils';

/**
 * D-360 — la terminación única: misma regla que la automática, con un lote como causa y una
 * reversa que reabre exactamente ese lote.
 */

const BATCH = '0b6f3c1e-2a4d-4e8f-9a1b-3c5d7e9f1a2b';

function fakeTx(opts: {
  open: { id: string; code: string; qty: string }[];
  closed?: { id: string; code: string }[];
  audits?: { entityId: string; action: string; after: Record<string, unknown> }[];
}) {
  const all = [
    ...opts.open.map((c) => ({ ...c, status: CoilStatus.OPEN })),
    ...(opts.closed ?? []).map((c) => ({ ...c, qty: '0', status: CoilStatus.CLOSED })),
  ];
  const tx = {
    coil: {
      findMany: jest.fn(
        (args: { where: { status?: CoilStatus; id?: { in: string[] } }; select: object }) =>
          Promise.resolve(
            all
              .filter((c) => args.where.status === undefined || c.status === args.where.status)
              .filter((c) => args.where.id === undefined || args.where.id.in.includes(c.id))
              .map((c) => ({ id: c.id, code: c.code, status: c.status })),
          ),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    inventoryBalance: {
      findMany: jest.fn(() =>
        Promise.resolve(all.map((c) => ({ itemId: c.id, qty: new Prisma.Decimal(c.qty) }))),
      ),
    },
    productionOrderConsumption: { findMany: jest.fn().mockResolvedValue([]) },
    reservation: { groupBy: jest.fn().mockResolvedValue([]) },
    quotationReservation: { groupBy: jest.fn().mockResolvedValue([]) },
    inventoryMovement: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn((args: { where: { itemId: { in: string[] } } }) =>
        Promise.resolve(
          args.where.itemId.in.map((id, i) => ({
            itemId: id,
            _count: { _all: 2 },
            _max: { id: BigInt(200 + i) },
          })),
        ),
      ),
    },
    auditLog: {
      findMany: jest.fn((args: { where: { entityId?: { in: string[] }; after?: unknown } }) =>
        Promise.resolve(
          (opts.audits ?? []).filter(
            (a) => args.where.entityId === undefined || args.where.entityId.in.includes(a.entityId),
          ),
        ),
      ),
    },
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  return { tx: tx as unknown as Prisma.TransactionClient, raw: tx, audit };
}

const batchClose = (entityId: string, kind = 'BATCH', refId = BATCH) => ({
  entityId,
  action: 'coils.close',
  after: { status: 'CLOSED', autoTerminated: { kind, refId } },
});

describe('foto de las bobinas del lote (D-360)', () => {
  it('estado, saldo, movimientos y el último; la foto no escribe nada', async () => {
    const { tx, raw } = fakeTx({
      open: [{ id: 'a', code: 'IMPO-A', qty: '0' }],
      closed: [{ id: 'b', code: 'IMPO-B' }],
    });
    const rows = await snapshotCoils(tx, ['a', 'b', 'a']);
    expect(rows).toEqual([
      {
        code: 'IMPO-A',
        status: CoilStatus.OPEN,
        qtyKg: '0.000',
        movements: 2,
        lastMovementId: '200',
      },
      {
        code: 'IMPO-B',
        status: CoilStatus.CLOSED,
        qtyKg: '0.000',
        movements: 2,
        lastMovementId: '201',
      },
    ]);
    expect(raw.coil.updateMany).not.toHaveBeenCalled();
    const text = formatSnapshot(rows, 'antes — rama demo');
    expect(text).toContain('Foto «antes — rama demo» — 2 bobinas');
    expect(text).toContain('Por estado: OPEN 1, CLOSED 1');
    expect(text).toContain('Movimientos de kardex: 4');
  });

  it('sin bobinas: vacía, sin consultas', async () => {
    const { tx, raw } = fakeTx({ open: [] });
    expect(await snapshotCoils(tx, [])).toEqual([]);
    expect(raw.coil.findMany).not.toHaveBeenCalled();
    expect(formatSnapshot([], 'x')).toContain('Movimientos de kardex: 0');
  });
});

describe('terminación única (D-360)', () => {
  it('el dry-run mira todas las vigentes y solo propone las de 0 exacto', async () => {
    const { tx, raw } = fakeTx({
      open: [
        { id: 'a', code: 'IMPO-A', qty: '0' },
        { id: 'b', code: 'IMPO-B', qty: '0.001' },
      ],
    });
    const plan = await planTerminateZeroCoils(tx);
    expect(plan.terminate).toEqual([{ id: 'a', code: 'IMPO-A' }]);
    expect(raw.coil.updateMany).not.toHaveBeenCalled();
  });

  it('la ejecución termina con el lote como causa', async () => {
    const { tx, audit } = fakeTx({ open: [{ id: 'a', code: 'IMPO-A', qty: '0' }] });
    const done = await executeTerminateZeroCoils(tx, audit as never, {
      actorId: 'u1',
      batchId: BATCH,
      operationDate: '2026-09-28',
    });
    expect(done.terminate).toHaveLength(1);
    const [, entry] = audit.write.mock.calls[0] as [unknown, { after: Record<string, unknown> }];
    expect(entry.after.autoTerminated).toEqual({ kind: 'BATCH', refId: BATCH });
    expect(entry.after.reason).toContain(BATCH_LABEL(BATCH));
  });

  it('coilsOfBatch solo toma las terminaciones de lote (no otra causa con el mismo id)', async () => {
    const { tx } = fakeTx({
      open: [],
      closed: [
        { id: 'a', code: 'IMPO-A' },
        { id: 'b', code: 'IMPO-B' },
      ],
      audits: [batchClose('a'), batchClose('b', 'SCRAP')],
    });
    expect((await coilsOfBatch(tx, BATCH)).map((c) => c.id)).toEqual(['a']);
  });

  it('la reversa reabre exactamente el lote; el dry-run no escribe', async () => {
    const seed = {
      open: [],
      closed: [{ id: 'a', code: 'IMPO-A' }],
      audits: [batchClose('a')],
    };
    const dry = fakeTx(seed);
    const preview = await planUndoTerminateZeroCoils(dry.tx, BATCH);
    expect(preview.reopened.map((c) => c.id)).toEqual(['a']);
    expect(dry.raw.coil.updateMany).not.toHaveBeenCalled();
    expect(dry.audit.write).not.toHaveBeenCalled();

    const real = fakeTx(seed);
    const done = await undoTerminateZeroCoils(real.tx, real.audit as never, {
      actorId: 'u1',
      batchId: BATCH,
      operationDate: '2026-09-28',
    });
    expect(done.reopened.map((c) => c.id)).toEqual(['a']);
    expect(real.raw.coil.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a'] }, status: CoilStatus.CLOSED },
      data: { status: CoilStatus.OPEN },
    });
  });

  it('un lote sin bobinas: nada que reabrir', async () => {
    const { tx } = fakeTx({ open: [] });
    expect(await planUndoTerminateZeroCoils(tx, BATCH)).toEqual({ reopened: [], skipped: [] });
  });

  it('la lista dice qué se termina y por qué se omite cada una', () => {
    const text = formatTerminatePlan(
      {
        terminate: [{ id: 'a', code: 'IMPO-A' }],
        skipped: [
          { id: 'm', code: 'IMPO-M', reason: 'MOUNTED', detail: 'montada en OP-000001' },
          {
            id: 'r',
            code: 'IMPO-R',
            reason: 'RESERVED',
            detail: 'en 0 kg con 10.000 kg reservados',
          },
          { id: 'n', code: 'IMPO-N', reason: 'NEGATIVE', detail: 'saldo -1.000 kg' },
        ],
      },
      { branch: 'production', mode: 'dry-run', batchId: BATCH },
    );
    expect(text).toContain('rama production — dry-run');
    expect(text).toContain(`Lote: ${BATCH}`);
    expect(text).toContain('Se terminan: 1\n  IMPO-A');
    expect(text).toContain('IMPO-M — montada en una OP viva');
    expect(text).toContain('IMPO-R — ANOMALÍA: en 0 con reserva viva');
    expect(text).toContain('IMPO-N — ANOMALÍA: saldo negativo');

    const undo = formatUndo(
      {
        reopened: [{ id: 'a', code: 'IMPO-A' }],
        skipped: [
          { id: 'b', code: 'IMPO-B', reason: 'NOT_CLOSED' },
          { id: 'c', code: 'IMPO-C', reason: 'OTHER_CAUSE' },
        ],
      },
      { branch: 'demo', mode: 'ejecutado', batchId: BATCH },
    );
    expect(undo).toContain('Se reabren: 1\n  IMPO-A');
    expect(undo).toContain('IMPO-B — ya no está terminada');
    expect(undo).toContain('IMPO-C — terminada después por otra causa');
  });
});
