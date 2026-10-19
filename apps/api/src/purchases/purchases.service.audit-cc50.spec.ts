import { ExchangeRateSource, Prisma } from '@prisma/client';
import { Decimal, type CreatePurchaseInput } from '@ayr/shared';
import { PurchasesService } from './purchases.service';

// Las bobinas de estas pruebas no tienen flejes montados: el guardrail de D-060 no aplica.
jest.mock('../production/production-assignments', () => ({
  assertStripsNotAssigned: jest.fn().mockResolvedValue(undefined),
}));

/**
 * cc50 (D-638): cada servicio escribe el registro en el documento cuyo «Historial» lo muestra, con
 * el `tx` de su operación. Con mocks: qué registro se escribe y en qué transacción. Que el rollback
 * se lo lleve lo prueba `purchase-audit.db-spec.ts` contra la base.
 */
const ACTOR = { id: 'u-1', role: 'ADMINISTRADOR' } as never;

describe('createInTx — la factura del corte, en la orden de corte', () => {
  const INPUT: CreatePurchaseInput = {
    supplierId: 'sup-1',
    businessLine: 'drywall',
    type: 'SERVICE',
    serviceKind: 'CUTTING',
    relatedCuttingOrderId: 'co-1',
    docType: 'FACTURA',
    series: 'F002',
    number: '7',
    issueDate: '2026-10-12',
    currency: 'PEN',
    igvRate: '18.0000',
    paymentTerms: 'CONTADO',
    items: [{ description: 'Corte', qty: '1', unit: 'ZZ', unitPrice: '300.0000' }],
  };

  it('escribe cutting.invoice-linked con el tx del alta', async () => {
    const tx = {
      supplier: { findUnique: jest.fn().mockResolvedValue({ id: 'sup-1', isActive: true }) },
      businessLine: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'bl-1', code: 'DRYWALL', inventoryStrategy: 'STOCK' }),
      },
      cuttingOrder: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'co-1', status: 'SENT', businessLineId: 'bl-1' }),
      },
      purchase: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({
          id: 'pu-9',
          supplierId: 'sup-1',
          type: 'SERVICE',
          series: 'F002',
          number: '7',
          total: new Prisma.Decimal('354'),
          subtotal: new Prisma.Decimal('300'),
          currency: 'PEN',
          importBatchId: null,
          relatedCuttingOrderId: 'co-1',
        }),
      },
    };
    const write = jest.fn().mockResolvedValue(undefined);
    const svc = Object.create(PurchasesService.prototype) as PurchasesService;
    Object.assign(svc, { audit: { write } });
    await svc.createInTx(tx as never, ACTOR, INPUT, {
      rate: new Decimal(1),
      source: ExchangeRateSource.MANUAL,
    });
    expect(write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'cutting.invoice-linked',
        entity: 'cutting_orders',
        entityId: 'co-1',
        after: expect.objectContaining({
          purchaseId: 'pu-9',
          document: 'F002-7',
          subtotal: '300.0000',
        }),
      }),
    );
  });
});

describe('reversePayment — la reversa, en la compra', () => {
  it('escribe purchases.payment-reverse con el tx de la reversa', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      purchase: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pu-1',
          status: 'RECEIVED',
          supplierId: 'sup-1',
          series: 'F001',
          number: '123',
        }),
      },
      supplierPayment: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'pay-1',
          amount: new Prisma.Decimal('100'),
          currency: 'PEN',
          method: 'TRANSFER',
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const write = jest.fn().mockResolvedValue(undefined);
    const svc = Object.create(PurchasesService.prototype) as PurchasesService;
    Object.assign(svc, {
      audit: { write },
      prisma: { $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) },
    });
    jest.spyOn(svc, 'findOne').mockResolvedValue({} as never);
    await svc.reversePayment(ACTOR, 'pu-1', 'pay-1', { reason: 'Pago duplicado' });
    expect(write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'purchases.payment-reverse',
        entity: 'purchases',
        entityId: 'pu-1',
        before: expect.objectContaining({ paymentId: 'pay-1', amount: '100.0000' }),
      }),
    );
  });
});

