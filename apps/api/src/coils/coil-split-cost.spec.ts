import { CoilStatus, Prisma, type Coil } from '@prisma/client';
import { createCoilSplitSchema, updateCoilSchema } from '@ayr/shared';
import type { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import type { OperationDateService } from '../common/operation-date.service';
import type { Env } from '../config/env';
import type { InventoryService } from '../inventory/inventory.service';
import type { PrismaService } from '../prisma/prisma.service';
import { CoilOperationsService } from './coil-operations.service';
import type { CoilsService } from './coils.service';

/**
 * D-608 (cc46) con base falsa: el partido reparte el valor de la salida entre las hijas (kerf y
 * borde incluidos) y sube el costo del documento; el recosteo sin cambio de costo reingresa el
 * valor exacto. La aritmética contra Postgres la prueba `coil-split-kerf-cost.db-spec.ts`.
 */
jest.mock('../production/production-assignments', () => ({
  assertStripsNotAssigned: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./coil-film', () => ({ openFilmIfSealed: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./coil-auto-terminate', () => ({
  autoTerminateEmptyCoils: jest.fn().mockResolvedValue({ terminate: [] }),
  reopenAutoTerminatedCoils: jest.fn(),
}));
jest.mock('../sales/raw-material', () => ({
  assertRawMaterialInvariant: jest.fn().mockResolvedValue(undefined),
  rawMaterialCoilsForAttributes: jest.fn().mockResolvedValue([]),
}));

const D = (v: string) => new Prisma.Decimal(v);
const admin = { id: 'u-1', role: 'ADMINISTRADOR' } as unknown as RequestUser;
/** Los datos que el recosteo escribió en la bobina (primer `tx.coil.update`). */
const updateData = (update: jest.Mock) =>
  ((update.mock.calls as unknown[][])[0]?.[0] as { data: Record<string, unknown> }).data;
const MOTHER = 'c0000000-0000-4000-a000-000000000001';

const mother = {
  id: MOTHER,
  code: 'BOB-1',
  status: CoilStatus.OPEN,
  businessLineId: 'bl-1',
  supplierId: 's-1',
  purchaseId: 'p-1',
  finishId: 'f-1',
  colorId: 'col-1',
  kind: 'COIL',
  widthMm: D('1220.00'),
  thicknessMm: D('0.45'),
  currency: 'PEN',
  exchangeRate: D('1.0000'),
  unitCostPerKg: D('4.1234'),
} as unknown as Coil;

function build() {
  const record = jest
    .fn()
    .mockImplementation((_tx: unknown, m: { qty: string; unitCost?: string; totalCost?: string }) =>
      Promise.resolve({
        id: 1n,
        unitCost: D(m.unitCost ?? '4.1234'),
        totalCost: m.totalCost ? D(m.totalCost) : D(m.qty).times(m.unitCost ?? '4.1234'),
      }),
    );
  const reverse = jest.fn().mockResolvedValue(undefined);
  let seq = 0;
  const create = jest.fn().mockImplementation(() => {
    seq += 1;
    return Promise.resolve({ id: `child-${String(seq)}`, code: `BOB-1-${String(seq)}` });
  });
  const coils = {
    lockCoil: jest.fn().mockResolvedValue(mother),
    prepareBatch: jest.fn().mockResolvedValue({ sequence: 10 }),
    create,
    findOne: jest.fn().mockImplementation((id: string) => Promise.resolve({ id })),
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const tx = {
    inventoryBalance: {
      findUnique: jest.fn().mockResolvedValue({ qty: D('2000.000'), avgCost: D('4.1234') }),
    },
    coilSplit: { create: jest.fn().mockResolvedValue({ id: 'split-1' }) },
    inventoryMovement: { findMany: jest.fn() },
    coil: { update: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => unknown) => cb(tx)),
  };
  const service = new CoilOperationsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    { record, reverse } as unknown as InventoryService,
    coils as unknown as CoilsService,
    { resolve: () => '2026-10-11' } as unknown as OperationDateService,
    {} as Env,
  );
  return { service, tx, record, reverse, create, audit };
}

describe('split — D-608: el valor del kerf y el borde entra a las hijas', () => {
  it('las hijas suman la salida de la madre y el documento sube en la misma proporción', async () => {
    const { service, create, audit } = build();
    await service.split(
      admin,
      MOTHER,
      createCoilSplitSchema.parse({
        kerfLossMm: '20',
        children: [
          { widthMm: '600', count: 1 },
          { widthMm: '560', count: 1 },
        ],
      }),
    );
    // 2 000 kg × 4.1234 = 8 246.80 salen; hijas de 983.607 y 918.032 kg.
    const inputs = create.mock.calls.map(
      (c: unknown[]) =>
        c[1] as { weightKg: string; kardexTotalCostPen: string; unitCostPerKg: string },
    );
    expect(inputs.map((i) => i.weightKg)).toEqual(['983.607', '918.032']);
    const total = inputs.reduce((acc, i) => acc.plus(i.kardexTotalCostPen), D('0'));
    expect(total.toFixed(4)).toBe('8246.8000');
    for (const i of inputs) expect(i.unitCostPerKg).toBe('4.3367');
    expect(audit.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'coils.split',
        after: expect.objectContaining({ kerfLossKg: '98.361', kerfValuePen: '405.5817' }),
      }),
    );
  });

  it('sin kerf ni borde el documento y el costo por kg quedan como los de la madre', async () => {
    const { service, create } = build();
    await service.split(
      admin,
      MOTHER,
      createCoilSplitSchema.parse({
        splitWeightKg: '1000',
        kerfLossMm: '0',
        children: [{ widthMm: '610', count: 2 }],
      }),
    );
    const inputs = create.mock.calls.map(
      (c: unknown[]) => c[1] as { kardexTotalCostPen: string; unitCostPerKg: string },
    );
    expect(inputs.map((i) => i.kardexTotalCostPen)).toEqual(['2061.7000', '2061.7000']);
    for (const i of inputs) expect(i.unitCostPerKg).toBe('4.1234');
  });
});

