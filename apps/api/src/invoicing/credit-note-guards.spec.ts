import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  FiscalDocType,
  FiscalDocumentOrigin,
  FiscalDocumentStatus,
  Prisma,
  Role,
} from '@prisma/client';
import { assertAffectedStillCreditable, draftCreditNoteBlock } from './credit-note-guards';
import { FiscalImportService } from './fiscal-import.service';
import { InvoicingService } from './invoicing.service';
import type { ElectronicInvoicingProvider } from './ports/electronic-invoicing.port';
import type { RequestUser } from '../auth/auth.types';

/**
 * cc33 N3 — una nota de crédito en borrador y su comprobante afectado. Anular y dar de baja se
 * rechazan mientras haya un borrador; registrar o emitir la nota exige el afectado aceptado y
 * vigente, con las dos filas bloqueadas juntas.
 */
const ACTOR: RequestUser = {
  id: 'admin-1',
  email: 'admin@ayr.test',
  name: 'Admin',
  role: Role.ADMINISTRADOR,
  mustChangePassword: false,
  sessionId: 'session-1',
};

const DRAFT_NOTE = {
  issueDate: new Date('2026-10-08T00:00:00.000Z'),
  totalPen: new Prisma.Decimal('118'),
};

function provider(): ElectronicInvoicingProvider {
  return {
    name: 'fake',
    configured: true,
    fileHosts: [],
    issueDocument: jest.fn(),
    issueDispatchNote: jest.fn(),
    queryStatus: jest.fn(),
    queryVoidStatus: jest.fn(),
    voidDocument: jest.fn(),
  };
}

function invoicing(prisma: unknown, pse = provider()): InvoicingService {
  return new InvoicingService(
    prisma as never,
    { write: jest.fn() } as never,
    {} as never,
    pse,
    {} as never,
    {} as never,
    { PSE_ENABLED: true } as never,
    {} as never,
  );
}

describe('draftCreditNoteBlock', () => {
  it('nombra cada borrador con su fecha y su importe', async () => {
    const tx = { fiscalDocument: { findMany: jest.fn().mockResolvedValue([DRAFT_NOTE]) } };
    await expect(draftCreditNoteBlock(tx as never, 'inv-1', 'antes de anularlo')).resolves.toBe(
      'El comprobante tiene una nota de crédito en borrador: descarta primero el borrador (nota de crédito del 08/10/2026 por S/ 118.00) antes de anularlo',
    );
  });

  it('sin borradores no bloquea', async () => {
    const tx = { fiscalDocument: { findMany: jest.fn().mockResolvedValue([]) } };
    await expect(draftCreditNoteBlock(tx as never, 'inv-1', 'x')).resolves.toBeNull();
  });
});

describe('assertAffectedStillCreditable', () => {
  it('pasa con el afectado aceptado y vigente', () => {
    expect(() => {
      assertAffectedStillCreditable({
        number: 'F001-1',
        status: FiscalDocumentStatus.ACCEPTED,
        archivedAt: null,
      });
    }).not.toThrow();
  });

  it.each([
    [FiscalDocumentStatus.ANNULLED, null, 'anulado'],
    [FiscalDocumentStatus.VOIDED, null, 'dado de baja'],
    [FiscalDocumentStatus.REJECTED, null, 'rechazado'],
    [FiscalDocumentStatus.ACCEPTED, new Date(), 'reimportación'],
  ])('%s (archivado %s) → 409', (status, archivedAt, text) => {
    expect(() => {
      assertAffectedStillCreditable({ number: 'F001-1', status, archivedAt });
    }).toThrow(text);
  });
});

/** Un `tx` donde la nota `nc-1` afecta a `inv-1`, que está en `affectedStatus`. */
function noteTx(affectedStatus: FiscalDocumentStatus, affectedOrigin: FiscalDocumentOrigin) {
  const queryRaw = jest.fn().mockResolvedValue([{ id: 'nc-1' }, { id: 'inv-1' }]);
  return {
    queryRaw,
    tx: {
      $queryRaw: queryRaw,
      fiscalDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'nc-1',
          status: FiscalDocumentStatus.DRAFT,
          docType: FiscalDocType.NOTA_CREDITO,
          affectedDocumentId: 'inv-1',
        }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'nc-1',
          status: FiscalDocumentStatus.DRAFT,
          docType: FiscalDocType.NOTA_CREDITO,
          salesOrderId: null,
          customerId: 'c-1',
          items: [
            {
              id: 'i-1',
              qty: new Prisma.Decimal('1'),
              salesOrderItemId: null,
              affectedItemId: 'ai-1',
            },
          ],
          affectedDocument: {
            docType: FiscalDocType.FACTURA,
            origin: affectedOrigin,
            number: 'F001-00000007',
            status: affectedStatus,
            archivedAt: null,
          },
        }),
      },
    },
  };
}

