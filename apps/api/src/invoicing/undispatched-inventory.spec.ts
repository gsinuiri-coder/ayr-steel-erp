import { Decimal } from '@ayr/shared';
import * as receivedDateFix from '../purchases/purchase-received-date-fix';
import type { ReceivedDateCase } from '../purchases/purchase-received-date-fix';
import type { InvoiceDispatchPlan } from './invoice-dispatch.service';
import type { PlannedInvoice } from './invoice-dispatch-plan';
import {
  assertInspectionArgs,
  classifyUndispatchedInvoice,
  countUndispatchedByStatus,
  inspectUndispatchedInvoices,
} from './undispatched-inventory';

const itemKey = 'PRODUCT:producto-1';
const invoice = (action: PlannedInvoice['lines'][number]['action']): PlannedInvoice => ({
  invoiceId: 'comprobante-1',
  number: 'FFA1-1',
  salesOrderId: 'pedido-1',
  issueDate: '2026-08-20',
  lines: [
    {
      orderItemId: 'linea-1',
      lineNumber: 1,
      sku: 'SKU1',
      qty: new Decimal(1),
      reserveQty: new Decimal(1),
      itemKey,
      action,
      operationDate: '2026-08-20',
      reason: action === 'REVIEW' ? 'Una salida deja el kardex negativo el 2026-08-20' : null,
      firstValidDate: null,
    },
  ],
});
const plan = (action: PlannedInvoice['lines'][number]['action']): InvoiceDispatchPlan => ({
  invoices: [{ ...invoice(action), orderCode: 'PED-1', sellerId: null }],
  items: new Map(),
});
const purchase = (safe: boolean, reasons: string[] = []): ReceivedDateCase => ({
  purchaseId: 'compra-1',
  document: 'E001-1',
  type: 'FINISHED_GOOD',
  currentDate: '2026-09-27',
  destinationDate: '2026-08-20',
  currentReceivedAt: '2026-09-28T00:00:00.000Z',
  movementIds: ['42'],
  items: [{ key: itemKey, qty: '1', currentDate: '2026-09-27' }],
  safe,
  reasons,
});