describe('update — recosteo (D-045) de una hija de partido', () => {
  const child = {
    ...mother,
    id: 'child-1',
    splitId: 'split-1',
    unitCostPerKg: D('4.3367'),
    widthMm: D('600.00'),
    notes: null,
  } as unknown as Coil;
  const initial = {
    id: 5n,
    type: 'IN',
    refType: 'SPLIT',
    refId: 'split-1',
    qty: D('983.607'),
    unit: 'KGM',
    unitCost: D('4.3366'),
    totalCost: D('4265.6017'),
    operationDate: new Date('2026-10-11T00:00:00Z'),
    reversalOfId: null,
    reversals: [],
  };

  function withChild() {
    const ctx = build();
    Object.assign(ctx.service, {
      coils: {
        lockCoil: jest.fn().mockResolvedValue(child),
        findOne: jest.fn().mockResolvedValue({ id: child.id }),
      },
    });
    ctx.tx.inventoryMovement.findMany.mockResolvedValue([initial]);
    // Lo que devuelve el `update` solo lo lee la auditoría: la fila tal cual alcanza.
    ctx.tx.coil.update.mockResolvedValue(child);
    return ctx;
  }

  it('sin cambiar el costo reingresa el valor exacto y conserva el total en soles', async () => {
    const { service, tx, record, reverse } = withChild();
    await service.update(
      admin,
      child.id,
      updateCoilSchema.parse({
        unitCostPerKg: '4.3367',
        reason: 'mismo costo',
        costReason: 'TYPING_ERROR',
      }),
    );
    expect(reverse).toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ unitCost: '4.3366', totalCost: '4265.6017' }),
    );
    const data = updateData(tx.coil.update);
    expect(data.totalCostPen).toBeUndefined();
  });

  it('con un costo nuevo revaloriza a peso × unitario (corrección explícita)', async () => {
    const { service, tx, record } = withChild();
    await service.update(
      admin,
      child.id,
      updateCoilSchema.parse({
        unitCostPerKg: '4.5000',
        reason: 'costo nuevo',
        costReason: 'PURCHASE_CORRECTION',
      }),
    );
    const call = (record.mock.calls as unknown[][])[0]?.[1] as {
      unitCost: string;
      totalCost?: string;
    };
    expect(call.unitCost).toBe('4.5000');
    expect(call.totalCost).toBeUndefined();
    const data = updateData(tx.coil.update);
    expect(data.totalCostPen).toBe('4426.2315');
  });
});
