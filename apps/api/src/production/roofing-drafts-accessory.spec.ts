import { Prisma } from '@prisma/client';
import { Decimal, roofingReportDraftInputSchema } from '@ayr/shared';
import { checkDraftRows, mathPieces, type DraftCheckState, type DraftRow } from './roofing-drafts';
import { RoofingDraftsService } from './roofing-drafts.service';

/**
 * cc41 (D-591): la validación del borrador con filas de **accesorio** (metros de bobina, D-343).
 *
 * Geometría a mano: 1 000 mm × 0.50 mm, densidad 8.0 ⇒ 4 kg/m, más el 1 % de D-165 ⇒ 4.04.
 */

const geometry = { widthMm: '1000.00', thicknessMm: '0.50', densityFactor: '8.0000' };

function state(overrides: Partial<DraftCheckState> = {}): DraftCheckState {
  return {
    orderSeq: 9,
    productSku: 'ACC-050-GRIS',
    fixedLengthMm: null,
    planPieces: [],
    reportedMeters: new Decimal(0),
    coils: [
      { coilId: 'c1', coilCode: 'B-1', remainingKg: new Decimal('500'), geometry },
      { coilId: 'c2', coilCode: 'B-2', remainingKg: new Decimal('500'), geometry },
    ],
    accessory: { orderedMeters: new Decimal('10') },
    ...overrides,
  };
}

describe('checkDraftRows con un accesorio (cc41, D-591)', () => {
  it('mide cada fila por sus metros: kilo teórico y metros acumulados', () => {
    const result = checkDraftRows(state(), [
      { coilId: 'c1', pieces: [], meters: '3.500' },
      { coilId: 'c2', pieces: [], meters: '6.500' },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows.map((r) => [r.meters.toFixed(3), r.theoreticalKg.toFixed(3)])).toEqual([
        ['3.500', '14.140'],
        ['6.500', '26.260'],
      ]);
    }
  });

  it('D-574: lo registrado más el borrador no pasa los metros del pedido, y nombra la fila', () => {
    const result = checkDraftRows(state({ reportedMeters: new Decimal('4') }), [
      { coilId: 'c1', pieces: [], meters: '5.000' },
      { coilId: 'c2', pieces: [], meters: '1.001' },
    ]);
    expect(result).toEqual({
      ok: false,
      rowNumber: 2,
      message: 'Excede el plan en 0.001 m · ajusta el plan',
    });
  });

  it('justo los metros del pedido entran', () => {
    const result = checkDraftRows(state({ reportedMeters: new Decimal('4') }), [
      { coilId: 'c1', pieces: [], meters: '6.000' },
    ]);
    expect(result.ok).toBe(true);
  });

  it('sin pedido (a stock) no hay tope de metros, como su parte', () => {
    const result = checkDraftRows(state({ accessory: { orderedMeters: null } }), [
      { coilId: 'c1', pieces: [], meters: '50.000' },
    ]);
    expect(result.ok).toBe(true);
  });

  it('una fila con largos en un accesorio, o sin metros, se rechaza con el texto del parte', () => {
    for (const row of [
      { coilId: 'c1', pieces: [{ lengthMm: '1000.00', qty: 1 }] },
      { coilId: 'c1', pieces: [{ lengthMm: '1000.00', qty: 1 }], meters: '1.000' },
    ]) {
      const result = checkDraftRows(state(), [row]);
      expect(result).toMatchObject({
        ok: false,
        rowNumber: 1,
        message:
          'ACC-050-GRIS es un accesorio: reporta los metros lineales de bobina que usó, no largos',
      });
    }
  });

  it('una fila con metros en una cobertura se rechaza', () => {
    const result = checkDraftRows(state({ accessory: null, planPieces: [] }), [
      { coilId: 'c1', pieces: [], meters: '1.000' },
    ]);
    expect(result).toMatchObject({
      ok: false,
      message: 'ACC-050-GRIS no es un accesorio: detalla los largos que salieron',
    });
  });

  it('los kilos de una bobina se acumulan entre filas también por metros (D-388: la fila 2 sale marcada)', () => {
    const result = checkDraftRows(
      state({
        accessory: { orderedMeters: null },
        coils: [{ coilId: 'c1', coilCode: 'B-1', remainingKg: new Decimal('50'), geometry }],
      }),
      [
        { coilId: 'c1', pieces: [], meters: '10.000' }, // 40.4 kg
        { coilId: 'c1', pieces: [], meters: '10.000' }, // quedan 9.6 kg: fuera de tolerancia
      ],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows[0]?.outOfTolerance).toBeNull();
      expect(result.rows[1]?.outOfTolerance).not.toBeNull();
      expect(result.rows[1]?.outKg.toFixed(3)).toBe('9.600');
    }
  });

  it('mathPieces: los metros son un solo largo de esa longitud; sin metros, los largos', () => {
    expect(mathPieces({ pieces: [], meters: '3.250' })).toEqual([{ lengthMm: '3250.00', qty: 1 }]);
    const pieces = [{ lengthMm: '4000.00', qty: 2 }];
    expect(mathPieces({ pieces, meters: null })).toEqual(pieces);
  });
});

