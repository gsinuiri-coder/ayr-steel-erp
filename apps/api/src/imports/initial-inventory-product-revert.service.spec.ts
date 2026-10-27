import { Prisma } from '@prisma/client';
import type { RequestUser } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import type { OperationDateService } from '../common/operation-date.service';
import type { InventoryService } from '../inventory/inventory.service';
import type { PrismaService } from '../prisma/prisma.service';
import { InitialInventoryProductRevertService } from './initial-inventory-product-revert.service';

/**
 * cc68 (D-722) — el servicio de la reversa con dobles: qué decide, en qué orden escribe y qué
 * audita. El db-spec lo prueba contra una base real; esto cubre las ramas sin base.
 */
const ACTOR = { id: 'u-1' } as RequestUser;
const BATCH = '00000000-0000-4000-8000-000000000001';
const REASON = 'Inventario inicial de Drywall anulado por el cliente, D-721';

interface Facts {
  entries: { id: bigint; itemId: string }[];
  others?: { itemId: string; reversalOfId: bigint | null }[];
  reservations?: { itemId: string; _count: { _all: number } }[];
  quotationReservations?: { itemId: string; _count: { _all: number } }[];
}

function entry(id: bigint, itemId: string) {
  return {
    id,
    businessLineId: 'bl-trading',
    itemId,
    qty: new Prisma.Decimal('229'),
    unit: 'NIU',
    totalCost: new Prisma.Decimal('18205.5'),
  };
}

function build(facts: Facts, underLock?: Facts) {
  let calls = 0;
  const db = (f: Facts) => ({
    inventoryMovement: {
      findMany: jest.fn((args: { where: { type?: string } }) =>
        Promise.resolve(
          args.where.type === 'IN' ? f.entries.map((e) => entry(e.id, e.itemId)) : (f.others ?? []),
        ),
      ),
    },
    product: {
      findMany: jest.fn(() =>
        Promise.resolve(f.entries.map((e) => ({ id: e.itemId, sku: `SKU-${e.itemId}` }))),
      ),
    },
    reservation: { groupBy: jest.fn(() => Promise.resolve(f.reservations ?? [])) },
    quotationReservation: {
      groupBy: jest.fn(() => Promise.resolve(f.quotationReservations ?? [])),
    },
  });
  const outside = db(facts);
  const tx = db(underLock ?? facts);
  const prisma = {
    ...outside,
    $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => {
      calls += 1;
      return fn(tx);
    }),
  };
  const inventory = {
    lockInOrder: jest.fn(() => Promise.resolve([])),
    reverse: jest.fn(() => Promise.resolve({})),
  };
  const audit = { write: jest.fn(() => Promise.resolve()) };
  const dates = { resolve: jest.fn((_a: unknown, d?: string) => d ?? '2026-10-26') };
  const service = new InitialInventoryProductRevertService(
    prisma as unknown as PrismaService,
    inventory as unknown as InventoryService,
    audit as unknown as AuditService,
    dates as unknown as OperationDateService,
  );
  return { service, prisma, inventory, audit, tx, transactions: () => calls };
}

const clean: Facts = {
  entries: [
    { id: 1203n, itemId: 'p-1' },
    { id: 1210n, itemId: 'p-2' },
  ],
};

describe('InitialInventoryProductRevertService (cc68, D-722)', () => {
  it('el dry-run informa las entradas y no escribe', async () => {
    const { service, inventory, transactions } = build(clean);
    const report = await service.revert(ACTOR, {
      batchId: BATCH,
      execute: false,
      operationDate: '2026-08-01',
      reason: REASON,
    });
    expect(report).toMatchObject({ ok: true, executed: false, operationDate: '2026-08-01' });
    expect(report.rows.map((r) => [r.movementId, r.sku, r.qty, r.unit, r.totalCost])).toEqual([
      ['1203', 'SKU-p-1', '229.000', 'NIU', '18205.50'],
      ['1210', 'SKU-p-2', '229.000', 'NIU', '18205.50'],
    ]);
    expect(transactions()).toBe(0);
    expect(inventory.reverse).not.toHaveBeenCalled();
  });

  it('--execute bloquea los saldos, revierte cada entrada con su fecha y audita el lote', async () => {
    const { service, inventory, audit, tx } = build(clean);
    const report = await service.revert(ACTOR, {
      batchId: BATCH,
      execute: true,
      operationDate: '2026-08-01',
      reason: ` ${REASON} `,
    });
    expect(report).toMatchObject({ ok: true, executed: true });
    expect(report.rows.every((r) => r.reversed)).toBe(true);
    expect(inventory.lockInOrder).toHaveBeenCalledWith(tx, {
      items: [
        { businessLineId: 'bl-trading', itemType: 'PRODUCT', itemId: 'p-1', unit: 'NIU' },
        { businessLineId: 'bl-trading', itemType: 'PRODUCT', itemId: 'p-2', unit: 'NIU' },
      ],
    });
    expect(inventory.reverse.mock.calls).toEqual([
      [tx, 1203n, 'u-1', REASON, '2026-08-01', true],
      [tx, 1210n, 'u-1', REASON, '2026-08-01', true],
    ]);
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'imports.initial-inventory-products.revert',
        after: expect.objectContaining({
          batchId: BATCH,
          operationDate: '2026-08-01',
          count: 2,
          movementIds: ['1203', '1210'],
        }),
      }),
    );
  });

  it('una entrada usada frena el lote entero y no abre la transacción', async () => {
    const { service, inventory, transactions } = build({
      ...clean,
      others: [
        { itemId: 'p-1', reversalOfId: null },
        { itemId: 'p-2', reversalOfId: 1210n },
      ],
      reservations: [{ itemId: 'p-2', _count: { _all: 1 } }],
      quotationReservations: [{ itemId: 'p-1', _count: { _all: 2 } }],
    });
    const report = await service.revert(ACTOR, {
      batchId: BATCH,
      execute: true,
      operationDate: '2026-08-01',
      reason: REASON,
    });
    expect(report).toMatchObject({ ok: false, executed: false });
    expect(report.rows[0]?.errors).toEqual([
      expect.stringMatching(/SKU-p-1: tiene 1 movimiento/),
      expect.stringMatching(/SKU-p-1: tiene 2 reserva\(s\) temporal/),
    ]);
    expect(report.rows[1]?.errors).toEqual([
      'SKU-p-2: esta entrada ya se revirtió',
      expect.stringMatching(/SKU-p-2: tiene 1 reserva\(s\) de pedido activa/),
    ]);
    expect(transactions()).toBe(0);
    expect(inventory.reverse).not.toHaveBeenCalled();
  });

  it('si el lote cambió bajo el lock, no revierte nada', async () => {
    const { service, inventory } = build(clean, {
      ...clean,
      others: [{ itemId: 'p-2', reversalOfId: null }],
    });
    await expect(
      service.revert(ACTOR, {
        batchId: BATCH,
        execute: true,
        operationDate: '2026-08-01',
        reason: REASON,
      }),
    ).rejects.toThrow(/El lote cambió mientras se revertía: SKU-p-2/);
    expect(inventory.reverse).not.toHaveBeenCalled();
  });

  it('un lote sin entradas y un motivo vacío se rechazan', async () => {
    const empty = build({ entries: [] });
    await expect(
      empty.service.revert(ACTOR, { batchId: BATCH, execute: false, reason: REASON }),
    ).rejects.toThrow(/No hay entradas de carga inicial de productos con el lote/);
    await expect(
      build(clean).service.revert(ACTOR, { batchId: BATCH, execute: false, reason: '  ' }),
    ).rejects.toThrow(/Falta el motivo/);
  });
});
