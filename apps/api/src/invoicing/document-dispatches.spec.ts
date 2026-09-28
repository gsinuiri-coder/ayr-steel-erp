import {
  DispatchStatus,
  DocType,
  FiscalDocType,
  FiscalDocumentOrigin,
  FiscalDocumentStatus,
  PaymentTerms,
  Prisma,
} from '@prisma/client';
import type { FiscalDocumentQuery } from '@ayr/shared';
import { dispatchLinksByDocument } from './document-dispatches';
import { InvoicingService } from './invoicing.service';

/**
 * Correcciones 05 / M5: a qué despacho está asociado cada comprobante.
 *
 * Dos cosas que este archivo sostiene:
 * - El presupuesto: los despachos de toda la página salen de **una** consulta; el número de
 *   consultas de `GET /invoicing/documents` no depende de cuántos comprobantes se muestren.
 * - D-205: el enlace propio es `dispatches.invoice_id`; los despachos del pedido solo aparecen,
 *   en su propio campo, cuando no hay ninguno declarado.
 */

const dec = (v: string) => new Prisma.Decimal(v);
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const orderId = (i: number) => uuid(5000 + i);

function documentRow(i: number) {
  return {
    id: uuid(i),
    docType: FiscalDocType.FACTURA,
    status: FiscalDocumentStatus.ACCEPTED,
    origin: FiscalDocumentOrigin.ISSUED_HERE,
    number: `F001-${String(i).padStart(8, '0')}`,
    seriesId: null,
    seriesRef: null,
    correlative: i,
    customerId: uuid(9000),
    customer: {
      id: uuid(9000),
      name: 'Cliente',
      docType: DocType.RUC,
      docNumber: '20123456789',
      address: null,
      email: null,
      isSystem: false,
    },
    salesOrderId: orderId(i),
    salesOrder: { id: orderId(i), seq: i, sellerId: 'seller-1' },
    dispatchId: null,
    dispatch: null,
    affectedDocumentId: null,
    affectedDocument: null,
    creditNoteReason: null,
    replacesDocumentId: null,
    replacesDocument: null,
    replacedBy: null,
    supersedesDocumentId: null,
    supersededBy: null,
    archivedAt: null,
    issueDate: new Date('2026-09-20T00:00:00.000Z'),
    paymentTerms: PaymentTerms.CONTADO,
    dueDate: null,
    subtotalPen: dec('100'),
    igvPen: dec('18'),
    totalPen: dec('118'),
    detractionCode: null,
    detractionPct: null,
    detractionAmountPen: null,
    genericCustomerOverrideById: null,
    notes: null,
    sunatHash: null,
    rejectionCode: null,
    rejectionMessage: null,
    pdfKey: null,
    xmlKey: null,
    cdrKey: null,
    sendAttempts: 0,
    lastSendError: null,
    lastAttemptAt: null,
    createdById: 'user-1',
    createdAt: new Date('2026-09-20T10:00:00.000Z'),
    issuedAt: null,
    acceptedAt: null,
    voidedAt: null,
    voidedById: null,
    annulledAt: null,
    annulledById: null,
    annulReason: null,
    items: [],
    payments: [],
    creditNotes: [],
  };
}

describe('InvoicingService.findAll — despachos del comprobante sin N+1 (Correcciones 05 / M5)', () => {
  let calls: number;
  let documents: ReturnType<typeof documentRow>[];
  let dispatchFindMany: jest.Mock;
  let service: InvoicingService;

  beforeEach(() => {
    calls = 0;
    documents = [];
    const counted =
      <T>(value: () => T) =>
      () => {
        calls += 1;
        return Promise.resolve(value());
      };
    // Un despacho vivo por pedido; los pares además lo declaran contra su comprobante.
    dispatchFindMany = jest.fn(
      counted(() =>
        documents.map((d, i) => ({
          id: uuid(7000 + i),
          seq: 100 + i,
          invoiceId: i % 2 === 0 ? d.id : null,
          salesOrderId: d.salesOrderId,
        })),
      ),
    );
    const prisma = {
      fiscalDocument: {
        count: jest.fn(counted(() => documents.length)),
        findMany: jest.fn(counted(() => documents)),
      },
      invoicingSetting: {
        findFirst: jest.fn(
          counted(() => ({
            id: 'settings-1',
            providerOffline: false,
            manualByDefault: false,
            alertAfterHours: 24,
            updatedAt: new Date(),
          })),
        ),
      },
      user: { findMany: jest.fn(counted(() => [])) },
      dispatch: { findMany: dispatchFindMany },
    };
    service = new InvoicingService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  async function countFor(n: number) {
    documents = Array.from({ length: n }, (_, i) => documentRow(i + 1));
    calls = 0;
    const page = await service.findAll({ page: 1, pageSize: 50 } as FiscalDocumentQuery);
    return { calls, page };
  }

  it('las consultas no crecen con la cantidad de comprobantes de la página', async () => {
    const one = await countFor(1);
    const twenty = await countFor(20);
    expect(twenty.calls).toBe(one.calls);
    // Medido: 5 (count, página, ajustes, usuarios, despachos).
    expect(twenty.calls).toBe(5);
    expect(dispatchFindMany).toHaveBeenCalledTimes(2);
  });

  it('el declarado es propio; sin declarado, los del pedido van aparte (D-205)', async () => {
    const { page } = await countFor(2);
    const [declared, inferred] = page.items;
    expect(declared?.invoicedDispatches).toEqual([{ id: uuid(7000), code: 'DES-000100' }]);
    expect(declared?.orderDispatches).toEqual([]);
    expect(inferred?.invoicedDispatches).toEqual([]);
    expect(inferred?.orderDispatches).toEqual([{ id: uuid(7001), code: 'DES-000101' }]);
  });

  it('pide solo despachos vivos', async () => {
    await countFor(2);
    const [args] = dispatchFindMany.mock.calls.at(-1) as [{ where: Prisma.DispatchWhereInput }];
    expect(args.where.status).toBe(DispatchStatus.ISSUED);
  });
});

describe('dispatchLinksByDocument', () => {
  it('una guía de remisión no busca despachos: el suyo es `dispatchId`', async () => {
    const findMany = jest.fn();
    const out = await dispatchLinksByDocument({ dispatch: { findMany } } as never, [
      {
        id: 'g-1',
        docType: FiscalDocType.GUIA_REMISION_REMITENTE,
        salesOrderId: 'o-1',
        dispatchId: 'd-9',
        dispatchCode: 'DES-000009',
      },
    ]);
    expect(findMany).not.toHaveBeenCalled();
    expect(out.get('g-1')).toEqual({
      invoicedDispatches: [{ id: 'd-9', code: 'DES-000009' }],
      orderDispatches: [],
    });
  });

  it('sin pedido y sin declarado, no hay nada que mostrar', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const out = await dispatchLinksByDocument({ dispatch: { findMany } } as never, [
      { id: 'b-1', docType: FiscalDocType.BOLETA, salesOrderId: null },
    ]);
    expect(out.get('b-1')).toEqual({ invoicedDispatches: [], orderDispatches: [] });
  });
});
