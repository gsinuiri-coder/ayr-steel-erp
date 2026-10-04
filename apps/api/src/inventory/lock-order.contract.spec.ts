import { NotFoundException } from '@nestjs/common';
import { Prisma, ProductionOrderKind, ProductionOrderStatus, Role } from '@prisma/client';
import type { RequestUser } from '../auth/auth.types';
import { CoilOperationsService } from '../coils/coil-operations.service';
import { CoilsService } from '../coils/coils.service';
import { CuttingService } from '../cutting/cutting.service';
import { DispatchesService } from '../invoicing/dispatches.service';
import { ProductionService } from '../production/production.service';
import { RoofingProductionService } from '../production/roofing-production.service';
import { rawMaterialCoilsForAttributes } from '../sales/raw-material';

/**
 * D-386 — **contrato de orden, sin base.** Cada caso corre el método real con una transacción
 * simulada hasta la toma de `InventoryService.lockInOrder` (que corta con `STOP`) y comprueba
 * **qué** se bloquea y **qué va antes**: la reserva antes que bobinas y saldos, el conjunto entero
 * en una sola toma. La concurrencia de verdad la prueba `lock-order.db-spec.ts`; esto fija la
 * forma de cada llamada, que es lo que un cambio descuidado rompería primero.
 */
const STOP = new Error('fin deliberado en la toma de inventario');
const ADMIN = { id: 'admin', role: Role.ADMINISTRADOR } as RequestUser;
const D = (v: string) => new Prisma.Decimal(v);

function recorder() {
  const calls: string[] = [];
  const lockInOrder = jest.fn((_tx: unknown, set: unknown): Promise<unknown> => {
    calls.push(`lockInOrder ${JSON.stringify(set)}`);
    return Promise.reject(STOP);
  });
  const queryRaw = (rows: (sql: string) => unknown[]) =>
    jest.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
      const sql = strings.join('?');
      calls.push(`sql ${sql.replace(/\s+/g, ' ').trim()}`);
      return Promise.resolve(rows(sql));
    });
  return { calls, lockInOrder, queryRaw };
}

function roofingService(tx: object, lockInOrder: jest.Mock, extra: object = {}) {
  const svc = Object.create(RoofingProductionService.prototype) as RoofingProductionService;
  Object.assign(svc, {
    prisma: { $transaction: (fn: (t: object) => Promise<unknown>) => fn(tx) },
    inventory: { lockInOrder },
    operationDate: { resolve: () => '2026-10-04' },
    env: { ROOFING_THICKNESS_TOLERANCE_MM: '0.02' },
    ...extra,
  });
  return svc;
}

const roofingOrder = (status: ProductionOrderStatus) => ({
  id: 'op',
  seq: 7,
  kind: ProductionOrderKind.ROOFING,
  status,
  businessLineId: 'bl',
  productId: 'p',
  notes: null,
  closedAt: new Date('2026-10-01T00:00:00Z'),
  reservationId: 'r-op',
});

const movement = (id: bigint, itemType: 'COIL' | 'PRODUCT', itemId: string, type: string) => ({
  id,
  businessLineId: 'bl',
  itemType,
  itemId,
  unit: itemType === 'COIL' ? 'KGM' : 'MTR',
  type,
  qty: D('10'),
  reversalOfId: null,
  reversals: [],
});

