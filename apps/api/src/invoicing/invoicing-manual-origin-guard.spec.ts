import { BadRequestException } from '@nestjs/common';
import {
  FiscalDocType,
  FiscalDocumentOrigin,
  FiscalDocumentStatus,
  Prisma,
  Role,
} from '@prisma/client';
import { InvoicingService } from './invoicing.service';
import type { ElectronicInvoicingProvider } from './ports/electronic-invoicing.port';
import type { RequestUser } from '../auth/auth.types';

/**
 * D-215/M0c: `assignInTx` nunca deja que una nota de crédito sobre un comprobante `MANUAL`
 * llegue al PSE — la rechaza antes de tomar correlativo (D-153). No había centinela para
 * esto: el handoff de F8-S7 daba el bug por vivo en `purgeInvoicingTrail` (helper de E2E) y
 * la revisión de esta sesión encontró que la causa que describía ya no existe en el código,
 * pero tampoco había un test que lo garantizara si alguien la reintrodujera.
 */
describe('InvoicingService.assignInTx — una nota de crédito de un afectado MANUAL nunca llega al PSE (D-153/D-215)', () => {
  const ACTOR: RequestUser = {
    id: 'actor-1',
    email: 'admin@ayr.test',
    name: 'Admin',
    role: Role.ADMINISTRADOR,
    mustChangePassword: false,
    sessionId: 'session-1',
  };

  function fakeProvider(): ElectronicInvoicingProvider {
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

  function fakeTx(affectedOrigin: FiscalDocumentOrigin) {
    return {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([
          { id: 'doc-1', status: FiscalDocumentStatus.DRAFT, doc_type: FiscalDocType.NOTA_CREDITO },
        ]),
      fiscalDocument: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'doc-1',
          docType: FiscalDocType.NOTA_CREDITO,
          items: [
            {
              id: 'item-1',
              qty: new Prisma.Decimal('1'),
              salesOrderItemId: null,
              affectedItemId: 'aff-item-1',
            },
          ],
          affectedDocument: {
            docType: FiscalDocType.FACTURA,
            origin: affectedOrigin,
            number: 'F001-00000001',
          },
        }),
      },
    } as unknown as Prisma.TransactionClient;
  }

  it('rechaza con 400 antes de tocar al proveedor cuando el afectado es MANUAL', async () => {
    const provider = fakeProvider();
    const service = new InvoicingService(
      {} as never,
      { write: jest.fn() } as never,
      {} as never,
      provider,
      {} as never,
      {} as never,
      { PSE_ENABLED: true } as never,
    );
    const tx = fakeTx(FiscalDocumentOrigin.MANUAL);

    await expect(service.assignInTx(tx, ACTOR, 'doc-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(provider.issueDocument).not.toHaveBeenCalled();
    expect(provider.issueDispatchNote).not.toHaveBeenCalled();
    expect(provider.queryStatus).not.toHaveBeenCalled();
    expect(provider.queryVoidStatus).not.toHaveBeenCalled();
    expect(provider.voidDocument).not.toHaveBeenCalled();
  });

  it('un afectado ISSUED_HERE sí llega a tomar correlativo (control: el guard es del origen, no de toda NC)', async () => {
    const provider = fakeProvider();
    const service = new InvoicingService(
      {} as never,
      { write: jest.fn() } as never,
      {} as never,
      provider,
      {} as never,
      {} as never,
      { PSE_ENABLED: true } as never,
    );
    const tx = fakeTx(FiscalDocumentOrigin.ISSUED_HERE);
    // `assertStillAvailable`/`allocateNumber` exigen más mocks que no son el objeto de este
    // test: alcanza con comprobar que el rechazo del guard de MANUAL no dispara acá.
    await expect(service.assignInTx(tx, ACTOR, 'doc-1')).rejects.not.toMatchObject({
      message: expect.stringContaining('es manual'),
    });
  });
});

/**
 * D-216/M0d: `PSE_ENABLED` rechaza `send()` **antes** de tocar `assertOwnership`/`assign` —
 * cero consultas, cero correlativo. A propósito el gate **no** vive en `assignInTx`: esa vía
 * también la usa el mostrador (D-099) dentro de la transacción atómica de la venta, y D-073
 * exige que la venta se complete con el PSE apagado o caído. Este test fija esa asimetría
 * para que una futura limpieza no "simplifique" moviendo el guard adentro.
 */
describe('InvoicingService.send — PSE_ENABLED (D-216)', () => {
  const ACTOR: RequestUser = {
    id: 'admin-1',
    email: 'admin@ayr.test',
    name: 'Admin',
    role: Role.ADMINISTRADOR,
    mustChangePassword: false,
    sessionId: 'session-1',
  };

  it('rechaza con 400 y no llega a assertOwnership cuando el flag está apagado', async () => {
    const prisma = { fiscalDocument: { findUnique: jest.fn() } };
    const service = new InvoicingService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { PSE_ENABLED: false } as never,
    );

    await expect(service.send(ACTOR, 'doc-1')).rejects.toMatchObject({
      message: 'Emisión electrónica no habilitada en este entorno',
    });
    expect(prisma.fiscalDocument.findUnique).not.toHaveBeenCalled();
  });
});
