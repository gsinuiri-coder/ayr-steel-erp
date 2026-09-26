import { BadRequestException } from '@nestjs/common';
import { CoilStatus, type Prisma } from '@prisma/client';
import {
  assertCanReseal,
  loadResealFacts,
  openFilmIfSealed,
  recordFilmEvent,
  resealIfOpenedBy,
} from './coil-film';

/**
 * D-328 — el acceso a la base de `coil-film.ts`, con un `tx` simulado: qué evento se inserta, en
 * qué orden se consulta y cuándo NO se toca nada. La regla de negocio (cuándo se puede volver a
 * sellar) está en `coil-film.spec.ts`; acá se prueba que el pegamento la aplique.
 */

interface FakeTx {
  coilFilmEvent: { create: jest.Mock; findFirst: jest.Mock };
  inventoryMovement: { findMany: jest.Mock };
  productionOrderConsumption: { findMany: jest.Mock };
}

function fakeTx(over: {
  lastEvent?: { type: string; source: string; refId?: string | null } | null;
  lastOpen?: { source: string; at: Date } | null;
  movements?: { refType: string; operationDate: Date; at: Date }[];
  assignments?: { orderSeq: number }[];
}): FakeTx & Prisma.TransactionClient {
  const findFirst = jest.fn((args: { where: { type?: string } }) =>
    Promise.resolve(
      args.where.type === 'OPENED' ? (over.lastOpen ?? null) : (over.lastEvent ?? null),
    ),
  );
  return {
    coilFilmEvent: { create: jest.fn().mockResolvedValue({}), findFirst },
    inventoryMovement: { findMany: jest.fn().mockResolvedValue(over.movements ?? []) },
    productionOrderConsumption: {
      findMany: jest.fn().mockResolvedValue(
        (over.assignments ?? []).map((a) => ({
          coilId: 'c1',
          assignedKg: { toString: () => '100' },
          consumedKg: { toString: () => '0' },
          coil: { code: 'B-1' },
          productionOrder: { id: `o${String(a.orderSeq)}`, seq: a.orderSeq, reservationId: null },
        })),
      ),
    },
  } as unknown as FakeTx & Prisma.TransactionClient;
}

/** El primer argumento de la primera llamada de un mock, tipado (los mocks de jest dan `any`). */
function firstArg(mock: jest.Mock): Record<string, unknown> {
  return (mock.mock.calls as Record<string, unknown>[][])[0]![0]!;
}

const coil = (over: Partial<{ status: CoilStatus; filmSealed: boolean }> = {}) => ({
  id: 'c1',
  status: CoilStatus.OPEN,
  filmSealed: true,
  ...over,
});

describe('recordFilmEvent', () => {
  it('inserta el evento con la fecha de negocio como fecha (día, sin hora) y el actor', async () => {
    const tx = fakeTx({});
    await recordFilmEvent(tx, {
      coilId: 'c1',
      type: 'OPENED',
      source: 'MANUAL',
      operationDate: '2026-09-10',
      actorId: 'u1',
      reason: 'para usarla',
    });
    const data = firstArg(tx.coilFilmEvent.create).data as Record<string, unknown>;
    expect(data).toMatchObject({
      coilId: 'c1',
      type: 'OPENED',
      source: 'MANUAL',
      actorId: 'u1',
      reason: 'para usarla',
      refId: null,
    });
    expect((data.operationDate as Date).toISOString().slice(0, 10)).toBe('2026-09-10');
  });
});

describe('openFilmIfSealed', () => {
  const ctx = { source: 'SCRAP', operationDate: '2026-09-10', actorId: 'u1' } as const;

  it('una vigente sellada se abre: escribe el evento y devuelve true', async () => {
    const tx = fakeTx({});
    await expect(openFilmIfSealed(tx, coil(), { ...ctx, refId: 'x' })).resolves.toBe(true);
    expect(firstArg(tx.coilFilmEvent.create).data).toMatchObject({
      type: 'OPENED',
      source: 'SCRAP',
      refId: 'x',
    });
  });

  it('ya abierta: no escribe nada', async () => {
    const tx = fakeTx({});
    await expect(openFilmIfSealed(tx, coil({ filmSealed: false }), ctx)).resolves.toBe(false);
    expect(tx.coilFilmEvent.create).not.toHaveBeenCalled();
  });

  it.each([CoilStatus.CLOSED, CoilStatus.CANCELLED, CoilStatus.IN_THIRD_PARTY])(
    'una bobina %s no tiene film que abrir',
    async (status) => {
      const tx = fakeTx({});
      await expect(openFilmIfSealed(tx, coil({ status }), ctx)).resolves.toBe(false);
      expect(tx.coilFilmEvent.create).not.toHaveBeenCalled();
    },
  );
});

