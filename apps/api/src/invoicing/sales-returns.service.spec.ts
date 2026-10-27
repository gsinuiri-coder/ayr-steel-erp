import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import type { InventoryService } from '../inventory/inventory.service';
import type { PrismaService } from '../prisma/prisma.service';
import { Decimal } from '@ayr/shared';
import { effectiveOutCost, SalesReturnsService, toSalesReturnDto } from './sales-returns.service';

/**
 * cc52 (D-646) — la devolución de una NC, con un `tx` falso. Lo mismo contra una base real vive en
 * `sales-returns.db-spec.ts`.
 */
const D = (v: string) => new Prisma.Decimal(v);
const ADMIN = { id: 'u-1', role: Role.ADMINISTRADOR } as RequestUser;
const SELLER = { id: 'u-2', role: Role.VENDEDOR } as RequestUser;

function dispatchItem(over: Record<string, unknown> = {}) {
  return {
    id: 'di-1',
    dispatchId: 'd-1',
    salesOrderItemId: 'soi-1',
    itemType: 'PRODUCT',
    itemId: 'p-1',
    qty: D('5'),
    reserveQty: D('5'),
    movementId: 10n,
    dispatch: {
      seq: 7,
      dispatchDate: new Date('2026-09-10T00:00:00.000Z'),
      invoiceId: 'f-1',
      invoice: { status: 'ACCEPTED', archivedAt: null },
    },
    salesReturnItems: [],
    ...over,
  };
}

function setup(options: {
  note?: Record<string, unknown> | null;
  dispatchItems?: Record<string, unknown>[];
  salesReturn?: Record<string, unknown> | null;
  reverseError?: Error;
  coilClosed?: boolean;
  withoutKardexQty?: Prisma.Decimal;
}) {
  const audit = {
    write: jest.fn<Promise<void>, [unknown, { entityId?: string; action: string }]>(),
  };
  const inventory = {
    record: jest.fn().mockResolvedValue({ id: 99n }),
    reverse: options.reverseError
      ? jest.fn().mockRejectedValue(options.reverseError)
      : jest.fn().mockResolvedValue({ id: 100n }),
    lockInOrder: jest.fn().mockResolvedValue([]),
  };
  const tx = {
    fiscalDocument: { findUniqueOrThrow: jest.fn().mockResolvedValue(options.note) },
    fiscalDocumentItem: {
      findMany: jest.fn().mockResolvedValue([{ salesOrderItemId: 'soi-1' }]),
    },
    dispatchItem: {
      findMany: jest.fn().mockResolvedValue(options.dispatchItems ?? [dispatchItem()]),
      // cc57 (D-12): lo entregado sin salida de kardex (antes del inventario inicial).
      aggregate: jest.fn().mockResolvedValue({ _sum: { qty: options.withoutKardexQty ?? null } }),
    },
    inventoryMovement: {
      // cc53 (D-649): sin recosteos sobre la salida del despacho.
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([
        {
          id: 10n,
          unitCost: D('20.0000'),
          totalCost: D('100.0000'),
          unit: 'NIU',
          businessLineId: 'bl-1',
        },
      ]),
    },
    salesReturn: {
      create: jest.fn().mockResolvedValue({ id: 'sr-1', seq: 3 }),
      findUnique: jest.fn().mockResolvedValue(options.salesReturn ?? null),
      update: jest.fn(),
    },
    salesReturnItem: { create: jest.fn() },
    salesOrder: { findUniqueOrThrow: jest.fn().mockResolvedValue({ seq: 12 }) },
    coil: {
      findMany: jest
        .fn()
        .mockResolvedValue(options.coilClosed ? [{ id: 'c-1', code: 'BOB-1' }] : []),
      update: jest.fn(),
    },
    inventoryBalance: { findMany: jest.fn().mockResolvedValue([{ itemId: 'c-1', qty: D('0') }]) },
    auditLog: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ entityId: 'c-1', after: { reopenedBySalesReturn: 'DEV-000003' } }]),
    },
  };
  const prisma = {
    salesReturn: {
      findUnique: jest.fn().mockResolvedValue({ salesOrder: { sellerId: 'u-1' } }),
    },
  };
  const service = new SalesReturnsService(
    prisma as unknown as PrismaService,
    inventory as unknown as InventoryService,
    audit as unknown as AuditService,
  );
  return { service, tx: tx as never, rawTx: tx, inventory, audit };
}