describe('roofingReportDraftInputSchema (cc41)', () => {
  it('acepta largos o metros, no los dos ni ninguno; las piezas solo con metros', () => {
    expect(
      roofingReportDraftInputSchema.safeParse({ meters: '2.000', piecesCount: 3 }).success,
    ).toBe(true);
    expect(
      roofingReportDraftInputSchema.safeParse({ pieces: [{ lengthMm: '1000.00', qty: 1 }] })
        .success,
    ).toBe(true);
    expect(roofingReportDraftInputSchema.safeParse({}).success).toBe(false);
    expect(
      roofingReportDraftInputSchema.safeParse({
        meters: '2.000',
        pieces: [{ lengthMm: '1000.00', qty: 1 }],
      }).success,
    ).toBe(false);
    expect(
      roofingReportDraftInputSchema.safeParse({
        pieces: [{ lengthMm: '1000.00', qty: 1 }],
        piecesCount: 2,
      }).success,
    ).toBe(false);
  });
});

// --------------------------------------------------------------------------
// El servicio con un accesorio (mocks; la transacción de verdad está en el db-spec)
// --------------------------------------------------------------------------

const PD = (v: string) => new Prisma.Decimal(v);
const COIL = {
  code: 'B-ACC-1',
  widthMm: PD('1000.00'),
  thicknessMm: PD('0.50'),
  finish: { densityFactor: PD('8.0000') },
};

function accessoryDraft(id: string, meters: string, piecesCount: number | null = null): DraftRow {
  return {
    id,
    seq: 1,
    productionOrderId: 'op-9',
    coilId: 'c-1',
    consumedKg: null,
    meters: PD(meters),
    piecesCount,
    notes: null,
    createdById: 'u-1',
    createdAt: new Date('2026-10-10T00:00:00Z'),
    pieces: [],
    coil: COIL,
  } as unknown as DraftRow;
}

