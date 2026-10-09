import { BadRequestException } from '@nestjs/common';
import { Decimal, roofingPlanGap } from '@ayr/shared';
import { RoofingDraftsService } from './roofing-drafts.service';
import { RoofingProductionService } from './roofing-production.service';

/**
 * **cc38 (D-573, D-574) — la orden se cierra solo con el plan completo y nunca registra más.**
 *
 * La regla vive en `closeInTx`, la puerta común de los tres caminos de cierre (close,
 * report-and-close y el commit del borrador con close=true) y de sus vistas previas. Estas pruebas
 * corren el código real de esos caminos sobre una transacción de mentira: una orden con su plan,
 * sus reportes vigentes y su reserva. Pasada la puerta, el cierre sigue con las bobinas montadas;
 * esa lectura lanza `PASÓ_LA_PUERTA`, que es como se distingue «cerró» de «la regla rechazó» sin
 * montar el resto del cierre (eso lo cubre la E2E `cierre-plan-completo-cc38`).
 */

const D = (v: string) => new Decimal(v);
const ACTOR = { id: 'u-1', role: 'ADMINISTRADOR' } as never;
const PASSED = 'PASÓ_LA_PUERTA';

interface Piece {
  lengthMm: string;
  qty: number;
}

interface Setup {
  kind?: 'A_MEDIDA' | 'PLANCHA' | 'ACCESORIO';
  plan?: Piece[];
  /** Largos de los reportes vigentes (a medida y plancha). */
  reported?: Piece[];
  /** Metros de bobina de los reportes vigentes (accesorio). */
  reportedMeters?: string;
  /** Metros que encargó la línea del pedido (accesorio). */
  orderedMeters?: string;
  /** Filas del borrador, como largos. */
  drafts?: Piece[][];
}

function harness(setup: Setup) {
  const kind = setup.kind ?? 'A_MEDIDA';
  const reports: { id: string; metersM: Decimal | null; piecesDetail: unknown[] }[] = [];
  const addReport = (pieces: Piece[] | null, meters: string | null) =>
    reports.push({
      id: `r-${String(reports.length + 1)}`,
      consumedKg: null,
      metersM: meters === null ? null : D(meters),
      piecesDetail: (pieces ?? []).map((p) => ({ lengthMm: D(p.lengthMm), qty: p.qty })),
    } as never);
  if (setup.reported) addReport(setup.reported, null);
  if (setup.reportedMeters) addReport(null, setup.reportedMeters);

  const drafts = (setup.drafts ?? []).map((pieces, i) => ({
    id: `d-${String(i + 1)}`,
    coilId: 'coil-1',
    consumedKg: null,
    notes: null,
    pieces: pieces.map((p, n) => ({ lineNumber: n + 1, lengthMm: D(p.lengthMm), qty: p.qty })),
    coil: {
      code: 'BOB-1',
      widthMm: D('1000.00'),
      thicknessMm: D('0.50'),
      finish: { densityFactor: D('8.0000') },
    },
  }));

  const order = {
    id: 'op-1',
    seq: 130,
    kind: 'ROOFING',
    status: 'IN_PROGRESS',
    businessLineId: 'bl-1',
    productId: 'prod-1',
    notes: null,
    closedAt: null,
    reservationId: 'res-1',
    reservation: { salesOrderId: 'so-1' },
  };
  const writes: string[] = [];
  const write = (name: string) =>
    jest.fn(() => {
      writes.push(name);
      return Promise.resolve({ count: 0 });
    });
  const tx = {
    // `lockDocuments`: cada `FOR UPDATE` devuelve las filas que pidió.
    $queryRaw: jest.fn((_sql: unknown, ids: unknown) =>
      Promise.resolve(Array.isArray(ids) ? ids.map((id: unknown) => ({ id })) : []),
    ),
    productionOrder: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ ...order, scrapKg: null }),
      findUnique: jest.fn().mockResolvedValue(order),
    },
    product: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        sku: 'COB050ROJO',
        unit: 'MTR',
        lengthMm: kind === 'PLANCHA' ? D('3000.00') : null,
        widthMm: D('1000.00'),
        roofingKind: kind,
      }),
    },
    productionOrderItem: {
      findMany: jest
        .fn()
        .mockResolvedValue((setup.plan ?? []).map((p) => ({ lengthMm: D(p.lengthMm), qty: p.qty }))),
    },
    productionReport: {
      count: jest.fn(() => Promise.resolve(reports.length)),
      findMany: jest.fn((args: { where?: { id?: { in?: string[] } } }) => {
        const ids = args.where?.id?.in;
        return Promise.resolve(ids ? reports.filter((r) => ids.includes(r.id)) : reports);
      }),
    },
    productionReportDraft: {
      count: jest.fn(() => Promise.resolve(0)),
      findMany: jest.fn().mockResolvedValue(drafts),
      deleteMany: write('productionReportDraft.deleteMany'),
    },
    productionOrderConsumption: {
      findMany: jest.fn((args: { include?: { coil?: { select?: Record<string, unknown> } } }) => {
        const select = args.include?.coil?.select;
        // La del cierre (después de la puerta) pide solo el código de la bobina.
        if (select && !('widthMm' in select)) return Promise.reject(new Error(PASSED));
        return Promise.resolve([
          {
            id: 'c-1',
            coilId: 'coil-1',
            assignedKg: D('2000'),
            consumedKg: D('0'),
            coil: {
              code: 'BOB-1',
              widthMm: D('1000.00'),
              thicknessMm: D('0.50'),
              finish: { densityFactor: D('8.0000') },
            },
          },
        ]);
      }),
    },
    reservation: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        salesOrderItem: { qty: D(setup.orderedMeters ?? '0') },
      }),
    },
    inventoryMovement: { findMany: jest.fn().mockResolvedValue([]) },
    coil: { findMany: jest.fn().mockResolvedValue([]) },
    inventoryBalance: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const prisma = {
    ...tx,
    $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };

  const roofing = Object.create(RoofingProductionService.prototype) as RoofingProductionService;
  Object.assign(roofing, {
    prisma,
    operationDate: { resolve: () => '2026-10-09' },
    production: { findOne: jest.fn().mockResolvedValue({ id: 'op-1' }) },
  });
  // El reporte de report-and-close y del commit se simula: deja un reporte vigente más, que la
  // puerta tiene que contar porque entra en la misma transacción.
  const reportInTx = jest
    .spyOn(roofing, 'reportInTx')
    .mockImplementation((_tx, _actor, _id, input) => {
      addReport(input.pieces ?? null, input.meters ?? null);
      return Promise.resolve([]);
    });

  const drafting = Object.create(RoofingDraftsService.prototype) as RoofingDraftsService;
  Object.assign(drafting, {
    prisma,
    audit: { write: jest.fn().mockResolvedValue(undefined) },
    production: { findOne: jest.fn().mockResolvedValue({ id: 'op-1' }) },
    roofing,
    operationDate: { resolve: () => '2026-10-09' },
  });

  return { roofing, drafting, reportInTx, writes };
}

