import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TOLERANCE_OVERRIDE_REQUIRED } from '@ayr/shared';
import {
  appliedToleranceOverride,
  mountedKgRejection,
  TOLERANCE_OVERRIDE_AUDIT_ACTION,
  toleranceOverrideAuditAfter,
} from './production-shared';
import { ProductionService } from './production.service';
import { draftCoilStates, draftDtos, draftRowLike, type DraftRow } from './roofing-drafts';
import { RoofingDraftsService } from './roofing-drafts.service';

/**
 * D-388 — las piezas del servicio alrededor de la casilla: el rechazo con código, la casilla que
 * de verdad se aplicó, la entrada de auditoría, el borrador (marca al leer y casilla por fila al
 * ejecutar) y la etiqueta del detalle leída de la auditoría.
 */

const D = (v: string) => new Prisma.Decimal(v);
const EXCESS = {
  theoreticalKg: '4252.805',
  availableKg: '4184.000',
  excessKg: '68.805',
  excessPct: '1.62',
  tolerancePct: '1',
  maxPct: '5',
};

describe('mountedKgRejection', () => {
  it('con código: el cuerpo lleva el código y las cifras', () => {
    const err = mountedKgRejection({
      message: 'pasa la tolerancia',
      code: TOLERANCE_OVERRIDE_REQUIRED,
      excess: EXCESS,
    });
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({
      statusCode: 400,
      code: TOLERANCE_OVERRIDE_REQUIRED,
      message: 'pasa la tolerancia',
      excess: EXCESS,
    });
  });

  it('sin código: el mensaje de siempre', () => {
    const err = mountedKgRejection({ message: 'monta más material' });
    expect(err.getResponse()).toMatchObject({ message: 'monta más material' });
    expect(err.getResponse()).not.toHaveProperty('code');
  });
});

describe('appliedToleranceOverride — la casilla que de verdad se aplicó', () => {
  const override = { reason: 'LIGHTER_COIL' as const };
  it('fuera del 1 % y con casilla: se aplica, con sus cifras', () => {
    expect(appliedToleranceOverride({ overridden: true, excess: EXCESS }, override)).toEqual({
      override,
      excess: EXCESS,
    });
  });
  it('dentro del 1 %, la casilla no deja rastro', () => {
    expect(appliedToleranceOverride({ overridden: false, excess: null }, override)).toBeNull();
  });
  it('sin casilla, nada', () => {
    expect(appliedToleranceOverride({ overridden: true, excess: EXCESS }, undefined)).toBeNull();
  });
});

describe('toleranceOverrideAuditAfter — la entrada de auditoría', () => {
  const base = {
    reportId: 'r-1',
    orderId: 'op-1',
    orderSeq: 33,
    coilId: 'c-1',
    coilCode: 'XSY-ALZ-ROJO-3020-0.28-4184-10',
    realKg: '4184.000',
  };
  it('teórico, real, diferencia en kg y %, motivo, detalle, bobina y OP', () => {
    expect(
      toleranceOverrideAuditAfter({
        ...base,
        applied: { override: { reason: 'LIGHTER_COIL', detail: 'pesó 4 184' }, excess: EXCESS },
      }),
    ).toEqual({
      reportId: 'r-1',
      productionOrderId: 'op-1',
      productionOrderCode: 'OP-000033',
      coilId: 'c-1',
      coilCode: 'XSY-ALZ-ROJO-3020-0.28-4184-10',
      theoreticalKg: '4252.805',
      realKg: '4184.000',
      differenceKg: '68.805',
      differencePct: '1.62',
      reason: 'LIGHTER_COIL',
      reasonLabel: 'Bobina más liviana que el nominal',
      detail: 'pesó 4 184',
    });
  });
  it.each([undefined, ''])('sin detalle (%j) se guarda null', (detail) => {
    const after = toleranceOverrideAuditAfter({
      ...base,
      applied: { override: { reason: 'HEAVIER_COIL', detail }, excess: EXCESS },
    });
    expect(after.detail).toBeNull();
  });
});

// --------------------------------------------------------------------------
// El borrador
// --------------------------------------------------------------------------

function draftRow(id: string, qty: number, coilId = 'c-1'): DraftRow {
  return {
    id,
    seq: 1,
    productionOrderId: 'op-1',
    coilId,
    consumedKg: null,
    notes: null,
    createdById: 'u-1',
    createdAt: new Date('2026-10-05T00:00:00Z'),
    pieces: [{ id: `p-${id}`, draftId: id, lineNumber: 1, lengthMm: D('3600.00'), qty }],
    coil: {
      code: 'XSY-ALZ-ROJO-3020-0.28-4184-10',
      widthMm: D('1220.00'),
      thicknessMm: D('0.28'),
      finish: { densityFactor: D('8.0000') },
    },
  } as unknown as DraftRow;
}

