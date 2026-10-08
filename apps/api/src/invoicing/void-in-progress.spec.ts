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
interface Write {
  where: { status?: FiscalDocumentStatus; voidRequestedAt?: Date | null };
  data: { status?: FiscalDocumentStatus; voidRequestedAt?: Date | null; providerTicket?: string };
}

/**
 * La baja de punta a punta contra una factura en memoria. El `updateMany` falso respeta el estado
 * **y** `voidRequestedAt` del filtro, como Postgres: si el código dejara de filtrar por la marca de
 * su llamada, estos tests lo verían.
 */
function voidScenario(
  outcome: 'ACCEPTED' | 'PENDING' | 'ERROR' | 'REJECTED',
  opts: {
    status?: FiscalDocumentStatus;
    voidRequestedAt?: Date | null;
    /** La última acción de auditoría de bajas de la factura. */
    lastVoidAudit?: string | null;
    /** Un cobro entra durante la llamada al PSE. */
    paymentDuringCall?: boolean;
    /** Otro camino cambia la factura durante la llamada (por ejemplo, una consulta al PSE). */
    duringCall?: (state: { status: FiscalDocumentStatus; voidRequestedAt: Date | null }) => void;
  } = {},
) {
  const state = {
    status: opts.status ?? FiscalDocumentStatus.ACCEPTED,
    voidRequestedAt: opts.voidRequestedAt ?? null,
  };
  const writes: Write[] = [];
  const updateMany = jest.fn((args: Write) => {
    writes.push(args);
    const sameStatus = args.where.status === undefined || args.where.status === state.status;
    const sameMark =
      args.where.voidRequestedAt === undefined ||
      (args.where.voidRequestedAt?.getTime() ?? null) ===
        (state.voidRequestedAt?.getTime() ?? null);
    if (!sameStatus || !sameMark) return Promise.resolve({ count: 0 });
    if (args.data.status !== undefined) state.status = args.data.status;
    if (args.data.voidRequestedAt !== undefined) state.voidRequestedAt = args.data.voidRequestedAt;
    return Promise.resolve({ count: 1 });
  });
  let inCall = false;
  const pse = provider();
  const statusAtCall: FiscalDocumentStatus[] = [];
  (pse.voidDocument as jest.Mock).mockImplementation(() => {
    statusAtCall.push(state.status);
    opts.duringCall?.(state);
    inCall = true;
    return Promise.resolve({
      outcome,
      ticket: outcome === 'ACCEPTED' || outcome === 'PENDING' ? 't-1' : null,
      message: outcome === 'ERROR' ? 'timeout' : outcome === 'REJECTED' ? 'no procede' : null,
      raw: {},
    });
  });
  const audits: string[] = [];
  const read = () =>
    Promise.resolve({
      ...INVOICE,
      status: state.status,
      voidRequestedAt: state.voidRequestedAt,
      voidedById: null,
    });
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'inv-1' }]),
    customerPayment: {
      count: jest.fn(() => Promise.resolve(opts.paymentDuringCall && inCall ? 1 : 0)),
    },
    fiscalDocument: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(read),
      updateMany,
    },
  };
  const prisma = {
    fiscalDocument: { findUnique: jest.fn(read), findMany: jest.fn().mockResolvedValue([]) },
    auditLog: {
      findFirst: jest.fn(() =>
        Promise.resolve(opts.lastVoidAudit ? { action: opts.lastVoidAudit } : null),
      ),
    },
    invoicingSetting: { findFirst: jest.fn().mockResolvedValue({ providerOffline: false }) },
    $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
  const service = new InvoicingService(
    prisma as never,
    {
      write: jest.fn((_tx: unknown, entry: { action: string }) => {
        audits.push(entry.action);
        return Promise.resolve();
      }),
    } as never,
    {} as never,
    pse,
    {} as never,
    {} as never,
    { PSE_ENABLED: true } as never,
    {} as never,
  );
  jest.spyOn(service, 'findOne').mockResolvedValue({} as never);
  return { service, state, statusAtCall, writes, audits, pse };
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

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

  it('si otro camino cambió la factura durante la llamada, el error no la libera ni dice «sigue vigente»', async () => {
    const { service, state } = voidScenario('ERROR', {
      duringCall: (s) => {
        s.status = FiscalDocumentStatus.VOIDED;
      },
    });
    await expect(service.voidDocument(ACTOR, 'inv-1', 'Prueba')).rejects.toThrow(
      'cambió de estado mientras se comunicaba la baja',
    );
    expect(state.status).toBe(FiscalDocumentStatus.VOIDED);
  });

  it('un cobro durante la llamada deja la baja en trámite con el ticket del PSE y su auditoría', async () => {
    const { service, state, writes, audits } = voidScenario('ACCEPTED', {
      paymentDuringCall: true,
    });
    await expect(service.voidDocument(ACTOR, 'inv-1', 'Prueba')).rejects.toThrow(
      'Consultar al PSE',
    );
    expect(state.status).toBe(FiscalDocumentStatus.VOID_PENDING);
    expect(writes.some((w) => w.data.providerTicket === 't-1')).toBe(true);
    expect(audits).toContain('invoicing.document.void-conflict');
  });

  it('una baja que se está comunicando no se reintenta ni se consulta', async () => {
    const { service, pse } = voidScenario('ACCEPTED', {
      status: FiscalDocumentStatus.VOID_PENDING,
      voidRequestedAt: minutesAgo(1),
      lastVoidAudit: 'invoicing.document.void-requested',
    });
    await expect(service.voidDocument(ACTOR, 'inv-1', 'Prueba')).rejects.toThrow(
      'se está comunicando al PSE',
    );
    expect(pse.voidDocument).not.toHaveBeenCalled();
    // «Consultar al PSE» tampoco: un falso rechazo devolvía la factura a aceptada.
    await expect(service.refreshStatus(ACTOR, 'inv-1')).rejects.toThrow(
      'se está comunicando al PSE',
    );
    expect(pse.queryVoidStatus).not.toHaveBeenCalled();
  });

  it('una baja ya comunicada (trámite con resultado) se resuelve consultando, no reintentando', async () => {
    const { service, pse } = voidScenario('ACCEPTED', {
      status: FiscalDocumentStatus.VOID_PENDING,
      voidRequestedAt: minutesAgo(30),
      lastVoidAudit: 'invoicing.document.void',
    });
    await expect(service.voidDocument(ACTOR, 'inv-1', 'Prueba')).rejects.toThrow(
      'ya está en trámite ante SUNAT: usa «Consultar al PSE»',
    );
    expect(pse.voidDocument).not.toHaveBeenCalled();
  });

  it('una marca huérfana (la llamada se cayó y ya pasó su tiempo) se puede reintentar', async () => {
    const { service, state, statusAtCall } = voidScenario('ACCEPTED', {
      status: FiscalDocumentStatus.VOID_PENDING,
      voidRequestedAt: minutesAgo(30),
      lastVoidAudit: 'invoicing.document.void-requested',
    });
    await service.voidDocument(ACTOR, 'inv-1', 'Prueba');
    expect(statusAtCall).toEqual([FiscalDocumentStatus.VOID_PENDING]);
    expect(state.status).toBe(FiscalDocumentStatus.VOIDED);
  });

  it('el reintento de una marca huérfana que falla deja la factura aceptada', async () => {
    const { service, state } = voidScenario('ERROR', {
      status: FiscalDocumentStatus.VOID_PENDING,
      voidRequestedAt: minutesAgo(30),
      lastVoidAudit: 'invoicing.document.void-requested',
    });
    await expect(service.voidDocument(ACTOR, 'inv-1', 'Prueba')).rejects.toThrow('sigue vigente');
    expect(state.status).toBe(FiscalDocumentStatus.ACCEPTED);
    expect(state.voidRequestedAt).toBeNull();
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