const NOTE = {
  id: 'nc-1',
  number: 'FC90-1',
  issueDate: new Date('2026-10-14T00:00:00.000Z'),
  creditNoteReason: 'DEVOLUCION_ITEM',
  salesOrderId: 'o-1',
  affectedDocument: { id: 'f-1', number: 'F001-1' },
  items: [{ id: 'nci-1', lineNumber: 1, qty: D('2'), salesOrderItemId: 'soi-1' }],
};

describe('SalesReturnsService (cc52, D-646)', () => {
  it('una NC que no es de devolución no crea nada', async () => {
    const { service, tx, inventory } = setup({
      note: { ...NOTE, creditNoteReason: 'DESCUENTO_ITEM' },
    });
    await expect(service.createForCreditNoteInTx(tx, ADMIN, 'nc-1', ['d-1'])).resolves.toBeNull();
    expect(inventory.record).not.toHaveBeenCalled();
  });

  it('sin pedido no hay despacho que devolver: 400', async () => {
    const { service, tx } = setup({ note: { ...NOTE, salesOrderId: null } });
    await expect(service.createForCreditNoteInTx(tx, ADMIN, 'nc-1', ['d-1'])).rejects.toThrow(
      BadRequestException,
    );
  });

  it('el plan no sale de un despacho que no se bloqueó: 409', async () => {
    const { service, tx } = setup({ note: NOTE });
    await expect(service.createForCreditNoteInTx(tx, ADMIN, 'nc-1', [])).rejects.toThrow(
      ConflictException,
    );
  });

  it('reingresa al costo del despacho con la fecha de la NC y audita en los cuatro historiales', async () => {
    const { service, tx, rawTx, inventory, audit } = setup({ note: NOTE });
    await expect(service.createForCreditNoteInTx(tx, ADMIN, 'nc-1', ['d-1'])).resolves.toBe('sr-1');
    expect(inventory.lockInOrder).toHaveBeenCalled();
    expect(inventory.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        type: 'IN',
        qty: '2.000',
        unitCost: '20.0000',
        totalCost: '40.0000',
        refType: 'SALES_RETURN',
        refId: 'sr-1',
        operationDate: '2026-10-14',
      }),
    );
    expect(rawTx.salesReturnItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ movementId: 99n, dispatchItemId: 'di-1' }),
    });
    const targets = audit.write.mock.calls.map((c) => c[1].entityId);
    expect(targets).toEqual(['sr-1', 'nc-1', 'f-1', 'o-1']);
  });

  it('cc69 (D-728): de un despacho posterior entra en su fecha; graba primero la parte más tardía', async () => {
    const { service, tx, rawTx, inventory } = setup({
      note: { ...NOTE, items: [{ ...NOTE.items[0], qty: D('7') }] },
      dispatchItems: [
        dispatchItem(),
        dispatchItem({
          id: 'di-2',
          dispatchId: 'd-2',
          movementId: 11n,
          dispatch: {
            seq: 9,
            dispatchDate: new Date('2026-10-20T00:00:00.000Z'),
            invoiceId: 'f-1',
            invoice: { status: 'ACCEPTED', archivedAt: null },
          },
        }),
      ],
    });
    rawTx.inventoryMovement.findMany.mockResolvedValue([
      {
        id: 10n,
        unitCost: D('20.0000'),
        totalCost: D('100.0000'),
        unit: 'NIU',
        businessLineId: 'bl-1',
      },
      {
        id: 11n,
        unitCost: D('30.0000'),
        totalCost: D('150.0000'),
        unit: 'NIU',
        businessLineId: 'bl-1',
      },
    ]);
    await service.createForCreditNoteInTx(tx, ADMIN, 'nc-1', ['d-1', 'd-2']);
    expect(rawTx.salesReturn.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ operationDate: new Date('2026-10-20T00:00:00.000Z') }),
      }),
    );
    // Primero la parte del despacho posterior (línea 2 de la DEV-), después la de la fecha de la NC.
    expect(
      inventory.record.mock.calls.map((c) => [c[1].operationDate, c[1].qty, c[1].totalCost]),
    ).toEqual([
      ['2026-10-20', '2.000', '60.0000'],
      ['2026-10-14', '5.000', '100.0000'],
    ]);
    expect(
      rawTx.salesReturnItem.create.mock.calls.map((c) => [
        c[0].data.lineNumber,
        c[0].data.dispatchItemId,
      ]),
    ).toEqual([
      [2, 'di-2'],
      [1, 'di-1'],
    ]);
  });

  it('una bobina terminada que vuelve se reabre', async () => {
    const { service, tx, rawTx, audit } = setup({
      note: { ...NOTE, items: [{ ...NOTE.items[0], qty: D('1') }] },
      dispatchItems: [
        dispatchItem({ itemType: 'COIL', itemId: 'c-1', qty: D('1'), reserveQty: D('500') }),
      ],
      coilClosed: true,
    });
    await service.createForCreditNoteInTx(tx, ADMIN, 'nc-1', ['d-1']);
    expect(rawTx.coil.update).toHaveBeenCalledWith({
      where: { id: 'c-1' },
      data: { status: 'OPEN' },
    });
    expect(audit.write.mock.calls.some((c) => c[1].action === 'coils.open')).toBe(true);
  });

  it('dos líneas de la NC sobre la misma línea de pedido consumen del mismo despachado', async () => {
    const { service, tx } = setup({ note: NOTE });
    await expect(
      service.planForLines(tx, [
        { lineNumber: 1, orderItemId: 'soi-1', qty: '3' },
        { lineNumber: 2, orderItemId: 'soi-1', qty: '3' },
      ]),
    ).rejects.toThrow('hay 2.000 despachado sin devolver');
  });

  it('cc57 (D-12): lo entregado antes del inventario inicial se nombra en el rechazo', async () => {
    const { service, tx } = setup({ note: NOTE, dispatchItems: [], withoutKardexQty: D('5') });
    await expect(
      service.planForLines(tx, [{ lineNumber: 1, orderItemId: 'soi-1', qty: '2' }]),
    ).rejects.toThrow(
      'Línea 1: lo despachado (5.000) se entregó antes del inventario inicial y no tiene salida en el kardex',
    );
  });

  it('una línea sin pedido no se devuelve', async () => {
    const { service, tx } = setup({ note: NOTE });
    await expect(
      service.planForLines(tx, [{ lineNumber: 1, orderItemId: null, qty: '1' }]),
    ).rejects.toThrow('no viene de un pedido');
  });

  it('los despachos de una NC, ordenados, sin repetir', async () => {
    const { service, tx, rawTx } = setup({ note: NOTE });
    rawTx.dispatchItem.findMany.mockResolvedValueOnce([
      { dispatchId: 'd-2' },
      { dispatchId: 'd-1' },
      { dispatchId: 'd-2' },
    ]);
    await expect(service.dispatchIdsForCreditNote(tx, 'nc-1')).resolves.toEqual(['d-1', 'd-2']);
  });

  const ACTIVE_RETURN = {
    id: 'sr-1',
    seq: 3,
    status: 'ACTIVE',
    salesOrderId: 'o-1',
    creditNote: { id: 'nc-1', number: 'FC90-1', affectedDocument: { id: 'f-1', number: 'F001-1' } },
    items: [
      {
        movementId: 99n,
        itemType: 'COIL',
        itemId: 'c-1',
        reserveQty: D('500'),
        totalCost: D('2100'),
        movement: { businessLineId: 'bl-1', unit: 'KGM' },
        dispatchItem: { dispatch: { seq: 7 } },
      },
    ],
  };

  it('anular sin devolución vigente no hace nada', async () => {
    const { service, tx, inventory } = setup({ note: NOTE, salesReturn: null });
    await expect(service.reverseForCreditNoteInTx(tx, ADMIN, 'nc-1', 'x')).resolves.toBeNull();
    expect(inventory.reverse).not.toHaveBeenCalled();
  });

  it('anular revierte cada reingreso, marca la devolución y cierra la bobina que había reabierto', async () => {
    const { service, tx, rawTx, inventory } = setup({ note: NOTE, salesReturn: ACTIVE_RETURN });
    rawTx.coil.findMany.mockResolvedValueOnce([{ id: 'c-1', code: 'BOB-1' }]);
    await expect(service.reverseForCreditNoteInTx(tx, ADMIN, 'nc-1', 'motivo')).resolves.toBe(
      'sr-1',
    );
    expect(inventory.reverse).toHaveBeenCalledWith(
      tx,
      99n,
      'u-1',
      expect.stringContaining('DEV-000003'),
    );
    expect(rawTx.salesReturn.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REVERSED' }) }),
    );
    expect(rawTx.coil.update).toHaveBeenCalledWith({
      where: { id: 'c-1' },
      data: { status: 'CLOSED' },
    });
  });

  it('si la mercadería ya se volvió a vender, 409', async () => {
    const { service, tx } = setup({
      note: NOTE,
      salesReturn: ACTIVE_RETURN,
      reverseError: new BadRequestException('Stock insuficiente'),
    });
    await expect(service.reverseForCreditNoteInTx(tx, ADMIN, 'nc-1', 'x')).rejects.toThrow(
      ConflictException,
    );
  });

  it('el vendedor solo ve las devoluciones de sus pedidos', async () => {
    const { service } = setup({ note: NOTE });
    await expect(service.assertSellerAccessTo(ADMIN, 'sr-1')).resolves.toBeUndefined();
    await expect(service.assertSellerAccessTo(SELLER, 'sr-1')).rejects.toThrow(NotFoundException);
  });

  it('el DTO suma el costo y nombra NC, comprobante, pedido y despacho', () => {
    const dto = toSalesReturnDto({
      id: 'sr-1',
      seq: 3,
      status: 'ACTIVE',
      operationDate: new Date('2026-10-20T00:00:00.000Z'),
      creditNote: {
        id: 'nc-1',
        number: 'FC90-1',
        issueDate: new Date('2026-10-14T00:00:00.000Z'),
        creditNoteReason: 'DEVOLUCION_TOTAL',
        affectedDocument: { id: 'f-1', number: 'F001-1' },
      },
      salesOrder: { id: 'o-1', seq: 12 },
      createdAt: new Date('2026-10-14T15:00:00.000Z'),
      createdBy: { name: 'Admin' },
      reversedAt: null,
      reversedBy: null,
      reverseReason: null,
      items: [
        {
          lineNumber: 1,
          creditNoteItem: { lineNumber: 1, description: 'Bobina', unit: 'NIU' },
          qty: D('1'),
          itemType: 'COIL',
          itemId: 'c-1',
          reserveQty: D('500'),
          movement: { unit: 'KGM', operationDate: new Date('2026-10-20T00:00:00.000Z') },
          unitCost: D('4.2'),
          totalCost: D('2100'),
          dispatchItem: {
            dispatchId: 'd-1',
            dispatch: { seq: 7, dispatchDate: new Date('2026-10-20T00:00:00.000Z') },
          },
          movementId: 99n,
        },
      ],
    } as never);
    expect(dto).toMatchObject({
      code: 'DEV-000003',
      salesOrderCode: 'PED-000012',
      totalCostPen: '2100.0000',
      affectedDocumentNumber: 'F001-1',
      // cc69 (D-728): la DEV- de un despacho posterior a la NC lleva la fecha del despacho.
      operationDate: '2026-10-20',
      creditNoteDate: '2026-10-14',
    });
    expect(dto.items[0]).toMatchObject({
      dispatchCode: 'DES-000007',
      movementId: '99',
      dispatchDate: '2026-10-20',
      operationDate: '2026-10-20',
    });
  });

  it('cc69: el costo de la DEV- es el efectivo, con los recosteos de su reingreso', async () => {
    const row = {
      id: 'sr-1',
      seq: 3,
      status: 'ACTIVE',
      operationDate: new Date('2026-10-20T00:00:00.000Z'),
      creditNote: {
        id: 'nc-1',
        number: 'FC90-1',
        issueDate: new Date('2026-10-14T00:00:00.000Z'),
        creditNoteReason: 'DEVOLUCION_ITEM',
        affectedDocument: null,
      },
      salesOrder: { id: 'o-1', seq: 12 },
      createdAt: new Date('2026-10-20T15:00:00.000Z'),
      createdBy: { name: 'Admin' },
      reversedAt: null,
      reversedBy: null,
      reverseReason: null,
      items: [
        {
          lineNumber: 1,
          creditNoteItem: { lineNumber: 1, description: 'Producto', unit: 'NIU' },
          qty: D('2'),
          itemType: 'PRODUCT',
          itemId: 'p-1',
          reserveQty: D('2'),
          movement: { unit: 'NIU', operationDate: new Date('2026-10-20T00:00:00.000Z') },
          unitCost: D('30'),
          totalCost: D('60'),
          dispatchItem: {
            dispatchId: 'd-1',
            dispatch: { seq: 7, dispatchDate: new Date('2026-10-20T00:00:00.000Z') },
          },
          movementId: 99n,
        },
      ],
    } as never;
    // findOne lee los recosteos de cada reingreso y los suma al costo grabado.
    const groupBy = jest
      .fn()
      .mockResolvedValue([{ recostOfId: 99n, _sum: { totalCost: new Prisma.Decimal('-4') } }]);
    const findUnique = jest.fn().mockResolvedValueOnce(row).mockResolvedValueOnce(null);
    const reader = new SalesReturnsService(
      { salesReturn: { findUnique }, inventoryMovement: { groupBy } } as unknown as PrismaService,
      {} as InventoryService,
      {} as AuditService,
    );
    await expect(reader.findOne('sr-1')).resolves.toMatchObject({ totalCostPen: '56.0000' });
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { recostOfId: { in: [99n] } } }),
    );
    await expect(reader.findOne('sr-x')).rejects.toThrow(NotFoundException);
    const dto = toSalesReturnDto(row, new Map([['99', new Decimal('-4')]]));
    expect(dto.totalCostPen).toBe('56.0000');
    expect(dto.items[0]).toMatchObject({ unitCostPen: '28.0000', totalCostPen: '56.0000' });
    expect(toSalesReturnDto(row).totalCostPen).toBe('60.0000');
  });
});

describe('effectiveOutCost (cc53, D-649)', () => {
  const out = { qty: '4', unitCost: '10.0000', totalCost: '40.0000' };

  it('sin recosteo devuelve lo grabado', () => {
    const r = effectiveOutCost(out, undefined);
    expect([r.unitCost.toFixed(4), r.totalCost.toFixed(4)]).toEqual(['10.0000', '40.0000']);
    expect(effectiveOutCost(out, new Decimal(0)).totalCost.toFixed(4)).toBe('40.0000');
  });

  it('un recosteo que saca valor del saldo es más costo de la salida', () => {
    const r = effectiveOutCost(out, new Decimal('-60'));
    expect([r.unitCost.toFixed(4), r.totalCost.toFixed(4)]).toEqual(['25.0000', '100.0000']);
  });
});