describe('D-386 — contrato de orden de cada toma', () => {
  it('revertir un reporte de coberturas: reserva del producto, después bobinas y saldos', async () => {
    const { calls, lockInOrder, queryRaw } = recorder();
    const tx = {
      $queryRaw: queryRaw((sql) => (sql.includes('production_orders') ? [{ id: 'op' }] : [])),
      productionOrder: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue(roofingOrder(ProductionOrderStatus.IN_PROGRESS)),
      },
      productionReport: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({ id: 'rep', status: 'ACTIVE', seq: 1, piecesDetail: [] })
          .mockResolvedValueOnce(null),
      },
      inventoryMovement: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            movement(1n, 'COIL', 'c1', 'OUT'),
            movement(2n, 'PRODUCT', 'p', 'IN'),
          ]),
      },
      reservation: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ salesOrderItemId: 'soi' }),
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'r-p', qty: D('10'), status: 'ACTIVE', unit: 'MTR' }),
      },
    };
    await expect(
      roofingService(tx, lockInOrder).reverseReport(ADMIN, 'op', 'rep', { reason: 'cc18' }),
    ).rejects.toBe(STOP);

    const reservationLock = calls.findIndex((c) => c.includes('"reservations"'));
    const inventoryLock = calls.findIndex((c) => c.startsWith('lockInOrder'));
    expect(reservationLock).toBeGreaterThan(0);
    expect(inventoryLock).toBeGreaterThan(reservationLock);
    expect(lockInOrder.mock.calls[0]?.[1]).toEqual({
      items: [
        { businessLineId: 'bl', itemType: 'COIL', itemId: 'c1', unit: 'KGM' },
        { businessLineId: 'bl', itemType: 'PRODUCT', itemId: 'p', unit: 'MTR' },
      ],
    });
  });

  it('reabrir una OP de coberturas: las bobinas que vuelven y los saldos de lo que se revierte', async () => {
    const { lockInOrder, queryRaw } = recorder();
    const tx = {
      $queryRaw: queryRaw(() => [{ id: 'op' }]),
      productionOrder: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(roofingOrder(ProductionOrderStatus.CLOSED)),
      },
      inventoryMovement: {
        findMany: jest.fn().mockResolvedValue([movement(5n, 'PRODUCT', 'p', 'ADJUST')]),
      },
      productionOrderConsumption: {
        findMany: jest.fn().mockResolvedValue([{ coilId: 'c2' }, { coilId: 'c1' }]),
      },
    };
    await expect(
      roofingService(tx, lockInOrder).reopen(ADMIN, 'op', { reason: 'cc18' }),
    ).rejects.toBe(STOP);
    expect(lockInOrder.mock.calls[0]?.[1]).toEqual({
      coilIds: ['c2', 'c1'],
      items: [{ businessLineId: 'bl', itemType: 'PRODUCT', itemId: 'p', unit: 'MTR' }],
    });
  });

  it('montar varias bobinas: todas antes del bucle, con el saldo de las que se reabren', async () => {
    const { lockInOrder, queryRaw } = recorder();
    const tx = {
      $queryRaw: queryRaw(() => [{ id: 'op' }]),
      productionOrder: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(roofingOrder(ProductionOrderStatus.DRAFT)),
      },
      product: { findUniqueOrThrow: jest.fn().mockResolvedValue({ color: { name: 'ROJO' } }) },
      coil: { findMany: jest.fn().mockResolvedValue([{ id: 'c1', businessLineId: 'bl' }]) },
    };
    const svc = roofingService(tx, lockInOrder, {
      production: { requireRoofingProduct: jest.fn().mockResolvedValue({}) },
    });
    await expect(
      svc.mountCoil(ADMIN, 'op', {
        coilIds: ['c2', 'c1'],
        reopenCoilIds: ['c1'],
        reopenReason: 'cc18 reabrir',
      }),
    ).rejects.toBe(STOP);
    expect(lockInOrder.mock.calls[0]?.[1]).toEqual({
      coilIds: ['c1', 'c2'],
      items: [{ businessLineId: 'bl', itemType: 'COIL', itemId: 'c1', unit: 'KGM' }],
    });
  });

  it('editar una bobina con otro acabado: su agregado y el de destino en la misma toma', async () => {
    const { lockInOrder } = recorder();
    const tx = {
      coil: {
        findUnique: jest.fn().mockResolvedValue({ businessLineId: 'bl', thicknessMm: D('0.50') }),
      },
      finish: { findUnique: jest.fn().mockResolvedValue({ colorId: 'azul' }) },
      // Sin agregados con promesas vivas: el destino no suma bobinas.
      rawMaterialSpec: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const svc = Object.create(CoilOperationsService.prototype) as CoilOperationsService;
    Object.assign(svc, {
      prisma: { $transaction: (fn: (t: object) => Promise<unknown>) => fn(tx) },
      inventory: { lockInOrder },
      env: { ROOFING_THICKNESS_TOLERANCE_MM: '0.02' },
    });
    await expect(svc.update(ADMIN, 'c1', { finishId: 'f-azul' })).rejects.toBe(STOP);
    expect(lockInOrder.mock.calls[0]?.[1]).toEqual({ coilIds: ['c1'] });
  });

  it('el despacho toma sus reservas (id, sin duplicados) antes que bobinas y saldos', async () => {
    const { calls, lockInOrder, queryRaw } = recorder();
    lockInOrder.mockImplementation((_tx: unknown, set: unknown) => {
      calls.push(`lockInOrder ${JSON.stringify(set)}`);
      return Promise.resolve();
    });
    const tx = { $queryRaw: queryRaw(() => []) };
    const svc = new DispatchesService(
      {} as never,
      {} as never,
      { lockInOrder } as never,
      {} as never,
    );
    const items = [
      { businessLineId: 'bl', itemType: 'PRODUCT' as const, itemId: 'p', unit: 'NIU' },
    ];
    await (
      svc as unknown as {
        lockDispatchSet: (...args: unknown[]) => Promise<void>;
      }
    ).lockDispatchSet(tx, ['r2', null, 'r1', 'r2'], ['c1'], items);
    expect(calls[0]).toContain('"reservations"');
    expect(tx.$queryRaw.mock.calls[0]?.[1]).toEqual(['r1', 'r2']);
    expect(calls[1]).toBe(`lockInOrder ${JSON.stringify({ coilIds: ['c1'], items })}`);
  });

  it('un despacho sin reservas no consulta reservas', async () => {
    const { lockInOrder, queryRaw } = recorder();
    lockInOrder.mockResolvedValue(undefined);
    const tx = { $queryRaw: queryRaw(() => []) };
    const svc = new DispatchesService(
      {} as never,
      {} as never,
      { lockInOrder } as never,
      {} as never,
    );
    await (
      svc as unknown as { lockDispatchSet: (...args: unknown[]) => Promise<void> }
    ).lockDispatchSet(tx, [null], [], []);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(lockInOrder).toHaveBeenCalledWith(tx, { coilIds: [], items: [] });
  });
});

