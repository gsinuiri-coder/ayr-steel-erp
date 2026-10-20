import { BadRequestException, NotFoundException } from '@nestjs/common';
import { lockDocuments } from '../inventory/document-locks';
import { InvoicingService } from './invoicing.service';

jest.mock('../inventory/document-locks', () => ({
  lockDocuments: jest.fn(() => Promise.resolve({})),
}));

/**
 * cc61 (D-699): la corrección del vencimiento en el servicio, con una base falsa: bloquea antes de
 * leer, escribe solo `dueDate` y audita el antes y el después; si la regla lo rechaza, no escribe.
 */
const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const doc = (over: Record<string, unknown> = {}) => ({
  number: 'F954-00000001',
  docType: 'FACTURA',
  status: 'ACCEPTED',
  paymentTerms: 'CREDITO',
  archivedAt: null,
  issueDate: date('2026-09-11'),
  dueDate: null,
  creditNotes: [],
  ...over,
});

function setup(row: unknown) {
  const tx = {
    fiscalDocument: {
      findUnique: jest.fn(() => Promise.resolve(row)),
      update: jest.fn(() => Promise.resolve({})),
    },
  };
  const audit = { write: jest.fn(() => Promise.resolve()) };
  const self = {
    audit,
    prisma: { $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) },
    findOne: jest.fn(() => Promise.resolve({ id: 'f1', dueDate: '2026-10-11' })),
    updateDueDateInTx: InvoicingService.prototype.updateDueDateInTx,
  };
  return { tx, audit, self };
}

const updateDueDate = (self: unknown, ...args: unknown[]) =>
  (InvoicingService.prototype.updateDueDate as (...a: unknown[]) => Promise<unknown>).apply(
    self,
    args,
  );

describe('InvoicingService.updateDueDate (cc61, D-699)', () => {
  const actor = { id: 'admin' };

  it('bloquea, escribe el vencimiento y audita antes y después con el motivo', async () => {
    const { tx, audit, self } = setup(doc());
    const out = await updateDueDate(self, actor, 'f1', {
      dueDate: '2026-10-11',
      reason: 'se registró sin vencimiento',
    });
    expect(out).toEqual({ id: 'f1', dueDate: '2026-10-11' });
    expect(lockDocuments).toHaveBeenCalledWith(tx, { fiscalDocuments: ['f1'] });
    expect(tx.fiscalDocument.update).toHaveBeenCalledWith({
      where: { id: 'f1' },
      data: { dueDate: date('2026-10-11') },
    });
    expect(audit.write).toHaveBeenCalledWith(tx, {
      actorId: 'admin',
      action: 'invoicing.document.update-due-date',
      entity: 'fiscal_documents',
      entityId: 'f1',
      before: { dueDate: null },
      after: {
        dueDate: '2026-10-11',
        number: 'F954-00000001',
        reason: 'se registró sin vencimiento',
      },
      reason: 'se registró sin vencimiento',
    });
  });

  it('sin motivo, la auditoría no lo lleva', async () => {
    const { audit, self } = setup(doc({ dueDate: date('2026-09-25') }));
    await updateDueDate(self, actor, 'f1', { dueDate: '2026-10-11' });
    expect(audit.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        before: { dueDate: '2026-09-25' },
        after: { dueDate: '2026-10-11', number: 'F954-00000001' },
        reason: null,
      }),
    );
  });

  it('con una NC 13 viva rechaza y no escribe nada', async () => {
    const { tx, audit, self } = setup(
      doc({
        creditNotes: [
          {
            number: 'FC01-00000001',
            creditNoteReason: 'OTROS_AJUSTES',
            status: 'ACCEPTED',
            dueDate: date('2026-10-20'),
            issueDate: date('2026-09-20'),
            createdAt: new Date('2026-09-20T15:00:00.000Z'),
          },
        ],
      }),
    );
    await expect(updateDueDate(self, actor, 'f1', { dueDate: '2026-10-11' })).rejects.toThrow(
      BadRequestException,
    );
    expect(tx.fiscalDocument.update).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('un comprobante que no existe da 404', async () => {
    const { self } = setup(null);
    await expect(updateDueDate(self, actor, 'f1', { dueDate: '2026-10-11' })).rejects.toThrow(
      NotFoundException,
    );
  });
});
