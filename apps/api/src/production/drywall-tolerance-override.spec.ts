import { BadRequestException } from '@nestjs/common';
import { Prisma, ProductionOrderKind, ProductionOrderStatus } from '@prisma/client';
import {
  DRYWALL_TOLERANCE_OVERRIDE_REASON_LABELS,
  DRYWALL_TOLERANCE_OVERRIDE_REASONS,
  drywallToleranceOverrideLabel,
  drywallToleranceOverrideSchema,
  reportPiecesSchema,
  TOLERANCE_OVERRIDE_REQUIRED,
} from '@ayr/shared';
import type { AuditService } from '../audit/audit.service';
import type { CoilsService } from '../coils/coils.service';
import type { OperationDateService } from '../common/operation-date.service';
import type { InventoryService } from '../inventory/inventory.service';
import type { PrismaService } from '../prisma/prisma.service';
import { DRYWALL_TOLERANCE_OVERRIDE_AUDIT_ACTION } from './production-shared';
import { ProductionService } from './production.service';

/**
 * D-465 (cc29) — el reporte de drywall pasado el 1 % entra con la casilla de D-389, igual que
 * coberturas: sin casilla, 400 con código y cifras; con casilla, entra, se topa en lo montado (la
 * suma de los flejes de la orden) y deja su auditoría propia. Sin borrador: drywall reporta directo.
 */

const D = (v: string) => new Prisma.Decimal(v);
const ADMIN = { id: 'u-1', role: 'ADMINISTRADOR' } as never;

/** Perfil de 2 kg por pieza; dos flejes montados: 600 kg y 400 kg, 1 000 kg en total. */
function build() {
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const coils = { lockCoil: jest.fn().mockResolvedValue(undefined) };
  const inventory = {
    lockInOrder: jest.fn().mockResolvedValue(undefined),
    record: jest.fn().mockResolvedValue({ totalCost: D('3000.0000') }),
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'o-1' }]),
    productionOrder: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'o-1',
        seq: 7,
        kind: ProductionOrderKind.DRYWALL,
        status: ProductionOrderStatus.IN_PROGRESS,
        businessLineId: 'bl-drywall',
        productId: 'p-1',
        notes: null,
        closedAt: null,
        reservationId: null,
      }),
    },
    productionReport: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'r-1' }),
      update: jest.fn().mockResolvedValue(undefined),
    },
    product: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ sku: 'OMEGA', pieceWeightKg: D('2.000') }),
    },
    productionOrderConsumption: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'k-1',
          coilId: 'c-1',
          assignedKg: D('600.000'),
          consumedKg: D('0.000'),
          coil: { code: 'FLEJE-1' },
        },
        {
          id: 'k-2',
          coilId: 'c-2',
          assignedKg: D('400.000'),
          consumedKg: D('0.000'),
          coil: { code: 'FLEJE-2' },
        },
      ]),
      update: jest.fn().mockResolvedValue(undefined),
    },
  };
  const prisma = {
    $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
  const operationDate = { resolve: jest.fn().mockReturnValue('2026-10-06') };
  const service = new ProductionService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    inventory as unknown as InventoryService,
    coils as unknown as CoilsService,
    operationDate as unknown as OperationDateService,
  );
  jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'o-1' } as never);
  return { service, tx, audit, inventory };
}

function outs(inventory: ReturnType<typeof build>['inventory']) {
  return (inventory.record.mock.calls as [unknown, { type: string; qty: string }][])
    .map((c) => c[1])
    .filter((m) => m.type === 'OUT')
    .map((m) => m.qty);
}

function auditActions(audit: ReturnType<typeof build>['audit']) {
  return (audit.write.mock.calls as [unknown, { action: string }][]).map((c) => c[1].action);
}

describe('D-465 — los motivos de drywall', () => {
  it('son los cuatro del dueño, con su texto', () => {
    expect(
      DRYWALL_TOLERANCE_OVERRIDE_REASONS.map((r) => DRYWALL_TOLERANCE_OVERRIDE_REASON_LABELS[r]),
    ).toEqual([
      'Fleje más liviano que el nominal',
      'Fleje más pesado que el nominal',
      'Peso por pieza del SKU desactualizado',
      'Otro',
    ]);
  });

  it('«Otro» exige el texto; los demás no', () => {
    expect(drywallToleranceOverrideSchema.safeParse({ reason: 'OTHER' }).success).toBe(false);
    expect(
      drywallToleranceOverrideSchema.safeParse({ reason: 'OTHER', detail: '  ' }).success,
    ).toBe(false);
    expect(
      drywallToleranceOverrideSchema.safeParse({ reason: 'OTHER', detail: 'Rollo mal rotulado' })
        .success,
    ).toBe(true);
    expect(drywallToleranceOverrideSchema.safeParse({ reason: 'HEAVIER_STRIP' }).success).toBe(
      true,
    );
  });

  it('un motivo de coberturas no es de drywall', () => {
    expect(drywallToleranceOverrideSchema.safeParse({ reason: 'LIGHTER_COIL' }).success).toBe(
      false,
    );
  });

  it('la etiqueta: el motivo con su detalle, u «Otro» es el detalle mismo', () => {
    expect(drywallToleranceOverrideLabel({ reason: 'LIGHTER_STRIP', detail: 'pesó 590' })).toBe(
      'Fleje más liviano que el nominal: pesó 590',
    );
    expect(drywallToleranceOverrideLabel({ reason: 'OTHER', detail: 'Rollo mal rotulado' })).toBe(
      'Rollo mal rotulado',
    );
  });

  it('el reporte de piezas acepta la casilla, y sigue valiendo sin ella', () => {
    expect(reportPiecesSchema.safeParse({ pieces: 10 }).success).toBe(true);
    expect(
      reportPiecesSchema.safeParse({
        pieces: 10,
        toleranceOverride: { reason: 'STALE_PIECE_WEIGHT' },
      }).success,
    ).toBe(true);
  });
});