function accessoryService(drafts: DraftRow[], reportedMeters: string[] = []) {
  const reportInTx = jest.fn().mockResolvedValue([]);
  const order = {
    id: 'op-9',
    seq: 9,
    kind: 'ROOFING',
    status: 'IN_PROGRESS',
    productId: 'acc-1',
    reservationId: null,
  };
  const create = jest.fn().mockResolvedValue({});
  const update = jest.fn().mockResolvedValue({});
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'op-9' }]),
    productionOrder: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(order),
      findUnique: jest.fn().mockResolvedValue(order),
    },
    product: {
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ sku: 'ACC050GRIS', lengthMm: null, roofingKind: 'ACCESORIO' }),
    },
    productionOrderItem: { findMany: jest.fn().mockResolvedValue([]) },
    productionReport: {
      findMany: jest
        .fn()
        .mockResolvedValue(reportedMeters.map((m) => ({ metersM: PD(m), piecesDetail: [] }))),
    },
    productionOrderConsumption: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { coilId: 'c-1', assignedKg: PD('500.000'), consumedKg: PD('0.000'), coil: COIL },
        ]),
    },
    reservation: {
      findUnique: jest.fn().mockResolvedValue({ salesOrderItem: { qty: PD('10.000') } }),
    },
    productionReportDraft: {
      findMany: jest.fn().mockResolvedValue(drafts),
      deleteMany: jest.fn().mockResolvedValue({ count: drafts.length }),
      create,
      update,
    },
    productionReportDraftPiece: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const prisma = { ...tx, $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  const svc = Object.create(RoofingDraftsService.prototype) as RoofingDraftsService;
  Object.assign(svc, {
    prisma,
    audit: { write: jest.fn().mockResolvedValue(undefined) },
    production: { findOne: jest.fn().mockResolvedValue({ id: 'op-9' }) },
    roofing: { reportInTx, closeInTx: jest.fn(), withWarnings: (dto: unknown) => dto },
    operationDate: { resolve: () => '2026-10-10' },
  });
  return { svc, reportInTx, create, update, tx, order };
}

const ACTOR = { id: 'u-1', role: 'ADMINISTRADOR' } as never;

describe('RoofingDraftsService con un accesorio (cc41)', () => {
  it('list devuelve los metros y las piezas de cada fila, sin largos', async () => {
    const { svc } = accessoryService([accessoryDraft('d-1', '3.500', 7)]);
    const [dto] = await svc.list('op-9');
    expect(dto).toMatchObject({
      meters: '3.500',
      piecesCount: 7,
      pieces: [],
      theoreticalKg: '14.140',
    });
  });

  it('add guarda metros y piezas, sin filas de largos', async () => {
    const { svc, create } = accessoryService([]);
    await svc.add(
      ACTOR,
      'op-9',
      roofingReportDraftInputSchema.parse({ meters: '2.5', piecesCount: 3, consumedKg: '10.2' }),
    );
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        coilId: 'c-1',
        meters: '2.500',
        piecesCount: 3,
        consumedKg: '10.200',
        pieces: { create: [] },
      }) as unknown,
    });
  });

  it('con pedido, add mide el exceso contra sus metros (registrado más borrador)', async () => {
    const { svc, tx, order } = accessoryService([accessoryDraft('d-1', '5.000')], ['4.000']);
    Object.assign(order, { reservationId: 'r-1' });
    tx.productionOrder.findUnique.mockResolvedValue({
      ...order,
      reservation: { salesOrderId: 'so-1' },
    });
    await expect(
      svc.add(ACTOR, 'op-9', roofingReportDraftInputSchema.parse({ meters: '1.5' })),
    ).rejects.toThrow('Excede el plan en 0.500 m · ajusta el plan');
  });

  it('update reescribe los metros de la fila', async () => {
    const { svc, update } = accessoryService([accessoryDraft('d-1', '3.000')]);
    await svc.update('op-9', 'd-1', roofingReportDraftInputSchema.parse({ meters: '4' }));
    expect(update).toHaveBeenCalledWith({
      where: { id: 'd-1' },
      data: expect.objectContaining({ meters: '4.000', piecesCount: null }) as unknown,
    });
  });

  it('commit manda cada fila como su parte por metros, con las piezas si las tiene', async () => {
    const { svc, reportInTx } = accessoryService([
      accessoryDraft('d-1', '3.500', 7),
      accessoryDraft('d-2', '2.000'),
    ]);
    await svc.commit(ACTOR, 'op-9', {});
    const inputs = (reportInTx.mock.calls as unknown[][]).map((c) => c[3]);
    expect(inputs[0]).toMatchObject({ coilId: 'c-1', meters: '3.500', piecesCount: 7 });
    expect(inputs[0]).not.toHaveProperty('pieces');
    expect(inputs[1]).toMatchObject({ meters: '2.000' });
    expect(inputs[1]).not.toHaveProperty('piecesCount');
  });
});
