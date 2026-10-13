import { Prisma } from '@prisma/client';
import { PurchasesService } from './purchases.service';

// Los flejes de estas pruebas no están montados en una OP: el guardrail de D-060 no aplica.
jest.mock('../production/production-assignments', () => ({
  assertStripsNotAssigned: jest.fn().mockResolvedValue(undefined),
}));

/**
 * cc51 (D-639): anular la factura del corte escribe también en la orden de corte, con el `tx` de la
 * anulación. Que el rollback se lo lleve lo prueba `purchase-audit.db-spec.ts` contra la base.
 */
const ACTOR = { id: 'u-1', role: 'ADMINISTRADOR' } as never;

function cancelling(status: 'RECEIVED' | 'DRAFT') {
  const adjust = (id: number, itemId: string, total: string) => ({
    id: BigInt(id),
    businessLineId: 'bl-1',
    itemType: 'COIL',
    itemId,
    type: 'ADJUST',
    unit: 'KGM',
    qty: new Prisma.Decimal(495),
    totalCost: new Prisma.Decimal(total),
    reversalOfId: null,
    reversals: [],
  });
  const own = [adjust(20, 'strip-1', '60.0000'), adjust(21, 'strip-2', '40.0000')];
  let movementQueries = 0;
  const tx = {
    purchase: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    supplierPayment: { count: jest.fn().mockResolvedValue(0) },
    inventoryMovement: {
      findMany: jest.fn().mockImplementation(() => {
        movementQueries++;
        return Promise.resolve(movementQueries === 1 ? own : []);
      }),
    },
    coil: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const write = jest.fn().mockResolvedValue(undefined);
  const svc = Object.create(PurchasesService.prototype) as PurchasesService;
  Object.assign(svc, {
    operationDate: { resolve: () => '2026-10-13' },
    audit: { write },
    inventory: {
      lockInOrder: jest.fn().mockResolvedValue(undefined),
      reverse: jest.fn().mockResolvedValue(undefined),
    },
    bumpCoilDocumentCost: jest.fn().mockResolvedValue(null),
    prisma: {
      purchase: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pu-9',
          status,
          type: 'SERVICE',
          serviceKind: 'CUTTING',
          supplierId: 'cutter-1',
          relatedPurchaseId: null,
          relatedCuttingOrderId: 'co-1',
          series: 'F003',
          number: '11',
          payments: [],
        }),
      },
      $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
    findOne: jest.fn().mockResolvedValue({ id: 'pu-9' }),
  });
  return { svc, tx, write };
}

describe('cancel — anular la factura del corte, en la orden de corte', () => {
  it('recibida: escribe cutting.invoice-cancelled con lo que se les quitó a los flejes', async () => {
    const { svc, tx, write } = cancelling('RECEIVED');
    await svc.cancel(ACTOR, 'pu-9', { reason: 'Factura duplicada' });
    expect(write).toHaveBeenCalledWith(tx, {
      actorId: 'u-1',
      action: 'cutting.invoice-cancelled',
      entity: 'cutting_orders',
      entityId: 'co-1',
      before: { purchaseId: 'pu-9', document: 'F003-11', supplierId: 'cutter-1' },
      after: { amountPen: '100.0000', strips: 2 },
      reason: 'Factura duplicada',
    });
    // No es un flete: la compra de bobinas no recibe nada.
    expect(write).not.toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'purchases.landed-cost-reverse' }),
    );
  });

  it('en borrador: también lo dice, sin monto', async () => {
    const { svc, tx, write } = cancelling('DRAFT');
    await svc.cancel(ACTOR, 'pu-9', { reason: 'No era de este corte' });
    expect(write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'cutting.invoice-cancelled',
        after: { amountPen: '0.0000', strips: 0 },
      }),
    );
  });
});