describe('inventario de comprobantes sin despacho', () => {
  afterEach(() => jest.restoreAllMocks());

  it('rechaza --execute incluso antes de consultar la base', () => {
    expect(() => {
      assertInspectionArgs(['--execute']);
    }).toThrow('solo lectura');
    expect(() => {
      assertInspectionArgs(['--undo', 'lote']);
    }).toThrow('solo lectura');
    expect(() => {
      assertInspectionArgs([]);
    }).not.toThrow();
  });

  it('cuenta ANNULLED y VOIDED aparte, sin incluirlos en el aviso sin despacho', () => {
    const counts = countUndispatchedByStatus(
      [
        { status: 'ACCEPTED', items: [{}], dispatchesInvoiced: [] },
        { status: 'ANNULLED', items: [{}], dispatchesInvoiced: [] },
        { status: 'VOIDED', items: [{}], dispatchesInvoiced: [] },
      ],
      [{ status: 'ACCEPTED' }],
    );
    expect(counts).toEqual([
      { status: 'ACCEPTED', documents: 1, pending: 1, withoutDeclaredDispatch: 1 },
      { status: 'ANNULLED', documents: 1, pending: 0, withoutDeclaredDispatch: 0 },
      { status: 'VOIDED', documents: 1, pending: 0, withoutDeclaredDispatch: 0 },
    ]);
  });

  it('clasifica como DESPACHABLE cuando firstNegativeDate ya permite todas las líneas', async () => {
    const simulate = jest.fn();
    await expect(
      classifyUndispatchedInvoice(invoice('DISPATCH'), [], new Map(), simulate),
    ).resolves.toEqual({ verdict: 'DESPACHABLE', purchases: [] });
    expect(simulate).not.toHaveBeenCalled();
  });

  it('reusa una compra segura solo si el plan de dominio simulado se desbloquea', async () => {
    const candidate = purchase(true);
    const simulate = jest.fn().mockResolvedValue(plan('DISPATCH'));
    await expect(
      classifyUndispatchedInvoice(invoice('REVIEW'), [candidate], new Map(), simulate),
    ).resolves.toEqual({ verdict: 'BLOQUEADO-FECHA-COMPRA', purchases: [candidate] });
    expect(simulate).toHaveBeenCalledWith([candidate]);
  });

  it('separa apertura sin compras de compra excluida por salida posterior', async () => {
    await expect(
      classifyUndispatchedInvoice(
        invoice('REVIEW'),
        [],
        new Map([[itemKey, new Set(['IMPORT'])]]),
        jest.fn(),
      ),
    ).resolves.toMatchObject({ verdict: 'BLOQUEADO-APERTURA' });
    await expect(
      classifyUndispatchedInvoice(
        invoice('REVIEW'),
        [purchase(false, ['Salida posterior: mover la entrada puede recostearla'])],
        new Map(),
        jest.fn(),
      ),
    ).resolves.toMatchObject({ verdict: 'BLOQUEADO-RECOSTEO' });
  });

  it('no fuerza una causa ajena a las cuatro categorías', async () => {
    await expect(
      classifyUndispatchedInvoice(invoice('REVIEW'), [], new Map(), jest.fn()),
    ).rejects.toThrow('fuera de las cuatro clases');
  });

  it('inspecciona un pendiente y prueba la compra segura con el mismo plan de dominio', async () => {
    jest.spyOn(receivedDateFix, 'planPurchaseReceivedDates').mockResolvedValue([purchase(true)]);
    const tx = {
      fiscalDocument: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'comprobante-1', status: 'ACCEPTED', items: [{}], dispatchesInvoiced: [] },
          { id: 'anulado-1', status: 'ANNULLED', items: [{}], dispatchesInvoiced: [] },
        ]),
      },
      inventoryMovement: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ itemType: 'PRODUCT', itemId: 'producto-1', refType: 'PURCHASE' }]),
      },
    };
    const dispatch = {
      buildPlan: jest.fn(
        (_tx: unknown, _where: unknown, sim?: { movedPurchaseEntries?: Map<string, string> }) =>
          Promise.resolve(
            plan(sim?.movedPurchaseEntries?.get('42') === '2026-08-20' ? 'DISPATCH' : 'REVIEW'),
          ),
      ),
    };

    const result = await inspectUndispatchedInvoices(tx as never, dispatch as never, 'demo');

    expect(tx.fiscalDocument.findMany).toHaveBeenCalledWith({
      where: { docType: { in: ['FACTURA', 'BOLETA'] }, archivedAt: null },
      select: expect.objectContaining({
        status: true,
        items: { where: { salesOrderItemId: { not: null } }, select: { id: true } },
        dispatchesInvoiced: { where: { status: 'ISSUED' }, select: { id: true } },
      }),
    });
    expect(tx.inventoryMovement.findMany).toHaveBeenCalledWith({
      where: { itemId: { in: ['producto-1'] }, type: 'IN' },
      select: { itemType: true, itemId: true, refType: true },
    });
    expect(dispatch.buildPlan).toHaveBeenNthCalledWith(
      2,
      tx,
      {},
      {
        movedPurchaseEntries: new Map([['42', '2026-08-20']]),
      },
    );
    expect(result).toMatchObject({
      branch: 'demo',
      counts: [
        { status: 'ACCEPTED', documents: 1, pending: 1, withoutDeclaredDispatch: 1 },
        { status: 'ANNULLED', documents: 1, pending: 0, withoutDeclaredDispatch: 0 },
        { status: 'VOIDED', documents: 0, pending: 0, withoutDeclaredDispatch: 0 },
      ],
      rows: [
        {
          number: 'FFA1-1',
          issueDate: '2026-08-20',
          status: 'ACCEPTED',
          verdict: 'BLOQUEADO-FECHA-COMPRA',
          purchases: [{ id: 'compra-1', document: 'E001-1' }],
          lines: [{ sku: 'SKU1', qty: '1.000', action: 'REVIEW' }],
        },
      ],
    });
    expect(Date.parse(result.snapshotUtc)).not.toBeNaN();
  });

  it('sin pendientes no busca movimientos y conserva el conteo de estados', async () => {
    jest.spyOn(receivedDateFix, 'planPurchaseReceivedDates').mockResolvedValue([]);
    const tx = {
      fiscalDocument: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'anulado-1', status: 'ANNULLED', items: [{}], dispatchesInvoiced: [] },
          ]),
      },
      inventoryMovement: { findMany: jest.fn() },
    };
    const dispatch = { buildPlan: jest.fn().mockResolvedValue({ invoices: [], items: new Map() }) };

    const result = await inspectUndispatchedInvoices(tx as never, dispatch as never, 'demo');

    expect(tx.inventoryMovement.findMany).not.toHaveBeenCalled();
    expect(result.rows).toEqual([]);
    expect(result.counts).toContainEqual({
      status: 'ANNULLED',
      documents: 1,
      pending: 0,
      withoutDeclaredDispatch: 0,
    });
  });

  it('se detiene si un pendiente no tiene estado en la foto leída', async () => {
    jest.spyOn(receivedDateFix, 'planPurchaseReceivedDates').mockResolvedValue([]);
    const tx = {
      fiscalDocument: { findMany: jest.fn().mockResolvedValue([]) },
      inventoryMovement: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const dispatch = { buildPlan: jest.fn().mockResolvedValue(plan('DISPATCH')) };

    await expect(
      inspectUndispatchedInvoices(tx as never, dispatch as never, 'demo'),
    ).rejects.toThrow('Estado ausente para FFA1-1');
  });
});
