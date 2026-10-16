import { Prisma } from '@prisma/client';
import type { RequestUser } from '../auth/auth.types';
import { FiscalImportService } from './fiscal-import.service';

/**
 * cc55 (D-664, D-04 de audit-01) — anular internamente un comprobante suelta el enlace D-205 de sus
 * despachos (y lo audita), salvo el reemplazo de un 02; reactivarlo lo vuelve a poner. Base falsa;
 * contra la base, `credit-note-reasons.db-spec.ts`.
 */
const ADMIN = { id: 'u-admin', role: 'ADMINISTRADOR' } as RequestUser;

function build(o: { replacesDocumentId?: string | null; late?: boolean } = {}) {
  const invoice = {
    id: 'f-1',
    number: 'F001-00000001',
    origin: 'MANUAL',
    status: 'ACCEPTED',
    totalPen: new Prisma.Decimal('118'),
    archivedAt: null,
    creditNoteReason: null,
    affectedDocumentId: null,
    replacesDocumentId: o.replacesDocumentId ?? null,
  };
  const declared = [{ id: 'd-1', seq: 3 }];
  const tx = {
    $queryRaw: jest.fn((_s: TemplateStringsArray, ids: string[]) =>
      Promise.resolve(ids.map((id) => ({ id }))),
    ),
    fiscalDocument: {
      findUnique: jest.fn().mockResolvedValue(invoice),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ id: 'f-1', number: invoice.number }),
    },
    customerPayment: { count: jest.fn().mockResolvedValue(0) },
    dispatch: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce(declared)
        // Releído bajo lock: con `late`, apareció otro enlazado entre la lectura y el lock.
        .mockResolvedValueOnce(o.late ? [...declared, { id: 'd-2', seq: 4 }] : declared),
    },
    salesReturn: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const audit = { write: jest.fn() };
  const inventory = { unlinkInvoiceFromDispatches: jest.fn().mockResolvedValue(undefined) };
  const service = new FiscalImportService(
    { $transaction: (cb: (t: unknown) => unknown) => cb(tx) } as never,
    audit as never,
    { reverseForCreditNoteInTx: jest.fn().mockResolvedValue(null) } as never,
    inventory as never,
  );
  return { service, tx, audit, inventory };
}

const afterOf = (audit: { write: jest.Mock }) =>
  (audit.write.mock.calls[0] as unknown[])[1] as { after: Record<string, unknown> };

describe('anulación interna y el enlace de los despachos (cc55, D-664)', () => {
  it('suelta el enlace de los despachos que declara y lo deja en la auditoría', async () => {
    const { service, inventory, audit } = build();
    await service.annulExternal(ADMIN, 'f-1', 'error de tipeo');
    expect(inventory.unlinkInvoiceFromDispatches).toHaveBeenCalledWith(expect.anything(), 'f-1');
    expect(afterOf(audit).after).toMatchObject({
      dispatchesUnlinked: ['DES-000003'],
      dispatchIdsUnlinked: ['d-1'],
    });
  });

  it('un despacho enlazado entre la lectura y el lock también se bloquea y se suelta', async () => {
    const { service, tx, audit } = build({ late: true });
    await service.annulExternal(ADMIN, 'f-1', 'error de tipeo');
    // Tres tomas: el comprobante y d-1, y después d-2 (la red de D-475).
    const lockedIds = (tx.$queryRaw.mock.calls as unknown[][]).flatMap((c) => c[1] as string[]);
    expect(lockedIds).toEqual(expect.arrayContaining(['f-1', 'd-1', 'd-2']));
    expect(afterOf(audit).after).toMatchObject({ dispatchIdsUnlinked: ['d-1', 'd-2'] });
  });

  it('el reemplazo de un 02 conserva el enlace: su deshacer lo busca por ahí', async () => {
    const { service, inventory, audit } = build({ replacesDocumentId: 'f-0' });
    await service.annulExternal(ADMIN, 'f-1', 'reemplazo mal emitido');
    expect(inventory.unlinkInvoiceFromDispatches).not.toHaveBeenCalled();
    expect(afterOf(audit).after).not.toHaveProperty('dispatchesUnlinked');
  });
});

describe('reactivar vuelve a enlazar lo que la anulación soltó (revisiones de cc55, R-2)', () => {
  function relinkService(o: { ids?: unknown; candidates?: { id: string; seq: number }[] }) {
    const tx = {
      $queryRaw: jest.fn((_s: TemplateStringsArray, ids: string[]) =>
        Promise.resolve(ids.map((id) => ({ id }))),
      ),
      auditLog: {
        findFirst: jest
          .fn()
          .mockResolvedValue(
            o.ids === undefined ? null : { after: { dispatchIdsUnlinked: o.ids } },
          ),
      },
      fiscalDocument: { findUniqueOrThrow: jest.fn().mockResolvedValue({ salesOrderId: 'so-1' }) },
      dispatch: { findMany: jest.fn().mockResolvedValue(o.candidates ?? []) },
    };
    const inventory = { linkInvoiceToDispatch: jest.fn().mockResolvedValue(true) };
    const service = new FiscalImportService(
      {} as never,
      {} as never,
      {} as never,
      inventory as never,
    );
    const relink = (
      service as unknown as {
        relinkUnlinkedDispatches: (tx: unknown, id: string) => Promise<string[]>;
      }
    ).relinkUnlinkedDispatches.bind(service);
    return { relink, tx, inventory };
  }

  it('re-enlaza los vigentes y libres del mismo pedido', async () => {
    const { relink, tx, inventory } = relinkService({
      ids: ['d-1', 'd-2'],
      candidates: [{ id: 'd-1', seq: 3 }],
    });
    await expect(relink(tx, 'f-1')).resolves.toEqual(['DES-000003']);
    expect(inventory.linkInvoiceToDispatch).toHaveBeenCalledWith(tx, 'd-1', 'f-1');
    expect(tx.dispatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ invoiceId: null, status: 'ISSUED', salesOrderId: 'so-1' }),
      }),
    );
  });

  it('sin anulación registrada (o anterior a cc55) no toca nada', async () => {
    const { relink, tx, inventory } = relinkService({});
    await expect(relink(tx, 'f-1')).resolves.toEqual([]);
    const other = relinkService({ ids: 'no es lista' });
    await expect(other.relink(other.tx, 'f-1')).resolves.toEqual([]);
    expect(inventory.linkInvoiceToDispatch).not.toHaveBeenCalled();
  });
});
