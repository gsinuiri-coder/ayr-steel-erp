import { Prisma } from '@prisma/client';
import type { RequestUser } from '../auth/auth.types';
import { FiscalImportService } from './fiscal-import.service';

/**
 * cc54 (D-655, D-656) — anular una NC: la 02 con su reemplazo anulado devuelve el despacho y el
 * cliente del pedido; la que devolvió mercadería no se anula con el pedido ya anulado.
 */
const ADMIN = { id: 'u-admin', role: 'ADMINISTRADOR' } as RequestUser;

function build(o: { reason: string; liveReplacement?: boolean; cancelledOrder?: boolean }) {
  const note = {
    id: 'nc-1',
    number: 'FC01-00000045',
    origin: 'MANUAL',
    status: 'ACCEPTED',
    totalPen: new Prisma.Decimal('295'),
    archivedAt: null,
    creditNoteReason: o.reason,
    affectedDocumentId: 'f-1',
  };
  const tx = {
    $queryRaw: jest.fn((_s: TemplateStringsArray, ids: string[]) =>
      Promise.resolve(ids.map((id) => ({ id }))),
    ),
    fiscalDocument: {
      findUnique: jest.fn().mockResolvedValue(note),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          'status' in where
            ? o.liveReplacement
              ? { number: 'F002-00000009' }
              : null
            : { id: 'rep-1', number: 'F002-00000009' },
        ),
      ),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        number: 'F001-00000001',
        customerId: 'c-1',
        salesOrderId: 'so-1',
        customer: { name: 'Cliente original' },
      }),
      update: jest.fn().mockResolvedValue({ id: 'nc-1', number: note.number }),
    },
    customerPayment: { count: jest.fn().mockResolvedValue(0) },
    dispatch: { findMany: jest.fn().mockResolvedValue([{ id: 'd-1' }]) },
    salesOrder: {
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ customerId: 'c-2', customer: { name: 'Cliente correcto' } }),
      update: jest.fn().mockResolvedValue({}),
    },
    salesReturn: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          o.cancelledOrder ? { salesOrder: { status: 'CANCELLED', seq: 7 } } : null,
        ),
    },
  };
  const audit = { write: jest.fn() };
  const inventory = { moveInvoiceDispatches: jest.fn().mockResolvedValue(1) };
  const salesReturns = { reverseForCreditNoteInTx: jest.fn().mockResolvedValue(null) };
  const service = new FiscalImportService(
    { $transaction: (cb: (t: unknown) => unknown) => cb(tx) } as never,
    audit as never,
    salesReturns as never,
    inventory as never,
  );
  return { service, tx, audit, inventory };
}

describe('anular una NC (cc54)', () => {
  it('02 con el reemplazo vivo: no se anula', async () => {
    const { service } = build({ reason: 'ANULACION_ERROR_RUC', liveReplacement: true });
    await expect(service.annulExternal(ADMIN, 'nc-1', 'prueba')).rejects.toThrow(
      'reemplazo vivo (F002-00000009)',
    );
  });

  it('02 con el reemplazo anulado: vuelven el despacho y el cliente del pedido', async () => {
    const { service, tx, inventory, audit } = build({ reason: 'ANULACION_ERROR_RUC' });
    await service.annulExternal(ADMIN, 'nc-1', 'prueba');
    expect(inventory.moveInvoiceDispatches).toHaveBeenCalledWith(expect.anything(), 'rep-1', 'f-1');
    expect(tx.salesOrder.update).toHaveBeenCalledWith({
      where: { id: 'so-1' },
      data: { customerId: 'c-1' },
    });
    const actions = (audit.write.mock.calls as unknown[][]).map(
      (c) => (c[1] as { action: string }).action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'sales.order.customer',
        'invoicing.credit-note.replacement-undone',
        'invoicing.import.annul',
      ]),
    );
  });

  it('con la devolución vigente y el pedido anulado: no se anula', async () => {
    const { service, tx } = build({ reason: 'ANULACION_OPERACION', cancelledOrder: true });
    await expect(service.annulExternal(ADMIN, 'nc-1', 'prueba')).rejects.toThrow(
      'PED-000007 está anulado',
    );
    expect(tx.fiscalDocument.update).not.toHaveBeenCalled();
  });
});