describe('D-386 — contrato de orden: drywall y corte', () => {
  it('revertir un reporte de drywall: flejes y saldos de una vez, antes de mirar lo posterior', async () => {
    const { calls, lockInOrder, queryRaw } = recorder();
    const tx = {
      $queryRaw: queryRaw(() => [{ id: 'op' }]),
      productionOrder: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          ...roofingOrder(ProductionOrderStatus.IN_PROGRESS),
          kind: ProductionOrderKind.DRYWALL,
        }),
      },
      productionReport: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({ id: 'rep', status: 'ACTIVE', seq: 1 })
          .mockResolvedValueOnce(null),
      },
      inventoryMovement: {
        findMany: jest.fn().mockImplementation(() => {
          calls.push('movimientos');
          return Promise.resolve([
            movement(1n, 'COIL', 'f1', 'OUT'),
            movement(2n, 'PRODUCT', 'p', 'IN'),
          ]);
        }),
      },
    };
    const svc = Object.create(ProductionService.prototype) as ProductionService;
    Object.assign(svc, {
      prisma: { $transaction: (fn: (t: object) => Promise<unknown>) => fn(tx) },
      inventory: { lockInOrder },
      operationDate: { resolve: () => '2026-10-04' },
    });
    await expect(svc.reverseReport(ADMIN, 'op', 'rep', { reason: 'cc18' })).rejects.toBe(STOP);
    // Una sola lectura de movimientos (los del reporte) antes de la toma: la de «posteriores»
    // viene después, bajo los locks.
    expect(calls.filter((c) => c === 'movimientos')).toHaveLength(1);
    expect(lockInOrder.mock.calls[0]?.[1]).toEqual({
      items: [
        { businessLineId: 'bl', itemType: 'COIL', itemId: 'f1', unit: 'KGM' },
        { businessLineId: 'bl', itemType: 'PRODUCT', itemId: 'p', unit: 'MTR' },
      ],
    });
  });

  it('anular una orden de corte: la orden, sus filas pendientes y después sus bobinas', async () => {
    const { calls, lockInOrder, queryRaw } = recorder();
    const tx = {
      $queryRaw: queryRaw(() => []),
      cuttingOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co',
          status: 'SENT',
          coils: [
            { id: 'row-2', status: 'SENT', coilId: 'c2' },
            { id: 'row-1', status: 'RECEIVED', coilId: 'c1' },
            { id: 'row-3', status: 'SENT', coilId: 'c3' },
          ],
        }),
      },
    };
    const svc = Object.create(CuttingService.prototype) as CuttingService;
    Object.assign(svc, {
      prisma: { $transaction: (fn: (t: object) => Promise<unknown>) => fn(tx) },
      inventory: { lockInOrder },
      operationDate: { resolve: () => '2026-10-04' },
    });
    await expect(svc.cancel(ADMIN, 'co', { reason: 'cc18' })).rejects.toBe(STOP);
    expect(calls[0]).toContain('"cutting_orders"');
    expect(calls[1]).toContain('"cutting_order_coils"');
    expect(tx.$queryRaw.mock.calls[1]?.[1]).toEqual(['row-2', 'row-3']);
    expect(lockInOrder.mock.calls[0]?.[1]).toEqual({ coilIds: ['c2', 'c3'] });
  });
});

