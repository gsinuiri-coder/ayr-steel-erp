import { ConflictException } from '@nestjs/common';
import { FiscalDocType, FiscalDocumentStatus, Role } from '@prisma/client';
import type { RequestUser } from '../auth/auth.types';
import { InvoicingService, SEND_CLAIM_LEASE_MS, sendClaimWhere } from './invoicing.service';

/**
 * cc57 (B-04 de audit-01) — el reclamo de un envío al PSE, con una base falsa. Lo mismo, con dos
 * reclamos a la vez contra una base real, vive en `send-claim.db-spec.ts`.
 */
const ACTOR: RequestUser = {
  id: 'admin-1',
  email: 'admin@ayr.test',
  name: 'Admin',
  role: Role.ADMINISTRADOR,
  mustChangePassword: false,
  sessionId: 'session-1',
};

function service(lastAttemptAt: Date | null) {
  const prisma = {
    fiscalDocument: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'doc-1',
        status: FiscalDocumentStatus.SEND_ERROR,
        docType: FiscalDocType.FACTURA,
        lastAttemptAt,
      }),
    },
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const svc = new InvoicingService(
    prisma as never,
    audit as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { PSE_ENABLED: true } as never,
    {} as never,
    {} as never,
  );
  const deliver = jest.fn().mockResolvedValue(undefined);
  Object.assign(svc, {
    assertOwnership: jest.fn().mockResolvedValue(undefined),
    deliverAny: deliver,
  });
  jest.spyOn(svc, 'findOne').mockResolvedValue({ id: 'doc-1' } as never);
  return { svc, deliver, audit };
}

describe('cc57 (B-04): reclamo exclusivo del envío al PSE', () => {
  it('el reclamo exige no tener otro envío en vuelo (sin intento o más viejo que el plazo)', () => {
    const now = new Date('2026-10-17T05:00:00.000Z');
    expect(sendClaimWhere('doc-1', now)).toEqual({
      id: 'doc-1',
      status: { in: expect.arrayContaining([FiscalDocumentStatus.SEND_ERROR]) as unknown },
      OR: [
        { lastAttemptAt: null },
        { lastAttemptAt: { lt: new Date(now.getTime() - SEND_CLAIM_LEASE_MS) } },
      ],
    });
    // Más largo que el tope de una llamada a Nubefact (60 s).
    expect(SEND_CLAIM_LEASE_MS).toBeGreaterThan(60_000);
  });

  it('«Reintentar» con un envío recién hecho responde 409 y no sale a la red', async () => {
    const { svc, deliver, audit } = service(new Date(Date.now() - 5_000));
    await expect(svc.retry(ACTOR, 'doc-1')).rejects.toBeInstanceOf(ConflictException);
    expect(deliver).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('pasado el plazo (o sin intento previo), «Reintentar» sale', async () => {
    const old = service(new Date(Date.now() - SEND_CLAIM_LEASE_MS - 1_000));
    await old.svc.retry(ACTOR, 'doc-1');
    expect(old.deliver).toHaveBeenCalledWith('doc-1', FiscalDocType.FACTURA);
    const never = service(null);
    await never.svc.retry(ACTOR, 'doc-1');
    expect(never.deliver).toHaveBeenCalled();
  });
});
