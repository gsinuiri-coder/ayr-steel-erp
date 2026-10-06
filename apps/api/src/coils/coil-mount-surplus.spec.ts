import { ForbiddenException } from '@nestjs/common';
import { CoilStatus, Prisma, type Coil } from '@prisma/client';
import { mountRoofingCoilSchema } from '@ayr/shared';
import type { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import type { OperationDateService } from '../common/operation-date.service';
import type { Env } from '../config/env';
import type { InventoryService } from '../inventory/inventory.service';
import type { PrismaService } from '../prisma/prisma.service';
import { CoilOperationsService } from './coil-operations.service';
import type { CoilsService } from './coils.service';

/**
 * cc29 (M3, D-466) — el sobrante de una bobina terminada con el kardex en 0, declarado al montarla:
 * quién lo declara, su cota física, su costo (el del sobrante de D-164), que apunta al montaje y
 * que la reapertura no lo revierte; y su reversa al bajar la bobina.
 */

const D = (v: string) => new Prisma.Decimal(v);
const COIL = 'c0000000-0000-4000-a000-000000000001';
const as = (role: string) => ({ id: 'u-1', role }) as unknown as RequestUser;

const coil = {
  id: COIL,
  code: 'BOB-1',
  businessLineId: 'bl-1',
  status: CoilStatus.OPEN,
  weightKg: D('500.000'),
  unitCostPerKg: D('4.0000'),
  exchangeRate: D('1.000000'),
} as unknown as Coil;

function build(balance: { qty: string; avgCost: string } | null) {
  const record = jest
    .fn()
    .mockImplementation((_tx: unknown, m: { qty: string; unitCost: string }) =>
      Promise.resolve({
        id: 99n,
        qty: D(m.qty),
        totalCost: D(m.qty).times(m.unitCost),
      }),
    );
  const reverse = jest
    .fn()
    .mockResolvedValue({ id: 100n, qty: D('120.000'), totalCost: D('480.0000') });
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const tx = {
    inventoryBalance: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          balance === null ? null : { qty: D(balance.qty), avgCost: D(balance.avgCost) },
        ),
    },
    inventoryMovement: { findFirst: jest.fn() },
  };
  const service = new CoilOperationsService(
    {} as PrismaService,
    audit as unknown as AuditService,
    { record, reverse } as unknown as InventoryService,
    {} as CoilsService,
    {} as OperationDateService,
    {} as Env,
  );
  return { service, tx, record, reverse, audit };
}

const declare = (
  s: CoilOperationsService,
  tx: unknown,
  role = 'SUPERVISOR_PLANTA',
  physicalKg = '120.000',
) =>
  s.declareMountSurplusInTx(
    tx as Prisma.TransactionClient,
    as(role),
    coil,
    { physicalKg, reason: 'quedaba material', consumptionId: 'k-1', orderCode: 'OP-000007' },
    '2026-10-06',
  );

describe('declareMountSurplusInTx (D-466)', () => {
  it('entra como sobrante de D-164 (CLOSE_ADJUSTMENT de entrada) apuntando al montaje, y se audita', async () => {
    const { service, tx, record, audit } = build({ qty: '0.000', avgCost: '4.2000' });
    const summary = await declare(service, tx);
    expect(record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        itemType: 'COIL',
        itemId: COIL,
        type: 'IN',
        qty: '120.000',
        // El costo del sobrante de D-164: el promedio vigente, si lo hay.
        unitCost: '4.2000',
        refType: 'CLOSE_ADJUSTMENT',
        refId: 'k-1',
      }),
    );
    expect(summary).toMatchObject({ kind: 'SURPLUS', qtyKg: '120.000' });
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'coils.mount-surplus', entityId: COIL }),
    );
  });

  it('sin promedio vigente, el costo del documento de compra (D-164)', async () => {
    const { service, tx, record } = build(null);
    await declare(service, tx, 'ADMINISTRADOR');
    expect(record).toHaveBeenCalledWith(tx, expect.objectContaining({ unitCost: '4.0000' }));
  });

  it('una bobina que salió del almacén por otro camino (venta, partido, corte) no declara sobrante', async () => {
    const { service, tx, record } = build({ qty: '0.000', avgCost: '4.0000' });
    tx.inventoryMovement.findFirst.mockResolvedValueOnce({ refType: 'SALE' });
    await expect(declare(service, tx)).rejects.toThrow(/salió del almacén por venta/);
    expect(tx.inventoryMovement.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          itemId: COIL,
          type: 'OUT',
          refType: { notIn: ['PRODUCTION', 'SCRAP', 'CLOSE_ADJUSTMENT'] },
        }),
      }),
    );
    expect(record).not.toHaveBeenCalled();
  });

  it('solo planta y el administrador declaran el peso físico', async () => {
    const { service, tx, record } = build({ qty: '0.000', avgCost: '4.0000' });
    await expect(declare(service, tx, 'VENDEDOR')).rejects.toBeInstanceOf(ForbiddenException);
    expect(record).not.toHaveBeenCalled();
  });

  it('con kilos en el kardex no se declara; ni más de lo que la bobina pesó al entrar', async () => {
    const withStock = build({ qty: '10.000', avgCost: '4.0000' });
    await expect(declare(withStock.service, withStock.tx)).rejects.toThrow(/kg en el kardex/);
    const tooMuch = build({ qty: '0.000', avgCost: '4.0000' });
    await expect(declare(tooMuch.service, tooMuch.tx, 'ADMINISTRADOR', '500.001')).rejects.toThrow(
      /no puede tener más material del que ingresó/,
    );
    expect(withStock.record).not.toHaveBeenCalled();
    expect(tooMuch.record).not.toHaveBeenCalled();
  });
});

