import { AuditActorKind } from '@prisma/client';
import { runWithRequestId } from '../common/request-context';
import { AuditService, type AuditWriter } from './audit.service';

interface CreatedRow {
  actorKind: AuditActorKind;
  requestId: string | null;
  reason: string | null;
  after: unknown;
}

/**
 * D-218/RF-S2: `actorKind` default, `requestId` ambiental cuando no se pasa explícito,
 * `reason` y la redacción de `audit-redact.ts` aplicada de punta a punta.
 */
describe('AuditService.write (D-218)', () => {
  function fakeTx(): { tx: AuditWriter; lastRow: () => CreatedRow } {
    const create = jest.fn((_args: { data: CreatedRow }) => Promise.resolve({ id: 1n }));
    return {
      tx: { auditLog: { create } } as unknown as AuditWriter,
      lastRow: () => create.mock.calls[create.mock.calls.length - 1]![0].data,
    };
  }

  it('actorKind por defecto es USER', async () => {
    const service = new AuditService({} as never);
    const { tx, lastRow } = fakeTx();
    await service.write(tx, { actorId: 'u-1', action: 'x.y', entity: 'x' });
    expect(lastRow().actorKind).toBe(AuditActorKind.USER);
  });

  it('actorKind SYSTEM se respeta cuando se pasa explícito', async () => {
    const service = new AuditService({} as never);
    const { tx, lastRow } = fakeTx();
    await service.write(tx, {
      actorId: null,
      actorKind: AuditActorKind.SYSTEM,
      action: 'job.sweep',
      entity: 'x',
    });
    expect(lastRow().actorKind).toBe(AuditActorKind.SYSTEM);
  });

  it('sin requestId explícito, toma el de la petición en curso (AsyncLocalStorage)', async () => {
    const service = new AuditService({} as never);
    const { tx, lastRow } = fakeTx();
    await runWithRequestId('11111111-1111-1111-1111-111111111111', async () => {
      await service.write(tx, { actorId: 'u-1', action: 'x.y', entity: 'x' });
    });
    expect(lastRow().requestId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('fuera de una petición (un job) el requestId queda null, no undefined perdido', async () => {
    const service = new AuditService({} as never);
    const { tx, lastRow } = fakeTx();
    await service.write(tx, { actorId: null, action: 'job.sweep', entity: 'x' });
    expect(lastRow().requestId).toBeNull();
  });

  it('reason viaja tal cual, null si no se pasa', async () => {
    const service = new AuditService({} as never);
    const { tx, lastRow } = fakeTx();
    await service.write(tx, {
      actorId: 'u-1',
      action: 'x.reverse',
      entity: 'x',
      reason: 'Corrección de precio',
    });
    expect(lastRow().reason).toBe('Corrección de precio');
  });

  it('before/after pasan por la redacción antes de escribirse', async () => {
    const service = new AuditService({} as never);
    const { tx, lastRow } = fakeTx();
    await service.write(tx, {
      actorId: 'u-1',
      action: 'users.update',
      entity: 'users',
      after: { email: 'a@b.com', passwordHash: 'nope' },
    });
    expect(lastRow().after).toEqual({
      email: 'a@b.com',
      passwordHash: '[redactado]',
    });
  });
});
