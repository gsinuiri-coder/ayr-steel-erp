import { lockDocuments } from '../inventory/document-locks';
import { otherOrderDocumentsBlock, replacementLockScope } from './fiscal-import.service';

jest.mock('../inventory/document-locks', () => ({
  lockDocuments: jest.fn(() => Promise.resolve({})),
}));

/** cc61 (D-698, NC-01 de audit-02): qué bloquea y qué decide anular una NC 02, con una base falsa. */
type Tx = Parameters<typeof replacementLockScope>[0];

function fakeTx(over: {
  note?: unknown;
  dispatches?: { id: string }[];
  affected?: unknown;
  others?: { number: string | null; docType: string }[];
}) {
  return {
    fiscalDocument: {
      findUnique: jest.fn(() => Promise.resolve(over.note ?? null)),
      findUniqueOrThrow: jest.fn(() => Promise.resolve(over.affected)),
      findMany: jest.fn(() => Promise.resolve(over.others ?? [])),
    },
    dispatch: { findMany: jest.fn(() => Promise.resolve(over.dispatches ?? [])) },
  };
}

describe('replacementLockScope (cc61, D-698)', () => {
  it('una NC 02 suma los despachos del reemplazo y el pedido del original', async () => {
    const tx = fakeTx({
      note: {
        creditNoteReason: 'ANULACION_ERROR_RUC',
        affectedDocument: { id: 'f1', salesOrderId: 'p1' },
      },
      dispatches: [{ id: 'd1' }, { id: 'd2' }],
    });
    await expect(replacementLockScope(tx as unknown as Tx, 'nc')).resolves.toEqual({
      dispatchIds: ['d1', 'd2'],
      salesOrderIds: ['p1'],
    });
    expect(tx.dispatch.findMany).toHaveBeenCalledWith({
      where: { invoice: { replacesDocumentId: 'f1' } },
      select: { id: true },
    });
  });

  it('un original sin pedido no suma pedido', async () => {
    const tx = fakeTx({
      note: {
        creditNoteReason: 'ANULACION_ERROR_RUC',
        affectedDocument: { id: 'f1', salesOrderId: null },
      },
    });
    await expect(replacementLockScope(tx as unknown as Tx, 'nc')).resolves.toEqual({
      dispatchIds: [],
      salesOrderIds: [],
    });
  });

  it('otro comprobante (o una NC de otro motivo) no suma nada', async () => {
    for (const note of [
      null,
      { creditNoteReason: null, affectedDocument: null },
      {
        creditNoteReason: 'ANULACION_OPERACION',
        affectedDocument: { id: 'f1', salesOrderId: 'p1' },
      },
    ]) {
      const tx = fakeTx({ note });
      await expect(replacementLockScope(tx as unknown as Tx, 'x')).resolves.toEqual({
        dispatchIds: [],
        salesOrderIds: [],
      });
      expect(tx.dispatch.findMany).not.toHaveBeenCalled();
    }
  });
});

describe('otherOrderDocumentsBlock (cc61, D-698)', () => {
  const affected = {
    number: 'F954-00000001',
    customerId: 'cA',
    salesOrderId: 'p1',
    salesOrder: { seq: 49 },
  };

  it('sin otro comprobante del pedido, deja anular', async () => {
    const tx = fakeTx({ affected });
    await expect(otherOrderDocumentsBlock(tx as unknown as Tx, 'f1')).resolves.toBeNull();
    // Con el pedido bloqueado (ya tomado en la primera llamada: la puerta no lo repite).
    expect(lockDocuments).toHaveBeenCalledWith(tx, { salesOrders: ['p1'] });
  });

  it('con otro comprobante vigente o un borrador, rechaza nombrándolos', async () => {
    const tx = fakeTx({
      affected,
      others: [
        { number: 'F956-00000002', docType: 'FACTURA' },
        { number: null, docType: 'BOLETA' },
        { number: null, docType: 'GUIA_REMISION_REMITENTE' },
      ],
    });
    const message = await otherOrderDocumentsBlock(tx as unknown as Tx, 'f1');
    expect(message).toBe(
      'El pedido PED-000049 tiene otro comprobante vigente o en borrador (F956-00000002, boleta en borrador, guía de remisión en borrador): anúlalo antes de anular esta nota de crédito 02. Si no, F954-00000001 volvería a valer junto a él y el pedido podría quedar facturado dos veces',
    );
    // Facturas y boletas por el pedido; la guía, por el pedido de su despacho y a otro cliente.
    const call = tx.fiscalDocument.findMany.mock.calls[0] as unknown as [
      { where: { OR: unknown[] } },
    ];
    expect(call[0].where.OR).toEqual([
      { salesOrderId: 'p1', docType: { in: ['FACTURA', 'BOLETA'] } },
      {
        docType: 'GUIA_REMISION_REMITENTE',
        dispatch: { salesOrderId: 'p1' },
        customerId: { not: 'cA' },
      },
    ]);
  });

  it('un original sin pedido no tiene con qué chocar', async () => {
    const tx = fakeTx({ affected: { ...affected, salesOrderId: null, salesOrder: null } });
    await expect(otherOrderDocumentsBlock(tx as unknown as Tx, 'f1')).resolves.toBeNull();
    expect(tx.fiscalDocument.findMany).not.toHaveBeenCalled();
  });
});