describe('la reapertura no revierte el sobrante de un montaje (D-466)', () => {
  const reopen = (s: CoilOperationsService, tx: unknown) =>
    s.reopenInTx(tx as Prisma.TransactionClient, as('ADMINISTRADOR'), COIL, 'motivo', '2026-10-06');

  function withLast(last: { refId: string; type: string }) {
    const ctx = build({ qty: '120.000', avgCost: '4.0000' });
    const tx = {
      ...ctx.tx,
      $queryRaw: jest.fn().mockResolvedValue([]),
      productionOrderConsumption: { findMany: jest.fn().mockResolvedValue([]) },
      coil: { update: jest.fn().mockResolvedValue(undefined) },
    };
    tx.inventoryMovement.findFirst.mockResolvedValue({
      id: 7n,
      refType: 'CLOSE_ADJUSTMENT',
      qty: D('120.000'),
      reversals: [],
      ...last,
    });
    Object.assign(ctx.service, {
      coils: { lockCoil: jest.fn().mockResolvedValue({ ...coil, status: CoilStatus.CLOSED }) },
    });
    return { ...ctx, tx };
  }

  it('el ajuste de un cierre (apunta a la bobina) sí se revierte', async () => {
    const { service, tx, reverse } = withLast({ refId: COIL, type: 'IN' });
    await reopen(service, tx);
    expect(reverse).toHaveBeenCalled();
  });

  it('el sobrante de un montaje (apunta al consumo) no', async () => {
    const { service, tx, reverse } = withLast({ refId: 'k-1', type: 'IN' });
    await reopen(service, tx);
    expect(reverse).not.toHaveBeenCalled();
  });
});

describe('reverseMountSurplusInTx — la reversa al bajar la bobina', () => {
  it('deshace el sobrante de ese montaje y lo audita; sin sobrante, nada', async () => {
    const { service, tx, reverse, audit } = build(null);
    tx.inventoryMovement.findFirst.mockResolvedValueOnce({ id: 7n });
    const done = await service.reverseMountSurplusInTx(
      tx as unknown as Prisma.TransactionClient,
      as('SUPERVISOR_PLANTA'),
      COIL,
      'k-1',
      '2026-10-06',
    );
    expect(tx.inventoryMovement.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ refType: 'CLOSE_ADJUSTMENT', refId: 'k-1', itemId: COIL }),
    });
    expect(reverse).toHaveBeenCalledWith(tx, 7n, 'u-1', expect.any(String), '2026-10-06');
    expect(done).toMatchObject({ kind: 'SURPLUS', reversalOfId: '7' });
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'coils.mount-surplus-reverse' }),
    );

    tx.inventoryMovement.findFirst.mockResolvedValueOnce(null);
    reverse.mockClear();
    expect(
      await service.reverseMountSurplusInTx(
        tx as unknown as Prisma.TransactionClient,
        as('SUPERVISOR_PLANTA'),
        COIL,
        'k-2',
        '2026-10-06',
      ),
    ).toBeNull();
    expect(reverse).not.toHaveBeenCalled();
  });
});

describe('el schema del montaje (D-466)', () => {
  const coilId = COIL;
  it('el peso físico va con una sola bobina que se reabre', () => {
    const ok = mountRoofingCoilSchema.safeParse({
      coilId,
      reopenCoilIds: [coilId],
      reopenReason: 'quedaba material',
      physicalKg: '120.000',
    });
    expect(ok.success).toBe(true);
    expect(mountRoofingCoilSchema.safeParse({ coilId, physicalKg: '120.000' }).success).toBe(false);
    expect(
      mountRoofingCoilSchema.safeParse({
        coilIds: [coilId],
        reopenCoilIds: [coilId],
        reopenReason: 'quedaba material',
        physicalKg: '120.000',
      }).success,
    ).toBe(false);
  });
});