describe('cancel — anular el flete deja la reversa en la compra de bobinas', () => {
  it('suma los ajustes de costo revertidos y escribe purchases.landed-cost-reverse', async () => {
    const adjust = (id: number, itemId: string, total: string) => ({
      id: BigInt(id),
      businessLineId: 'bl-1',
      itemType: 'COIL',
      itemId,
      type: 'ADJUST',
      unit: 'KGM',
      qty: new Prisma.Decimal(500),
      totalCost: new Prisma.Decimal(total),
      reversalOfId: null,
      reversals: [],
    });
    const own = [adjust(10, 'coil-1', '50.0000'), adjust(11, 'coil-2', '30.0000')];
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
      operationDate: { resolve: () => '2026-10-12' },
      audit: { write },
      inventory: {
        lockInOrder: jest.fn().mockResolvedValue(undefined),
        reverse: jest.fn().mockResolvedValue(undefined),
      },
      bumpCoilDocumentCost: jest.fn().mockResolvedValue(null),
      prisma: {
        purchase: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'pu-3',
            status: 'RECEIVED',
            type: 'SERVICE',
            serviceKind: 'FREIGHT',
            relatedPurchaseId: 'pu-2',
            series: 'F002',
            number: '7',
            payments: [],
          }),
        },
        $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      },
      findOne: jest.fn().mockResolvedValue({ id: 'pu-3' }),
    });

    await svc.cancel(ACTOR, 'pu-3', { reason: 'Flete equivocado' });
    expect(write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'purchases.landed-cost-reverse',
        entity: 'purchases',
        entityId: 'pu-2',
        before: { amountPen: '80.0000', coils: 2 },
        reason: 'Flete equivocado',
      }),
    );
  });
});

describe('applyLandedCost — el costo, en la compra de bobinas que lo recibe', () => {
  const service = {
    id: 'pu-3',
    type: 'SERVICE',
    serviceKind: 'FREIGHT',
    relatedPurchaseId: 'pu-2',
    series: 'F002',
    number: '7',
    subtotal: new Prisma.Decimal('80'),
    exchangeRate: new Prisma.Decimal('1'),
  };
  const related = { id: 'pu-2', status: 'RECEIVED', series: 'F001', number: '9' };

  function setup(coils: { id: string; code: string; businessLineId: string }[]) {
    const tx = {
      purchase: { findUnique: jest.fn().mockResolvedValue(related) },
      coil: { findMany: jest.fn().mockResolvedValue(coils) },
      // cc58 (D-686): la entrada de cada bobina, que recibe el costo por recosteo.
      inventoryMovement: {
        findMany: jest.fn().mockResolvedValue(
          coils.map((c, i) => ({
            id: BigInt(i + 1),
            itemId: c.id,
            qty: new Prisma.Decimal(500),
          })),
        ),
      },
    };
    const write = jest.fn().mockResolvedValue(undefined);
    const svc = Object.create(PurchasesService.prototype) as PurchasesService;
    Object.assign(svc, {
      audit: { write },
      inventory: {
        recostEntries: jest.fn().mockResolvedValue({ pending: false, adjusted: [] }),
      },
      bumpCoilDocumentCost: jest.fn().mockResolvedValue({ from: '4.0000', to: '4.1600' }),
    });
    const apply = (
      svc as unknown as {
        applyLandedCost: (
          tx: unknown,
          purchase: unknown,
          actor: unknown,
          date: string,
        ) => Promise<{ imputed: boolean; relatedDocument: string } | null>;
      }
    ).applyLandedCost.bind(svc);
    return { tx, write, run: () => apply(tx, service, ACTOR, '2026-10-12') };
  }

  it('con bobinas imputadas escribe purchases.landed-cost con el tx de la recepción', async () => {
    const s = setup([{ id: 'c1', code: 'C1', businessLineId: 'bl-1' }]);
    const result = await s.run();
    expect(result).toMatchObject({ imputed: true, relatedDocument: 'F001-9' });
    expect(s.write).toHaveBeenCalledWith(
      s.tx,
      expect.objectContaining({
        action: 'purchases.landed-cost',
        entity: 'purchases',
        entityId: 'pu-2',
        after: expect.objectContaining({ serviceDocument: 'F002-7', amountPen: '80.0000' }),
      }),
    );
  });

  it('sin bobinas no imputa ni escribe el registro de la compra de bobinas', async () => {
    const s = setup([]);
    const result = await s.run();
    expect(result).toMatchObject({ imputed: false, relatedDocument: 'F001-9' });
    expect(s.write).not.toHaveBeenCalled();
  });
});