/** Plan de 10 × 4 m = 40 m. */
const PLAN = [{ lengthMm: '4000.00', qty: 10 }];
const SHORT = 'Para cerrar falta registrar 8.000 m del plan';

describe('roofingPlanGap (D-573, D-574)', () => {
  it('compara con tres decimales y nunca da faltante y exceso a la vez', () => {
    expect(roofingPlanGap('40.000', '32.000')).toEqual({ missing: D('8'), excess: D('0') });
    expect(roofingPlanGap('40.000', '40.0004')).toEqual({ missing: D('0'), excess: D('0') });
    expect(roofingPlanGap('40.000', '40.001').excess.toFixed(3)).toBe('0.001');
    expect(roofingPlanGap('40.000', '39.999').missing.toFixed(3)).toBe('0.001');
  });
});

describe('D-573 — los tres caminos de cierre con el plan incompleto', () => {
  it('close: 400 con el texto exacto', async () => {
    const h = harness({ plan: PLAN, reported: [{ lengthMm: '4000.00', qty: 8 }] });
    await expect(h.roofing.close(ACTOR, 'op-1', {})).rejects.toThrow(
      new BadRequestException(SHORT),
    );
  });

  it('report-and-close: cuenta lo que registra en el mismo acto y aun así falta', async () => {
    const h = harness({ plan: PLAN, reported: [{ lengthMm: '4000.00', qty: 6 }] });
    await expect(
      h.roofing.reportAndClose(ACTOR, 'op-1', { pieces: [{ lengthMm: '4000.00', qty: 2 }] }),
    ).rejects.toThrow(SHORT);
    expect(h.reportInTx).toHaveBeenCalledTimes(1);
  });

  it('commit del borrador con close=true: cuenta las filas del borrador y aun así falta', async () => {
    const h = harness({
      plan: PLAN,
      reported: [{ lengthMm: '4000.00', qty: 6 }],
      drafts: [[{ lengthMm: '4000.00', qty: 2 }]],
    });
    await expect(h.drafting.commit(ACTOR, 'op-1', { close: true })).rejects.toThrow(SHORT);
    expect(h.reportInTx).toHaveBeenCalledTimes(1);
  });

  it('commit con close=true y el borrador vacío: también pasa por la regla', async () => {
    const h = harness({ plan: PLAN, reported: [{ lengthMm: '4000.00', qty: 8 }] });
    await expect(h.drafting.commit(ACTOR, 'op-1', { close: true })).rejects.toThrow(SHORT);
  });

  it('las vistas previas devuelven el mismo error (previewCommit, previewClose, previewReportAndClose)', async () => {
    const commit = harness({
      plan: PLAN,
      reported: [{ lengthMm: '4000.00', qty: 6 }],
      drafts: [[{ lengthMm: '4000.00', qty: 2 }]],
    });
    await expect(
      commit.drafting.previewCommit(ACTOR, 'op-1', { close: true }),
    ).rejects.toThrow(SHORT);
    const close = harness({ plan: PLAN, reported: [{ lengthMm: '4000.00', qty: 8 }] });
    await expect(close.roofing.previewClose(ACTOR, 'op-1', {})).rejects.toThrow(SHORT);
    const rc = harness({ plan: PLAN, reported: [{ lengthMm: '4000.00', qty: 6 }] });
    await expect(
      rc.roofing.previewReportAndClose(ACTOR, 'op-1', {
        pieces: [{ lengthMm: '4000.00', qty: 2 }],
      }),
    ).rejects.toThrow(SHORT);
  });

  it('el rechazo no deja escrituras fuera de la transacción: el borrado del borrador es parte de ella', async () => {
    // El commit borra las filas del borrador antes de cerrar; si el cierre rechaza, la
    // transacción entera se deshace. Acá se comprueba que el rechazo sale de **adentro** del
    // callback de `$transaction` (después del borrado), que es lo que la deshace.
    const h = harness({
      plan: PLAN,
      reported: [{ lengthMm: '4000.00', qty: 6 }],
      drafts: [[{ lengthMm: '4000.00', qty: 2 }]],
    });
    await expect(h.drafting.commit(ACTOR, 'op-1', { close: true })).rejects.toThrow(SHORT);
    expect(h.writes).toEqual(['productionReportDraft.deleteMany']);
  });
});

