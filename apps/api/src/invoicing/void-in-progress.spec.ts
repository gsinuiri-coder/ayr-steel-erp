import { BadRequestException, ConflictException } from '@nestjs/common';
import { FiscalDocType, FiscalDocumentOrigin, FiscalDocumentStatus, Role } from '@prisma/client';
import { assertAffectedStillCreditable } from './credit-note-guards';
import { InvoicingService } from './invoicing.service';
import type { ElectronicInvoicingProvider } from './ports/electronic-invoicing.port';
import type { RequestUser } from '../auth/auth.types';

/**
 * cc34 — arreglo de fondo de D-536: **la baja ante SUNAT en trámite.** Antes de llamar al PSE la
 * factura queda `VOID_PENDING` en su propia transacción; mientras esté así no se crea, registra ni
 * envía una nota de crédito sobre ella. Si la llamada falla o el PSE la rechaza, la marca se quita
 * y la factura vuelve a estar aceptada.
 */
const ACTOR: RequestUser = {
  id: 'admin-1',
  email: 'admin@ayr.test',
  name: 'Admin',
  role: Role.ADMINISTRADOR,
  mustChangePassword: false,
  sessionId: 'session-1',
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

const INVOICE = {
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
};

/** La baja de punta a punta, con el PSE devolviendo `outcome` y el estado de la factura en memoria. */
function voidScenario(outcome: 'ACCEPTED' | 'PENDING' | 'ERROR' | 'REJECTED') {
  const state = { status: FiscalDocumentStatus.ACCEPTED as FiscalDocumentStatus };
  const writes: { where: unknown; data: { status?: FiscalDocumentStatus } }[] = [];
  const updateMany = jest.fn(
    (args: {
      where: { status?: FiscalDocumentStatus };
      data: { status?: FiscalDocumentStatus };
    }) => {
      writes.push(args);
      if (args.where.status !== undefined && args.where.status !== state.status) {
        return Promise.resolve({ count: 0 });
      }
      if (args.data.status !== undefined) state.status = args.data.status;
      return Promise.resolve({ count: 1 });
    },
  );
  const pse = provider();
  const statusAtCall: FiscalDocumentStatus[] = [];
  (pse.voidDocument as jest.Mock).mockImplementation(() => {
    statusAtCall.push(state.status);
    return Promise.resolve({
      outcome,
      ticket: outcome === 'ACCEPTED' || outcome === 'PENDING' ? 't-1' : null,
      message: outcome === 'ERROR' ? 'timeout' : outcome === 'REJECTED' ? 'no procede' : null,
      raw: {},
    });
  });
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'inv-1' }]),
    customerPayment: { count: jest.fn().mockResolvedValue(0) },
    fiscalDocument: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(() => Promise.resolve({ ...INVOICE, status: state.status })),
      updateMany,
    },
  };
  const prisma = {
    fiscalDocument: {
      findUnique: jest.fn(() => Promise.resolve({ ...INVOICE, status: state.status })),
      findMany: jest.fn().mockResolvedValue([]),
    },
    invoicingSetting: { findFirst: jest.fn().mockResolvedValue({ providerOffline: false }) },
    $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
  const service = new InvoicingService(
    prisma as never,
    { write: jest.fn() } as never,
    {} as never,
    pse,
    {} as never,
    {} as never,
    { PSE_ENABLED: true } as never,
    {} as never,
  );
  jest.spyOn(service, 'findOne').mockResolvedValue({} as never);
  return { service, state, statusAtCall, writes };
}

describe('baja en trámite (cc34, D-536 de fondo)', () => {
  it('la factura queda VOID_PENDING antes de llamar al PSE', async () => {
    const { service, statusAtCall, state } = voidScenario('ACCEPTED');
    await service.voidDocument(ACTOR, 'inv-1', 'Prueba');
    expect(statusAtCall).toEqual([FiscalDocumentStatus.VOID_PENDING]);
    expect(state.status).toBe(FiscalDocumentStatus.VOIDED);
  });

  it('PENDING: queda en trámite con su ticket', async () => {
    const { service, state } = voidScenario('PENDING');
    await service.voidDocument(ACTOR, 'inv-1', 'Prueba');
    expect(state.status).toBe(FiscalDocumentStatus.VOID_PENDING);
  });

  it('una baja fallida (error del PSE) libera la factura', async () => {
    const { service, state, writes } = voidScenario('ERROR');
    await expect(service.voidDocument(ACTOR, 'inv-1', 'Prueba')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(state.status).toBe(FiscalDocumentStatus.ACCEPTED);
    // Se quita la marca solo si sigue puesta: nunca se pisa otro estado.
    expect(writes.at(-1)).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({ status: FiscalDocumentStatus.VOID_PENDING }),
        data: expect.objectContaining({ status: FiscalDocumentStatus.ACCEPTED }),
      }),
    );
  });

  it('una baja rechazada por el PSE también libera la factura', async () => {
    const { service, state } = voidScenario('REJECTED');
    await expect(service.voidDocument(ACTOR, 'inv-1', 'Prueba')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(state.status).toBe(FiscalDocumentStatus.ACCEPTED);
  });

  it('con la baja en trámite, crear una nota de crédito se rechaza con el motivo', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'inv-1' }]),
      fiscalDocument: {
        findUnique: jest.fn().mockResolvedValue({
          ...INVOICE,
          status: FiscalDocumentStatus.VOID_PENDING,
          items: [],
          customer: {},
          salesOrder: null,
          dispatch: null,
          createdById: 'admin-1',
        }),
      },
    };
    const prisma = { $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
    const service = new InvoicingService(
      prisma as never,
      { write: jest.fn() } as never,
      {} as never,
      provider(),
      { assertIssueDate: jest.fn() } as never,
      {} as never,
      { PSE_ENABLED: true } as never,
      {} as never,
    );
    await expect(
      service.createCreditNote(ACTOR, 'inv-1', {
        reason: 'ANULACION_OPERACION',
        description: 'x',
        issueDate: '2026-10-08',
        items: [],
      } as never),
    ).rejects.toThrow('F001-00000009 tiene la baja en trámite ante SUNAT');
  });

  it('con la baja en trámite, registrar o emitir una nota de crédito se rechaza sin pedir descartarla', () => {
    expect(() => {
      assertAffectedStillCreditable({
        number: 'F001-00000009',
        status: FiscalDocumentStatus.VOID_PENDING,
        archivedAt: null,
      });
    }).toThrow(
      'F001-00000009 tiene la baja en trámite ante SUNAT: espera a que SUNAT la confirme o la rechace antes de registrar o emitir esta nota de crédito',
    );
  });
});