describe('registrar o emitir una NC con el afectado anulado (cc33 N3)', () => {
  it('emitir (assignInTx) da 409 y bloquea nota y afectado en la misma llamada', async () => {
    const { tx, queryRaw } = noteTx(FiscalDocumentStatus.VOIDED, FiscalDocumentOrigin.ISSUED_HERE);
    const pse = provider();
    await expect(invoicing({}, pse).assignInTx(tx as never, ACTOR, 'nc-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    // Una sola ida a la puerta con los dos comprobantes.
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(queryRaw.mock.calls[0])).toContain('inv-1');
    expect(pse.issueDocument).not.toHaveBeenCalled();
  });

  it('registrar como manual da 409', async () => {
    const { tx } = noteTx(FiscalDocumentStatus.ANNULLED, FiscalDocumentOrigin.MANUAL);
    const prisma = { $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
    await expect(
      invoicing(prisma).registerManual(ACTOR, 'nc-1', { series: 'F901', correlative: 5 }),
    ).rejects.toThrow('anulado: esta nota de crédito ya no se registra ni se emite');
  });
});

describe('anular o dar de baja con una NC en borrador (cc33 N3)', () => {
  it('la anulación interna se rechaza nombrando el borrador', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'inv-1' }]),
      fiscalDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'inv-1',
          number: 'F901-00000005',
          origin: FiscalDocumentOrigin.MANUAL,
          status: FiscalDocumentStatus.ACCEPTED,
          totalPen: new Prisma.Decimal('118'),
          archivedAt: null,
        }),
        // Primero las vivas (ninguna), después los borradores.
        findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([DRAFT_NOTE]),
        update: jest.fn(),
      },
      customerPayment: { count: jest.fn().mockResolvedValue(0) },
    };
    const prisma = { $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
    const service = new FiscalImportService(prisma as never, { write: jest.fn() } as never);
    await expect(service.annulExternal(ACTOR, 'inv-1', 'Prueba')).rejects.toThrow(
      'una nota de crédito en borrador',
    );
    expect(tx.fiscalDocument.update).not.toHaveBeenCalled();
  });

  it('la baja se rechaza antes de hablar con el PSE', async () => {
    const pse = provider();
    const prisma = {
      fiscalDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'inv-1',
          docType: FiscalDocType.FACTURA,
          origin: FiscalDocumentOrigin.ISSUED_HERE,
          status: FiscalDocumentStatus.ACCEPTED,
          issueDate: new Date(),
          payments: [],
          creditNotes: [],
        }),
        findMany: jest.fn().mockResolvedValue([DRAFT_NOTE]),
      },
    };
    await expect(
      invoicing(prisma, pse).voidDocument(ACTOR, 'inv-1', 'Prueba'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(pse.voidDocument).not.toHaveBeenCalled();
  });

  /** La baja hasta la transacción final, con el PSE que la acepta y `liveNotes` notas vivas. */
  function voidAfterPse(liveNotes: number) {
    const pse = provider();
    (pse.voidDocument as jest.Mock).mockResolvedValue({
      outcome: 'ACCEPTED',
      ticket: 't-1',
      raw: {},
    });
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'inv-1' }]),
      customerPayment: { count: jest.fn().mockResolvedValue(0) },
      fiscalDocument: {
        count: jest.fn().mockResolvedValue(liveNotes),
        // Un borrador que entró durante la llamada al PSE: ya no corta la baja.
        findMany: jest.fn().mockResolvedValue([DRAFT_NOTE]),
        updateMany,
      },
    };
    const prisma = {
      fiscalDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'inv-1',
          number: 'F001-00000009',
          docType: FiscalDocType.FACTURA,
          origin: FiscalDocumentOrigin.ISSUED_HERE,
          status: FiscalDocumentStatus.ACCEPTED,
          issueDate: new Date(),
          correlative: 9,
          seriesRef: { series: 'F001' },
          payments: [],
          creditNotes: [],
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      invoicingSetting: { findFirst: jest.fn().mockResolvedValue({ providerOffline: false }) },
      $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    };
    const service = invoicing(prisma, pse);
    jest.spyOn(service, 'findOne').mockResolvedValue({} as never);
    return { service, updateMany };
  }

  it('dentro de la transacción, una nota viva que entró durante la llamada al PSE da 409', async () => {
    const { service, updateMany } = voidAfterPse(1);
    await expect(service.voidDocument(ACTOR, 'inv-1', 'Prueba')).rejects.toThrow(
      'Consultar al PSE',
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('un borrador tardío no impide registrar la baja que SUNAT ya aceptó', async () => {
    const { service, updateMany } = voidAfterPse(0);
    await service.voidDocument(ACTOR, 'inv-1', 'Prueba');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'VOIDED' }) }),
    );
  });
});
