import { BadRequestException, ConflictException } from '@nestjs/common';
import { CoilStatus } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import type { OperationDateService } from '../common/operation-date.service';
import type { PrismaService } from '../prisma/prisma.service';
import { CoilFilmService } from './coil-film.service';
import type { CoilsService } from './coils.service';

/**
 * D-328 — las acciones manuales «Abrir bobina» y «Volver a sellar»: transacción, bloqueo de la
 * fila, evento con fuente MANUAL, auditoría en la misma transacción, y los rechazos.
 */

const ACTOR = { id: 'u1', role: 'ADMINISTRADOR' } as unknown as RequestUser;

/** El argumento `n` de la primera llamada de un mock, tipado (los mocks de jest dan `any`). */
function firstCall(mock: jest.Mock, n = 0): Record<string, unknown> {
  return (mock.mock.calls as Record<string, unknown>[][])[0]![n]!;
}
const RESPONSE = { id: 'c1', film: 'OPENED' };

function build(
  coil: { status: CoilStatus; filmSealed: boolean },
  over: { movements?: unknown[]; lastOpen?: unknown } = {},
) {
  const tx = {
    coilFilmEvent: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest
        .fn()
        .mockResolvedValue(
          over.lastOpen ?? { source: 'MANUAL', at: new Date('2026-09-10T10:00:00Z') },
        ),
    },
    inventoryMovement: { findMany: jest.fn().mockResolvedValue(over.movements ?? []) },
    productionOrderConsumption: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const prisma = {
    $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const coils = {
    lockCoil: jest.fn().mockResolvedValue({ id: 'c1', ...coil }),
    findOne: jest.fn().mockResolvedValue(RESPONSE),
  };
  const operationDate = { resolve: jest.fn().mockReturnValue('2026-09-12') };
  const service = new CoilFilmService(
    prisma,
    audit as unknown as AuditService,
    coils as unknown as CoilsService,
    operationDate as unknown as OperationDateService,
  );
  return { service, tx, audit, coils, operationDate };
}

describe('CoilFilmService.open', () => {
  it('abre una vigente sellada: evento MANUAL, fecha resuelta por D-124, auditoría y respuesta', async () => {
    const { service, tx, audit, coils, operationDate } = build({
      status: CoilStatus.OPEN,
      filmSealed: true,
    });
    await expect(
      service.open(ACTOR, 'c1', { operationDate: '2026-09-12', reason: 'para usarla' }),
    ).resolves.toBe(RESPONSE);
    expect(operationDate.resolve).toHaveBeenCalledWith(ACTOR, '2026-09-12');
    expect(coils.lockCoil).toHaveBeenCalled();
    expect(firstCall(tx.coilFilmEvent.create).data).toMatchObject({
      coilId: 'c1',
      type: 'OPENED',
      source: 'MANUAL',
      actorId: 'u1',
      reason: 'para usarla',
    });
    expect(firstCall(audit.write, 1)).toMatchObject({
      action: 'coils.film_open',
      entityId: 'c1',
      before: { film: 'SEALED' },
    });
  });

  it('ya abierta: 409 y no escribe nada', async () => {
    const { service, tx } = build({ status: CoilStatus.OPEN, filmSealed: false });
    await expect(service.open(ACTOR, 'c1', {})).rejects.toThrow(ConflictException);
    expect(tx.coilFilmEvent.create).not.toHaveBeenCalled();
  });

  it.each([
    [CoilStatus.CLOSED, 'terminada'],
    [CoilStatus.CANCELLED, 'anulada'],
    [CoilStatus.IN_THIRD_PARTY, 'en corte tercerizado'],
  ])('una bobina %s no se abre: dice por qué', async (status, word) => {
    const { service, tx } = build({ status, filmSealed: true });
    await expect(service.open(ACTOR, 'c1', {})).rejects.toThrow(BadRequestException);
    await expect(service.open(ACTOR, 'c1', {})).rejects.toThrow(word);
    expect(tx.coilFilmEvent.create).not.toHaveBeenCalled();
  });
});

describe('CoilFilmService.reseal', () => {
  it('vuelve a sellar una abierta que no se usó: evento RESEALED MANUAL y auditoría', async () => {
    const { service, tx, audit } = build({ status: CoilStatus.OPEN, filmSealed: false });
    await expect(service.reseal(ACTOR, 'c1', { reason: 'se abrió por error' })).resolves.toBe(
      RESPONSE,
    );
    expect(firstCall(tx.coilFilmEvent.create).data).toMatchObject({
      type: 'RESEALED',
      source: 'MANUAL',
      reason: 'se abrió por error',
    });
    expect(firstCall(audit.write, 1)).toMatchObject({
      action: 'coils.film_reseal',
      before: { film: 'OPENED' },
      after: { film: 'SEALED' },
    });
  });

  it('con una salida viva desde la apertura: 400 que nombra el movimiento y no escribe nada', async () => {
    const { service, tx, audit } = build(
      { status: CoilStatus.OPEN, filmSealed: false },
      {
        movements: [
          {
            refType: 'PRODUCTION',
            operationDate: new Date('2026-09-11T00:00:00Z'),
            at: new Date('2026-09-11T09:00:00Z'),
          },
        ],
      },
    );
    await expect(service.reseal(ACTOR, 'c1', {})).rejects.toThrow(/una producción del 2026-09-11/);
    expect(tx.coilFilmEvent.create).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('ya sellada: 400', async () => {
    const { service } = build({ status: CoilStatus.OPEN, filmSealed: true });
    await expect(service.reseal(ACTOR, 'c1', {})).rejects.toThrow('La bobina ya está sellada');
  });
});