describe('D-573 — el plan exacto pasa la puerta', () => {
  it('close con lo registrado igual al plan', async () => {
    const h = harness({ plan: PLAN, reported: [{ lengthMm: '4000.00', qty: 10 }] });
    await expect(h.roofing.close(ACTOR, 'op-1', {})).rejects.toThrow(PASSED);
  });

  it('report-and-close que completa el plan en el mismo acto', async () => {
    const h = harness({ plan: PLAN, reported: [{ lengthMm: '4000.00', qty: 8 }] });
    await expect(
      h.roofing.reportAndClose(ACTOR, 'op-1', { pieces: [{ lengthMm: '4000.00', qty: 2 }] }),
    ).rejects.toThrow(PASSED);
  });

  it('commit con close=true cuyo borrador completa el plan', async () => {
    const h = harness({
      plan: PLAN,
      reported: [{ lengthMm: '4000.00', qty: 6 }],
      drafts: [[{ lengthMm: '4000.00', qty: 4 }]],
    });
    await expect(h.drafting.commit(ACTOR, 'op-1', { close: true })).rejects.toThrow(PASSED);
  });

  it('no exige cada largo: otros largos que suman los mismos metros cierran', async () => {
    const h = harness({ plan: PLAN, reported: [{ lengthMm: '5000.00', qty: 8 }] });
    await expect(h.roofing.close(ACTOR, 'op-1', {})).rejects.toThrow(PASSED);
  });

  it('plancha: metros = planchas × largo fijo; falta una plancha y no cierra', async () => {
    const plan = [{ lengthMm: '3000.00', qty: 12 }];
    const short = harness({ kind: 'PLANCHA', plan, reported: [{ lengthMm: '3000.00', qty: 11 }] });
    await expect(short.roofing.close(ACTOR, 'op-1', {})).rejects.toThrow(
      'Para cerrar falta registrar 3.000 m del plan',
    );
    const full = harness({ kind: 'PLANCHA', plan, reported: [{ lengthMm: '3000.00', qty: 12 }] });
    await expect(full.roofing.close(ACTOR, 'op-1', {})).rejects.toThrow(PASSED);
  });

  it('accesorio: se compara contra los metros de la orden', async () => {
    const short = harness({ kind: 'ACCESORIO', orderedMeters: '20', reportedMeters: '13.500' });
    await expect(short.roofing.close(ACTOR, 'op-1', {})).rejects.toThrow(
      'Para cerrar falta registrar 6.500 m del plan',
    );
    const rc = harness({ kind: 'ACCESORIO', orderedMeters: '20', reportedMeters: '13.500' });
    await expect(
      rc.roofing.reportAndClose(ACTOR, 'op-1', { meters: '6.500' }),
    ).rejects.toThrow(PASSED);
  });

  it('un total ya por encima del plan (dato anterior a D-574) tampoco cierra', async () => {
    const h = harness({ plan: PLAN, reported: [{ lengthMm: '4000.00', qty: 11 }] });
    await expect(h.roofing.close(ACTOR, 'op-1', {})).rejects.toThrow(
      'Excede el plan en 4.000 m · ajusta el plan',
    );
  });
});

describe('D-574 — el exceso en el commit del borrador', () => {
  it('una fila que pasa el plan rechaza el commit entero con su número de fila', async () => {
    const h = harness({
      plan: PLAN,
      reported: [{ lengthMm: '4000.00', qty: 6 }],
      drafts: [[{ lengthMm: '4000.00', qty: 2 }], [{ lengthMm: '4000.00', qty: 3 }]],
    });
    await expect(h.drafting.commit(ACTOR, 'op-1', {})).rejects.toThrow(
      'Fila 2: Excede el plan en 4.000 m · ajusta el plan',
    );
    expect(h.reportInTx).not.toHaveBeenCalled();
  });
});