describe('loadResealFacts / assertCanReseal', () => {
  it('junta el último OPENED, las salidas vivas y las OP que la tienen montada', async () => {
    const at = new Date('2026-09-10T10:00:00Z');
    const tx = fakeTx({
      lastOpen: { source: 'MANUAL', at },
      movements: [
        {
          refType: 'SCRAP',
          operationDate: new Date('2026-09-11T00:00:00Z'),
          at: new Date('2026-09-11T09:00:00Z'),
        },
      ],
      assignments: [{ orderSeq: 7 }],
    });
    const facts = await loadResealFacts(tx, coil({ filmSealed: false }));
    expect(facts.film).toBe('OPENED');
    expect(facts.lastOpen).toEqual({ source: 'MANUAL', at });
    expect(facts.outflows).toEqual([
      { refType: 'SCRAP', operationDate: '2026-09-11', at: new Date('2026-09-11T09:00:00Z') },
    ]);
    expect(facts.liveOrderCodes).toHaveLength(1);
    // Solo salidas vivas de uso: la consulta excluye anuladas y anulaciones.
    const where = firstArg(tx.inventoryMovement.findMany).where as Record<string, unknown>;
    expect(where).toMatchObject({
      type: 'OUT',
      reversalOfId: null,
      reversals: { none: {} },
      refType: { in: ['PRODUCTION', 'SCRAP', 'SPLIT', 'CUTTING'] },
    });
  });

  it('assertCanReseal rechaza con 400 y el motivo concreto', async () => {
    const tx = fakeTx({
      lastOpen: { source: 'MANUAL', at: new Date('2026-09-10T10:00:00Z') },
      movements: [
        {
          refType: 'SPLIT',
          operationDate: new Date('2026-09-11T00:00:00Z'),
          at: new Date('2026-09-11T09:00:00Z'),
        },
      ],
    });
    await expect(assertCanReseal(tx, coil({ filmSealed: false }))).rejects.toThrow(
      BadRequestException,
    );
    await expect(assertCanReseal(tx, coil({ filmSealed: false }))).rejects.toThrow(/un partido/);
  });

  it('assertCanReseal deja pasar una abierta que no se usó', async () => {
    const tx = fakeTx({ lastOpen: { source: 'MANUAL', at: new Date('2026-09-10T10:00:00Z') } });
    await expect(assertCanReseal(tx, coil({ filmSealed: false }))).resolves.toBeUndefined();
  });
});

describe('resealIfOpenedBy', () => {
  const cause = { source: 'MOUNT', undoSource: 'MOUNT_UNDO', refId: 'cons-1' } as const;
  const ctx = { operationDate: '2026-09-12', actorId: 'u1' };

  it('la apertura fue de esta causa y no se usó: escribe RESEALED con la fuente de deshacer', async () => {
    const tx = fakeTx({
      lastEvent: { type: 'OPENED', source: 'MOUNT' },
      lastOpen: { source: 'MOUNT', at: new Date('2026-09-10T10:00:00Z') },
    });
    await expect(resealIfOpenedBy(tx, coil({ filmSealed: false }), cause, ctx)).resolves.toBe(true);
    expect(firstArg(tx.coilFilmEvent.create).data).toMatchObject({
      type: 'RESEALED',
      source: 'MOUNT_UNDO',
      refId: 'cons-1',
      actorId: 'u1',
    });
  });

  it('ya sellada: no hace nada ni consulta', async () => {
    const tx = fakeTx({});
    await expect(resealIfOpenedBy(tx, coil({ filmSealed: true }), cause, ctx)).resolves.toBe(false);
    expect(tx.coilFilmEvent.findFirst).not.toHaveBeenCalled();
  });

  it('la abrió una persona a mano: la operación que se deshace no la vuelve a sellar', async () => {
    const tx = fakeTx({ lastEvent: { type: 'OPENED', source: 'MANUAL' } });
    await expect(resealIfOpenedBy(tx, coil({ filmSealed: false }), cause, ctx)).resolves.toBe(
      false,
    );
    expect(tx.coilFilmEvent.create).not.toHaveBeenCalled();
  });

  it('la abrió OTRA operación (merma): tampoco', async () => {
    const tx = fakeTx({ lastEvent: { type: 'OPENED', source: 'SCRAP' } });
    await expect(resealIfOpenedBy(tx, coil({ filmSealed: false }), cause, ctx)).resolves.toBe(
      false,
    );
  });

  it('sin historial (columna abierta sin eventos): no inventa un resello', async () => {
    const tx = fakeTx({ lastEvent: null });
    await expect(resealIfOpenedBy(tx, coil({ filmSealed: false }), cause, ctx)).resolves.toBe(
      false,
    );
  });

  it('el último evento ya era un resello: no se duplica', async () => {
    const tx = fakeTx({ lastEvent: { type: 'RESEALED', source: 'MOUNT_UNDO' } });
    await expect(resealIfOpenedBy(tx, coil({ filmSealed: false }), cause, ctx)).resolves.toBe(
      false,
    );
  });

  it('se usó desde la apertura: no se vuelve a sellar', async () => {
    const tx = fakeTx({
      lastEvent: { type: 'OPENED', source: 'MOUNT' },
      lastOpen: { source: 'MOUNT', at: new Date('2026-09-10T10:00:00Z') },
      movements: [
        {
          refType: 'PRODUCTION',
          operationDate: new Date('2026-09-11T00:00:00Z'),
          at: new Date('2026-09-11T09:00:00Z'),
        },
      ],
    });
    await expect(resealIfOpenedBy(tx, coil({ filmSealed: false }), cause, ctx)).resolves.toBe(
      false,
    );
    expect(tx.coilFilmEvent.create).not.toHaveBeenCalled();
  });

  it('sigue montada en otra OP: no se vuelve a sellar (multi-montaje, D-192)', async () => {
    const tx = fakeTx({
      lastEvent: { type: 'OPENED', source: 'MOUNT' },
      lastOpen: { source: 'MOUNT', at: new Date('2026-09-10T10:00:00Z') },
      assignments: [{ orderSeq: 9 }],
    });
    await expect(resealIfOpenedBy(tx, coil({ filmSealed: false }), cause, ctx)).resolves.toBe(
      false,
    );
  });
});
