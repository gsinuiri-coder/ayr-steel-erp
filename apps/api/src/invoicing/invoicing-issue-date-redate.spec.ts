import { ConflictException } from '@nestjs/common';
import type { RequestUser } from '../auth/auth.types';
import { InvoicingService } from './invoicing.service';

/**
 * D-288 en la corrección de la fecha de emisión: con despachos «a la fecha del comprobante» la
 * decisión es explícita (409 sin tocar nada si falta), `false` solo mueve la fecha y `true`
 * re-fecha el despacho **después** de mover la fecha, en la misma transacción.
 */

const ADMIN = { id: 'admin', role: 'ADMINISTRADOR' } as RequestUser;

function build(linked: { id: string; seq: number; atIssueDate: boolean }[]) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    fiscalDocument: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'F1',
        origin: 'MANUAL',
        status: 'ACCEPTED',
        issueDate: new Date('2026-09-19T00:00:00.000Z'),
        dueDate: null,
        paymentTerms: 'CONTADO',
        annulledAt: null,
        archivedAt: null,
        affectedDocument: null,
        creditNotes: [],
        payments: [],
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    fiscalDocumentIssueDateChange: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const invoiceDispatch = {
    linkedInTx: jest.fn().mockResolvedValue(linked),
    redateInTx: jest.fn().mockResolvedValue({ reversed: ['DES-000019'], created: ['nuevo'] }),
  };
  const svc = new InvoicingService(
    prisma as never,
    audit as never,
    {} as never,
    {} as never,
    { assertIssueDate: jest.fn() } as never,
    {} as never,
    { PSE_ENABLED: false } as never,
    invoiceDispatch as never,
  );
  jest.spyOn(svc, 'findOne').mockResolvedValue({ id: 'F1' } as never);
  return { svc, tx, prisma, audit, invoiceDispatch };
}

const AUTO = [{ id: 'd-1', seq: 19, atIssueDate: true }];
const input = { issueDate: '2026-08-19', reason: 'se tipeó mal' };

describe('InvoicingService.updateManualIssueDate — despachos a la fecha del comprobante (D-288)', () => {
  it('con despachos automáticos y sin decidir: 409 y nada escrito', async () => {
    const { svc, tx, invoiceDispatch } = build(AUTO);
    await expect(svc.updateManualIssueDate(ADMIN, 'F1', input)).rejects.toThrow(ConflictException);
    await expect(svc.updateManualIssueDate(ADMIN, 'F1', input)).rejects.toThrow('DES-000019');
    expect(tx.fiscalDocument.update).not.toHaveBeenCalled();
    expect(invoiceDispatch.redateInTx).not.toHaveBeenCalled();
  });

  it('con «no»: mueve la fecha, audita la decisión y no toca el despacho', async () => {
    const { svc, tx, audit, invoiceDispatch } = build(AUTO);
    await svc.updateManualIssueDate(ADMIN, 'F1', { ...input, redateDispatches: false });
    expect(tx.fiscalDocument.update).toHaveBeenCalled();
    expect(invoiceDispatch.redateInTx).not.toHaveBeenCalled();
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ after: expect.objectContaining({ redateDispatches: false }) }),
    );
  });

  it('con «sí»: re-fecha después de mover la fecha, en la misma transacción (60 s)', async () => {
    const { svc, tx, prisma, invoiceDispatch } = build(AUTO);
    await svc.updateManualIssueDate(ADMIN, 'F1', { ...input, redateDispatches: true });
    expect(invoiceDispatch.redateInTx).toHaveBeenCalledWith(tx, ADMIN, 'F1');
    expect(tx.fiscalDocument.update.mock.invocationCallOrder[0]).toBeLessThan(
      invoiceDispatch.redateInTx.mock.invocationCallOrder[0]!,
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 60_000 });
  });

  it('sin despachos automáticos, la decisión no hace falta y no se re-fecha nada', async () => {
    const { svc, tx, invoiceDispatch } = build([{ id: 'd-2', seq: 20, atIssueDate: false }]);
    await svc.updateManualIssueDate(ADMIN, 'F1', input);
    expect(tx.fiscalDocument.update).toHaveBeenCalled();
    expect(invoiceDispatch.redateInTx).not.toHaveBeenCalled();
  });
});
