import { BadRequestException } from '@nestjs/common';
import { Prisma, ProductionOrderKind, ProductionOrderStatus } from '@prisma/client';
import { TOLERANCE_OVERRIDE_REQUIRED, type ReportRoofingPiecesInput } from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { TOLERANCE_OVERRIDE_AUDIT_ACTION } from './production-shared';
import { RoofingProductionService } from './roofing-production.service';

/**
 * D-389 (P2-2 de la autorrevisión de cc21): el accesorio —reporte por `meters`, D-343— entra con
 * la casilla como las planchas. Sin ella, el rechazo trae el código y las cifras; con ella, entra
 * y deja la entrada de auditoría de la autorización. Si alguien vuelve a excluir al accesorio de
 * la casilla, estos dos casos se caen en `pnpm test`.
 */

const D = (v: string) => new Prisma.Decimal(v);

/**
 * Los mismos números del spec de servicios de D-388: 1 540,8 m de bobina de 1 220 × 0,28 sobre
 * 4 184 kg montados pasan la tolerancia del 1 % (y no el 5 %).
 */
const METERS = '1540.800';
const EXCESS = {
  theoreticalKg: '4252.805',
  availableKg: '4184.000',
  excessKg: '68.805',
  excessPct: '1.62',
  tolerancePct: '1',
  maxPct: '5',
  severe: false,
};

const ACTOR = { id: 'u-1', role: 'OPERARIO' } as unknown as RequestUser;

function accessoryService() {
  const order = {
    id: 'op-1',
    seq: 33,
    kind: ProductionOrderKind.ROOFING,
    status: ProductionOrderStatus.IN_PROGRESS,
    businessLineId: 'bl-1',
    productId: 'prod-acc',
    notes: null,
    closedAt: null,
    // Sin reserva: el camino de la casilla no depende del pedido.
    reservationId: null,
  };
  const consumption = {
    id: 'cons-1',
    coilId: 'c-1',
    assignedKg: D('4184.000'),
    consumedKg: D('0.000'),
    coil: {
      code: 'XSY-ALZ-ROJO-3020-0.28-4184-10',
      widthMm: D('1220.00'),
      thicknessMm: D('0.28'),
      finish: { densityFactor: D('8.0000') },
    },
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'op-1' }]),
    productionOrder: { findUniqueOrThrow: jest.fn().mockResolvedValue(order) },
    product: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        sku: 'CUMB028ROJO',
        unit: 'MTR',
        lengthMm: null,
        widthMm: D('1220.00'),
        roofingKind: 'ACCESORIO',
      }),
    },
    productionOrderItem: { findMany: jest.fn().mockResolvedValue([]) },
    productionOrderConsumption: {
      findMany: jest.fn().mockResolvedValue([consumption]),
      update: jest.fn().mockResolvedValue(undefined),
    },
    productionReport: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'r-1' }),
      update: jest.fn().mockResolvedValue(undefined),
    },
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const inventory = {
    lockInOrder: jest.fn().mockResolvedValue(undefined),
    record: jest.fn().mockResolvedValue({ id: 'm-1', totalCost: D('16736.0000') }),
  };
  const svc = Object.create(RoofingProductionService.prototype) as RoofingProductionService;
  Object.assign(svc, {
    audit,
    inventory,
    coils: { lockCoil: jest.fn().mockResolvedValue(undefined) },
  });
  const report = (input: ReportRoofingPiecesInput) =>
    svc.reportInTx(tx as unknown as Prisma.TransactionClient, ACTOR, 'op-1', input, '2026-10-05');
  return { report, tx, audit, inventory };
}

describe('RoofingProductionService.reportInTx — accesorio (metros) con la casilla, D-389', () => {
  it('sin casilla, el rechazo trae el código y las cifras, y no se escribe nada', async () => {
    const { report, tx, audit, inventory } = accessoryService();
    const err: unknown = await report({ meters: METERS }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      statusCode: 400,
      code: TOLERANCE_OVERRIDE_REQUIRED,
      excess: EXCESS,
    });
    expect(tx.productionReport.create).not.toHaveBeenCalled();
    expect(inventory.record).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('con casilla («Bobina más liviana»), entra topado en lo montado y audita la autorización', async () => {
    const { report, tx, audit, inventory } = accessoryService();
    await report({
      meters: METERS,
      toleranceOverride: { reason: 'LIGHTER_COIL', detail: 'pesó 4 184' },
    });

    // El accesorio no guarda detalle de largos: los metros van en `meters_m`.
    const created = (tx.productionReport.create.mock.calls as unknown[][])[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(created.data.metersM).toBe('1540.800');
    expect(created.data).not.toHaveProperty('piecesDetail');

    // El kardex de la bobina sale por lo montado, no por el teórico.
    const coilOut = (inventory.record.mock.calls as unknown[][])
      .map((c) => c[1] as { itemType: string; qty: string })
      .find((m) => m.itemType === 'COIL');
    expect(coilOut?.qty).toBe('4184.000');

    const actions = (audit.write.mock.calls as unknown[][]).map(
      (c) => (c[1] as { action: string }).action,
    );
    expect(actions).toEqual(['production.roofing.report', TOLERANCE_OVERRIDE_AUDIT_ACTION]);
    const overrideEntry = (audit.write.mock.calls as unknown[][])[1]?.[1] as {
      entity: string;
      entityId: string;
      after: Record<string, unknown>;
    };
    expect(overrideEntry).toMatchObject({
      entity: 'production_orders',
      entityId: 'op-1',
      after: {
        reportId: 'r-1',
        productionOrderId: 'op-1',
        coilId: 'c-1',
        theoreticalKg: EXCESS.theoreticalKg,
        realKg: '4184.000',
        differenceKg: EXCESS.excessKg,
        differencePct: EXCESS.excessPct,
        reason: 'LIGHTER_COIL',
        detail: 'pesó 4 184',
      },
    });
  });

  it('con «Bobina más pesada», el motivo no aplica a la dirección del exceso y no entra', async () => {
    const { report, tx, audit } = accessoryService();
    await expect(
      report({ meters: METERS, toleranceOverride: { reason: 'HEAVIER_COIL' } }),
    ).rejects.toThrow(/Bobina más pesada que el nominal/);
    expect(tx.productionReport.create).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });
});