describe('CoilsService.lockCoil (A6): la bobina con su agregado', () => {
  const build = (locked: string[]) => {
    const lockInOrder = jest.fn().mockResolvedValue(locked);
    const tx = { coil: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'c1' }) } };
    const svc = new CoilsService({} as never, { lockInOrder } as never);
    return { svc, tx, lockInOrder };
  };

  it('pide la bobina por la puerta única y la lee bajo el lock', async () => {
    const { svc, tx, lockInOrder } = build(['c0', 'c1']);
    await expect(svc.lockCoil(tx as never, 'c1')).resolves.toEqual({ id: 'c1' });
    expect(lockInOrder).toHaveBeenCalledWith(tx, { coilIds: ['c1'] });
  });

  it('un uuid en mayúsculas es la misma bobina (autorrevisión P3-4)', async () => {
    const { svc, tx } = build(['abc']);
    await expect(svc.lockCoil(tx as never, 'ABC')).resolves.toEqual({ id: 'c1' });
  });

  it('una bobina que no existe es un 404, como antes', async () => {
    const { svc, tx } = build([]);
    await expect(svc.lockCoil(tx as never, 'c9')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('rawMaterialCoilsForAttributes (D-386): el agregado destino de un cambio', () => {
  it('suma las bobinas de cada agregado con promesas vivas que alcanzan los atributos', async () => {
    const tx = {
      rawMaterialSpec: {
        findMany: jest.fn().mockResolvedValue([
          { id: 's1', businessLineId: 'bl', colorId: 'azul', thicknessMm: D('0.50') },
          { id: 's2', businessLineId: 'bl', colorId: 'azul', thicknessMm: D('0.52') },
        ]),
      },
      // Solo s1 tiene promesas vivas.
      reservation: {
        groupBy: jest.fn().mockResolvedValue([{ itemId: 's1', _sum: { qty: D('100') } }]),
      },
      quotationReservation: { groupBy: jest.fn().mockResolvedValue([]) },
      coil: { findMany: jest.fn().mockResolvedValue([{ id: 'c7' }, { id: 'c3' }]) },
    };
    await expect(
      rawMaterialCoilsForAttributes(
        tx as never,
        [{ businessLineId: 'bl', colorId: 'azul', thicknessMm: '0.50' }],
        '0.02',
      ),
    ).resolves.toEqual(['c7', 'c3']);
    expect(tx.coil.findMany).toHaveBeenCalledTimes(1);
  });

  it('sin atributos no consulta nada', async () => {
    const tx = { rawMaterialSpec: { findMany: jest.fn() } };
    await expect(rawMaterialCoilsForAttributes(tx as never, [], '0.02')).resolves.toEqual([]);
    expect(tx.rawMaterialSpec.findMany).not.toHaveBeenCalled();
  });
});