describe('ProductionService.report — drywall con la casilla de D-389 (D-465)', () => {
  it('dentro del teórico: sale el teórico, repartido en orden de montaje, sin auditoría de casilla', async () => {
    const { service, audit, inventory } = build();
    await service.report(ADMIN, 'o-1', { pieces: 400 });
    expect(outs(inventory)).toEqual(['600.000', '200.000']);
    expect(auditActions(audit)).toEqual(['production.report']);
  });

  it('hasta el 1 %: se topa en lo montado sin casilla, como siempre (D-246)', async () => {
    const { service, audit, inventory } = build();
    // 505 piezas = 1 010 kg contra 1 000 kg: 0,99 %.
    await service.report(ADMIN, 'o-1', { pieces: 505 });
    expect(outs(inventory)).toEqual(['600.000', '400.000']);
    expect(auditActions(audit)).toEqual(['production.report']);
  });

  it('pasado el 1 % sin casilla: 400 con código y cifras, y nada se mueve', async () => {
    const { service, tx, audit, inventory } = build();
    // 510 piezas = 1 020 kg contra 1 000 kg: 20 kg, 1,97 % redondeado hacia arriba.
    const error = await service.report(ADMIN, 'o-1', { pieces: 510 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    const body = (error as BadRequestException).getResponse();
    expect(body).toMatchObject({
      statusCode: 400,
      code: TOLERANCE_OVERRIDE_REQUIRED,
      excess: {
        theoreticalKg: '1020.000',
        availableKg: '1000.000',
        excessKg: '20.000',
        excessPct: '1.97',
        tolerancePct: '1',
        severe: false,
      },
    });
    expect((body as { message: string }).message).toContain('OP-000007 tiene 1000.000 kg montados');
    expect((body as { message: string }).message).toContain('consume otro fleje');
    expect(inventory.record).not.toHaveBeenCalled();
    expect(tx.productionReport.create).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('pasado el 1 % con casilla: entra, se topa en lo montado y audita con su acción propia', async () => {
    const { service, tx, audit, inventory } = build();
    await service.report(ADMIN, 'o-1', {
      pieces: 510,
      toleranceOverride: { reason: 'HEAVIER_STRIP', detail: 'rollo de 610 kg' },
    });
    // Lo que sale del kardex nunca pasa lo montado.
    expect(outs(inventory)).toEqual(['600.000', '400.000']);
    expect(auditActions(audit)).toEqual([
      DRYWALL_TOLERANCE_OVERRIDE_AUDIT_ACTION,
      'production.report',
    ]);
    const after = (audit.write.mock.calls[0] as [unknown, { after: unknown }])[1].after;
    expect(after).toEqual({
      reportId: 'r-1',
      productionOrderId: 'o-1',
      productionOrderCode: 'OP-000007',
      strips: [
        { coilId: 'c-1', coilCode: 'FLEJE-1', kg: '600.000' },
        { coilId: 'c-2', coilCode: 'FLEJE-2', kg: '400.000' },
      ],
      theoreticalKg: '1020.000',
      realKg: '1000.000',
      differenceKg: '20.000',
      differencePct: '1.97',
      severe: false,
      reason: 'HEAVIER_STRIP',
      reasonLabel: 'Fleje más pesado que el nominal',
      detail: 'rollo de 610 kg',
    });
    const update = tx.productionReport.update.mock.calls[0] as [
      { data: { rawMaterialWarning: string } },
    ];
    expect(update[0].data.rawMaterialWarning).toMatch(
      /^Fuera de tolerancia, confirmado con la casilla: Fleje más pesado que el nominal: rollo de 610 kg\. OP-000007: el material rindió más/,
    );
  });

  it('pasado el 5 %: aviso fuerte, pero con casilla tampoco bloquea', async () => {
    const { service, audit, inventory } = build();
    // 560 piezas = 1 120 kg contra 1 000 kg: 10,72 %.
    const error = await service.report(ADMIN, 'o-1', { pieces: 560 }).catch((e: unknown) => e);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: TOLERANCE_OVERRIDE_REQUIRED,
      excess: { excessPct: '10.72', severe: true },
    });
    expect((error as BadRequestException).message).toMatch(/^Diferencia mayor al 5 %/);

    await service.report(ADMIN, 'o-1', {
      pieces: 560,
      toleranceOverride: { reason: 'OTHER', detail: 'Peso del rollo sin rotular' },
    });
    expect(outs(inventory)).toEqual(['600.000', '400.000']);
    const after = (audit.write.mock.calls[0] as [unknown, { after: { severe: boolean } }])[1].after;
    expect(after.severe).toBe(true);
  });

  it('una casilla dentro del 1 % no deja rastro (se topa en lo montado, sin auditoría de casilla)', async () => {
    const { service, audit, inventory } = build();
    // 505 piezas = 1 010 kg contra 1 000 kg: 0,99 %, dentro de la tolerancia.
    await service.report(ADMIN, 'o-1', {
      pieces: 505,
      toleranceOverride: { reason: 'LIGHTER_STRIP' },
    });
    expect(outs(inventory)).toEqual(['600.000', '400.000']);
    expect(auditActions(audit)).toEqual(['production.report']);
  });
});