const CONSUMPTION = {
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

const STATE = {
  orderSeq: 33,
  productSku: 'COB028ROJO',
  fixedLengthMm: null,
  planPieces: [{ lengthMm: '3600', qty: 428 }],
  reportedMeters: D('0'),
  coils: draftCoilStates([CONSUMPTION]),
};

describe('draftDtos — la marca al leer', () => {
  it('la fila de la franja sale marcada con sus cifras', () => {
    const [dto] = draftDtos(STATE, [draftRow('d-1', 428)]);
    expect(dto?.outOfTolerance).toMatchObject({ excessKg: '68.805', excessPct: '1.62' });
  });

  it('dentro del 1 % no hay marca', () => {
    const [dto] = draftDtos(STATE, [draftRow('d-1', 400)]);
    expect(dto?.outOfTolerance).toBeNull();
  });

  it('si el borrador ya no valida (estado cambiado), ninguna fila se marca', () => {
    const dtos = draftDtos(STATE, [draftRow('d-1', 445)]);
    expect(dtos.map((d) => d.outOfTolerance)).toEqual([null]);
  });

  it('sin filas, nada', () => {
    expect(draftDtos(STATE, [])).toEqual([]);
  });

  it('draftRowLike y draftCoilStates leen la fila y la bobina guardadas', () => {
    expect(draftRowLike(draftRow('d-1', 428))).toEqual({
      coilId: 'c-1',
      pieces: [{ lengthMm: '3600.00', qty: 428 }],
      consumedKg: null,
    });
    expect(STATE.coils[0]?.remainingKg.toFixed(3)).toBe('4184.000');
  });
});

function draftsService(drafts: DraftRow[], status = 'IN_PROGRESS') {
  const reportInTx = jest.fn().mockResolvedValue([]);
  const order = { id: 'op-1', seq: 33, kind: 'ROOFING', status, productId: 'prod-1' };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'op-1' }]),
    productionOrder: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(order),
      findUnique: jest.fn().mockResolvedValue(order),
    },
    product: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ sku: 'COB028ROJO', lengthMm: null }),
    },
    productionOrderItem: {
      findMany: jest.fn().mockResolvedValue([{ lengthMm: D('3600.00'), qty: 428 }]),
    },
    productionReport: { findMany: jest.fn().mockResolvedValue([]) },
    productionOrderConsumption: { findMany: jest.fn().mockResolvedValue([CONSUMPTION]) },
    productionReportDraft: {
      findMany: jest.fn().mockResolvedValue(drafts),
      deleteMany: jest.fn().mockResolvedValue({ count: drafts.length }),
    },
  };
  const prisma = { ...tx, $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  const svc = Object.create(RoofingDraftsService.prototype) as RoofingDraftsService;
  Object.assign(svc, {
    prisma,
    audit: { write: jest.fn().mockResolvedValue(undefined) },
    production: { findOne: jest.fn().mockResolvedValue({ id: 'op-1' }) },
    roofing: { reportInTx, closeInTx: jest.fn(), withWarnings: (dto: unknown) => dto },
    operationDate: { resolve: () => '2026-10-05' },
  });
  return { svc, reportInTx };
}

describe('RoofingDraftsService — la casilla en el borrador', () => {
  it('list marca la fila con la orden en curso', async () => {
    const { svc } = draftsService([draftRow('d-1', 428)]);
    const [dto] = await svc.list('op-1');
    expect(dto?.outOfTolerance).toMatchObject({ excessPct: '1.62' });
  });

  it('list no marca con la orden cerrada', async () => {
    const { svc } = draftsService([draftRow('d-1', 428)], 'CLOSED');
    const [dto] = await svc.list('op-1');
    expect(dto?.outOfTolerance).toBeNull();
  });

  it('commit lleva la casilla a la fila que la trae, y a ninguna otra', async () => {
    const { svc, reportInTx } = draftsService([draftRow('d-1', 428), draftRow('d-2', 0)]);
    await svc.commit({ id: 'u-1', role: 'ADMINISTRADOR' } as never, 'op-1', {
      toleranceOverrides: [{ draftId: 'd-1', reason: 'LIGHTER_COIL', detail: 'pesó 4 184' }],
    });
    const inputs = (reportInTx.mock.calls as unknown[][]).map(
      (c) => c[3] as { toleranceOverride?: unknown },
    );
    expect(inputs[0]?.toleranceOverride).toEqual({ reason: 'LIGHTER_COIL', detail: 'pesó 4 184' });
    expect(inputs[1]).not.toHaveProperty('toleranceOverride');
  });
});

describe('ProductionService — la etiqueta del detalle, leída de la auditoría', () => {
  it('cada reporte autorizado con su motivo en palabras; lo ilegible se ignora', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        after: {
          reportId: 'r-1',
          reason: 'OTHER',
          detail: 'Rollo con espesor real menor',
          differenceKg: '68.805',
          differencePct: '1.62',
        },
      },
      { after: { reportId: 'r-2', reason: 'NO-ES-UN-MOTIVO' } },
    ]);
    const svc = Object.create(ProductionService.prototype) as ProductionService;
    Object.assign(svc, { prisma: { auditLog: { findMany } } });
    const byReport = await (
      svc as unknown as {
        reportToleranceOverrides: (id: string, has: boolean) => Promise<Map<string, unknown>>;
      }
    ).reportToleranceOverrides('op-1', true);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        entity: 'production_orders',
        entityId: 'op-1',
        action: TOLERANCE_OVERRIDE_AUDIT_ACTION,
      },
      select: { after: true },
    });
    expect(byReport.get('r-1')).toEqual({
      reason: 'OTHER',
      detail: 'Rollo con espesor real menor',
      label: 'Rollo con espesor real menor',
      excessKg: '68.805',
      excessPct: '1.62',
    });
    expect(byReport.has('r-2')).toBe(false);
  });

  it('sin reportes no consulta', async () => {
    const findMany = jest.fn();
    const svc = Object.create(ProductionService.prototype) as ProductionService;
    Object.assign(svc, { prisma: { auditLog: { findMany } } });
    await (
      svc as unknown as { reportToleranceOverrides: (id: string, has: boolean) => Promise<unknown> }
    ).reportToleranceOverrides('op-1', false);
    expect(findMany).not.toHaveBeenCalled();
  });
});
