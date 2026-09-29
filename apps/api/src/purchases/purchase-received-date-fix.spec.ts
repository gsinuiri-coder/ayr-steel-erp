import { Prisma, type InventoryMovement } from '@prisma/client';
import type { InventoryService } from '../inventory/inventory.service';
import type { AuditService } from '../audit/audit.service';
import {
  classifyReceivedDate,
  selectSafeCases,
  undoPurchaseReceivedDates,
  type MovementForClassification,
} from './purchase-received-date-fix';

const target = {
  id: 'purchase-1',
  type: 'FINISHED_GOOD' as const,
  series: 'F001',
  number: '1',
  issueDate: new Date('2026-08-20T00:00:00Z'),
  receivedAt: new Date('2026-09-28T00:00:00Z'),
};
const entry = (over: Partial<MovementForClassification> = {}): MovementForClassification => ({
  id: 1n,
  itemType: 'PRODUCT',
  itemId: 'product-1',
  type: 'IN',
  refType: 'PURCHASE',
  refId: target.id,
  qty: new Prisma.Decimal('4'),
  operationDate: new Date('2026-09-27T00:00:00Z'),
  reversalOfId: null,
  ...over,
});

describe('clasificación de fechas recibidas', () => {
  it('incluye una entrada limpia sin salida ni apertura intermedia', () => {
    const m = entry();
    expect(classifyReceivedDate(target, [m], [m])).toMatchObject({
      safe: true,
      destinationDate: '2026-08-20',
    });
  });

  it('excluye si una salida posterior puede recostearse', () => {
    const m = entry();
    const out = entry({
      id: 2n,
      type: 'OUT',
      refType: 'SALE',
      refId: 'sale-1',
      qty: new Prisma.Decimal('1'),
      operationDate: new Date('2026-09-28T00:00:00Z'),
    });
    expect(classifyReceivedDate(target, [m], [m, out])).toMatchObject({
      safe: false,
      reasons: [expect.stringContaining('recostearla')],
    });
  });

  it('excluye una compra anterior a la apertura del mismo ítem', () => {
    const m = entry();
    const opening = entry({
      id: 2n,
      refType: 'IMPORT',
      refId: null,
      operationDate: new Date('2026-09-15T00:00:00Z'),
    });
    expect(classifyReceivedDate(target, [m], [m, opening])?.reasons).toContain(
      'Apertura posterior a la fecha destino: posible stock duplicado',
    );
  });

  it('rechaza un id explícito fuera del conjunto seguro', () => {
    const m = entry();
    const c = classifyReceivedDate(target, [m], [m])!;
    expect(() => selectSafeCases([c], ['otra-compra'])).toThrow('no pertenece');
    expect(() =>
      selectSafeCases([{ ...c, safe: false, reasons: ['salida'] }], [target.id]),
    ).toThrow('excluida');
  });
});

describe('undo de lote', () => {
  it('reversa la nueva entrada, reingresa en la fecha original y restaura receivedAt exacto', async () => {
    const batchId = '785e282e-9713-4a1f-a817-9f6b941be6e4';
    const oldReceivedAt = '2026-09-28T00:23:29.921Z';
    const movement = {
      ...entry(),
      businessLineId: 'line-1',
      unit: 'NIU',
      unitCost: new Prisma.Decimal('2'),
      totalCost: new Prisma.Decimal('8'),
    } as InventoryMovement;
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'balance' }]),
      auditLog: {
        findMany: jest.fn().mockResolvedValue([
          {
            after: {
              batchId,
              purchaseId: target.id,
              movementIds: ['3'],
              oldMovementIds: ['1'],
              destinationDate: '2026-08-20',
              currentDate: '2026-09-27',
              oldReceivedAt,
            },
          },
        ]),
        count: jest.fn().mockResolvedValue(0),
      },
      purchase: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ receivedAt: new Date('2026-08-20T05:00:00Z') }),
        update: jest.fn().mockResolvedValue({}),
      },
      inventoryMovement: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(movement),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      coil: { update: jest.fn() },
    };
    const inventory = {
      reverse: jest.fn().mockResolvedValue({}),
      record: jest.fn().mockResolvedValue({}),
    };
    const audit = { write: jest.fn().mockResolvedValue({}) };
    await expect(
      undoPurchaseReceivedDates(
        tx as unknown as Prisma.TransactionClient,
        inventory as unknown as InventoryService,
        audit as unknown as AuditService,
        'actor-1',
        batchId,
        '0.01',
      ),
    ).resolves.toEqual([target.id]);
    expect(inventory.reverse).toHaveBeenCalledWith(
      tx,
      movement.id,
      'actor-1',
      expect.any(String),
      '2026-08-20',
      true,
    );
    expect(inventory.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        operationDate: '2026-09-27',
        qty: '4',
        totalCost: '8',
        refId: target.id,
      }),
    );
    expect(tx.purchase.update).toHaveBeenCalledWith({
      where: { id: target.id },
      data: { receivedAt: new Date(oldReceivedAt) },
    });
  });

  it('bloquea el lote completo si el ítem tuvo un movimiento posterior', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'balance' }]),
      auditLog: {
        findMany: jest.fn().mockResolvedValue([
          {
            after: {
              batchId: 'lote',
              purchaseId: target.id,
              movementIds: ['3'],
              oldMovementIds: ['1'],
              destinationDate: '2026-08-20',
              currentDate: '2026-09-27',
              oldReceivedAt: '2026-09-28T00:23:29.921Z',
            },
          },
        ]),
        count: jest.fn().mockResolvedValue(0),
      },
      inventoryMovement: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: 3n, itemType: 'PRODUCT', itemId: 'product-1' }),
        findFirst: jest.fn().mockResolvedValue({ id: 4n }),
      },
      purchase: { findUniqueOrThrow: jest.fn(), update: jest.fn() },
    };
    const inventory = { reverse: jest.fn(), record: jest.fn() };
    await expect(
      undoPurchaseReceivedDates(
        tx as unknown as Prisma.TransactionClient,
        inventory as unknown as InventoryService,
        { write: jest.fn() } as unknown as AuditService,
        'actor-1',
        'lote',
        '0.01',
      ),
    ).rejects.toThrow('movimientos posteriores');
    expect(inventory.reverse).not.toHaveBeenCalled();
    expect(tx.purchase.update).not.toHaveBeenCalled();
  });
});
