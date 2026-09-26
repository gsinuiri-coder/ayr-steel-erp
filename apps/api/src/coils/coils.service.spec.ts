import { Test } from '@nestjs/testing';
import { Currency, Prisma } from '@prisma/client';
import { coilCode, coilSku, coilSkuFromTypeKey, coilTypeKey } from '@ayr/shared';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { CoilsService, type CreateCoilInput } from './coils.service';

const SUPPLIER = { id: 'sup-1', code: 'ACERO', name: 'Aceros del Norte' };
const FINISH = {
  id: 'fin-1',
  code: 'GALV',
  name: 'Galvanizado',
  kind: 'GALVANIZADO',
  densityFactor: new Prisma.Decimal('7.8500'),
  businessLineId: 'line-drywall',
  color: null,
};
const ACTOR = '11111111-1111-4111-8111-111111111111';

function input(overrides: Partial<CreateCoilInput> = {}): CreateCoilInput {
  return {
    businessLineId: 'line-drywall',
    supplierId: SUPPLIER.id,
    finishId: FINISH.id,
    weightKg: '4500.000',
    widthMm: '1220.00',
    thicknessMm: '0.50',
    currency: Currency.PEN,
    exchangeRate: '1.0000',
    unitCostPerKg: '4.2400',
    refType: 'PURCHASE',
    actorId: ACTOR,
    ...overrides,
  };
}

/** Transacción falsa: cuenta los correlativos como lo haría el UPDATE ... RETURNING real. */
function createFakeTx() {
  const state = { coilSeq: 0 };
  const created: Record<string, unknown>[] = [];
  const filmEvents: Record<string, unknown>[] = [];
  const queries: string[] = [];
  const upserts: { where: unknown; create: Record<string, unknown> }[] = [];

  const tx = {
    supplier: { findUnique: jest.fn().mockResolvedValue(SUPPLIER) },
    finish: {
      findUnique: jest.fn().mockResolvedValue(FINISH),
      // D-252: el chequeo de choque de base busca acabados hermanos. Sin hermanos, no hay choque.
      findMany: jest.fn().mockResolvedValue([]),
    },
    businessLine: { findUnique: jest.fn().mockResolvedValue({ id: 'line-trading' }) },
    product: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn((args: { where: unknown; create: Record<string, unknown> }) => {
        upserts.push(args);
        return Promise.resolve({ id: 'prod-1' });
      }),
    },
    coil: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({ id: `coil-${created.length}`, ...data });
      }),
    },
    coilFilmEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        filmEvents.push(data);
        return Promise.resolve({});
      }),
    },
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      queries.push(strings.join('?'));
      state.coilSeq += 1;
      return Promise.resolve([{ coil_seq: state.coilSeq }]);
    }),
  };

  return { tx: tx as unknown as Prisma.TransactionClient, created, filmEvents, queries, upserts };
}

describe('códigos de bobina (RF-13, RF-14, D-037)', () => {
  it('RF-14: el typeKey agrupa por acabado y espesor, ignorando el ancho', () => {
    expect(coilTypeKey('GALV', '0.5')).toBe('GALV-0.50');
    expect(coilTypeKey('galv', '0.50')).toBe('GALV-0.50');
    // Dos bobinas del mismo acabado y espesor con anchos distintos comparten typeKey.
    expect(coilTypeKey('GALV', '0.50')).toBe(coilTypeKey('GALV', '0.5000'));
  });

  it('D-037: el SKU es BOB{finishCode}{thicknessMm}, sin el ancho', () => {
    expect(coilSku('GALV', '0.50')).toBe('BOBGALV0.50');
    expect(coilSkuFromTypeKey(coilTypeKey('GALV', '0.50'))).toBe('BOBGALV0.50');
  });

  // D-168: el defecto real. Con un acabado con guiones adentro —los del cliente los tienen,
  // `ALZ-ROJO-3002`— el catálogo daba de alta `BOBALZ-ROJO-30020.45` y la venta directa
  // buscaba `BOBALZROJO30020.45`: «no existe el producto de venta directa» sobre una bobina
  // que sí tenía el suyo. Las dos cuentas tienen que ser **la misma**, con guiones o sin.
  it('D-168: un acabado con guiones da el mismo SKU por las dos vías', () => {
    expect(coilSku('ALZ-ROJO-3002', '0.45')).toBe('BOBALZ-ROJO-30020.45');
    expect(coilSkuFromTypeKey(coilTypeKey('ALZ-ROJO-3002', '0.45'))).toBe('BOBALZ-ROJO-30020.45');
    expect(coilSkuFromTypeKey('ALZ-ROJO-3002-0.45')).toBe(coilSku('ALZ-ROJO-3002', '0.45'));
  });

  it('D-168: el espesor se normaliza igual venga del typeKey o de los argumentos', () => {
    // El typeKey siempre trae la escala mm, pero el SKU no puede depender de eso.
    expect(coilSkuFromTypeKey('GALV-0.5')).toBe('BOBGALV0.50');
    expect(coilSkuFromTypeKey('alz-azul-0.38')).toBe('BOBALZ-AZUL0.38');
  });

  it('D-168: un typeKey que no se puede partir no inventa un espesor', () => {
    expect(coilSkuFromTypeKey('GALV')).toBe('BOBGALV');
    expect(coilSkuFromTypeKey('-0.50')).toBe('BOB-0.50');
    expect(coilSkuFromTypeKey('GALV-ROJO')).toBe('BOBGALV-ROJO');
  });

  it('RF-13: el código compone proveedor, acabado, espesor, peso y correlativo', () => {
    expect(
      coilCode({
        supplierCode: 'ACERO',
        finishCode: 'GALV',
        thicknessMm: '0.5',
        weightKg: '4500.400',
        sequence: 7,
      }),
    ).toBe('ACERO-GALV-0.50-4500-7');
  });
});

describe('CoilsService — film de protección (D-328)', () => {
  function serviceWith(prisma: Record<string, unknown>): CoilsService {
    return new CoilsService(prisma as unknown as PrismaService, {} as unknown as InventoryService);
  }

  it('el historial va del más reciente al más antiguo, con el nombre de quien lo registró', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'e2',
        type: 'RESEALED',
        source: 'MANUAL',
        operationDate: new Date('2026-09-12T00:00:00Z'),
        reason: null,
        actorId: 'u1',
        at: new Date('2026-09-12T15:00:00Z'),
      },
      {
        id: 'e1',
        type: 'OPENED',
        source: 'BIRTH',
        operationDate: new Date('2026-09-10T00:00:00Z'),
        reason: 'nació abierta',
        actorId: null,
        at: new Date('2026-09-10T15:00:00Z'),
      },
    ]);
    const service = serviceWith({
      coilFilmEvent: { findMany },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'u1', name: 'Ana Planta' }]) },
    });
    const events = await service.findFilmEvents('coil-1');
    expect(findMany).toHaveBeenCalledWith({
      where: { coilId: 'coil-1' },
      orderBy: [{ operationDate: 'desc' }, { at: 'desc' }, { id: 'desc' }],
    });
    expect(events.map((e) => [e.type, e.source, e.operationDate, e.actorName])).toEqual([
      ['RESEALED', 'MANUAL', '2026-09-12', 'Ana Planta'],
      ['OPENED', 'BIRTH', '2026-09-10', null],
    ]);
    expect(events[1]?.reason).toBe('nació abierta');
  });

  it('sin eventos no consulta usuarios', async () => {
    const userFindMany = jest.fn();
    const service = serviceWith({
      coilFilmEvent: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: userFindMany },
    });
    await expect(service.findFilmEvents('coil-1')).resolves.toEqual([]);
    expect(userFindMany).not.toHaveBeenCalled();
  });

  it.each([
    ['SEALED', true],
    ['OPENED', false],
  ])('el filtro film=%s acota a las vigentes con filmSealed=%s', async (film, sealed) => {
    const count = jest.fn().mockResolvedValue(0);
    const findMany = jest.fn().mockResolvedValue([]);
    const service = serviceWith({ coil: { count, findMany } });
    await service.findAll({ film, page: 1, pageSize: 20 } as never);
    const where = (count.mock.calls as { where: Record<string, unknown> }[][])[0]![0]!.where;
    expect(where.AND).toEqual([{ status: 'OPEN' }, { filmSealed: sealed }]);
  });

  it('sin el filtro no agrega ninguna condición de film', async () => {
    const count = jest.fn().mockResolvedValue(0);
    const service = serviceWith({ coil: { count, findMany: jest.fn().mockResolvedValue([]) } });
    await service.findAll({ page: 1, pageSize: 20 });
    const where = (count.mock.calls as { where: Record<string, unknown> }[][])[0]![0]!.where;
    expect(where.AND).toBeUndefined();
  });
});

describe('CoilsService.create (RF-10..RF-14)', () => {
  let service: CoilsService;
  const inventory = { record: jest.fn().mockResolvedValue({ id: BigInt(1) }) };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CoilsService,
        { provide: PrismaService, useValue: {} },
        { provide: InventoryService, useValue: inventory },
      ],
    }).compile();
    service = moduleRef.get(CoilsService);
  });

  it('genera el código y el typeKey de la bobina y calcula sus costos', async () => {
    const fake = createFakeTx();
    await service.create(fake.tx, input());

    expect(fake.created[0]).toMatchObject({
      code: 'ACERO-GALV-0.50-4500-1',
      typeKey: 'GALV-0.50',
      weightKg: '4500.000',
      unitCostPerKg: '4.2400',
      // 4500 × 4.24 = 19 080
      totalCost: '19080.0000',
      totalCostPen: '19080.0000',
    });
  });

  it('convierte el costo total a soles con el tipo de cambio de la compra', async () => {
    const fake = createFakeTx();
    await service.create(
      fake.tx,
      input({ currency: Currency.USD, exchangeRate: '3.7500', unitCostPerKg: '1.2000' }),
    );

    // 4500 × 1.20 = 5400 USD → 5400 × 3.75 = 20 250 PEN
    expect(fake.created[0]).toMatchObject({ totalCost: '5400.0000', totalCostPen: '20250.0000' });
  });

  it('el correlativo por proveedor sale de un UPDATE ... RETURNING atómico', async () => {
    const fake = createFakeTx();
    await service.create(fake.tx, input());

    expect(fake.queries).toHaveLength(1);
    const sql = fake.queries[0] ?? '';
    expect(sql).toContain('UPDATE "suppliers"');
    // El incremento va parametrizado (el partido reserva N de una vez), por eso no se
    // busca el literal 1 sino la forma de la sentencia.
    expect(sql).toContain('"coil_seq" = "coil_seq" +');
    expect(sql).toContain('RETURNING');
    // El correlativo nunca se lee antes de escribirlo: una sola sentencia, sin SELECT previo.
    expect(sql).not.toContain('SELECT');
  });

  it('dos bobinas iguales del mismo proveedor no colisionan de código', async () => {
    const fake = createFakeTx();
    await service.create(fake.tx, input());
    await service.create(fake.tx, input());

    const codes = fake.created.map((c) => c.code);
    expect(codes).toEqual(['ACERO-GALV-0.50-4500-1', 'ACERO-GALV-0.50-4500-2']);
    expect(new Set(codes).size).toBe(2);
  });

  // D-328: compra y carga inicial nacen selladas (sin evento); la hija de un partido y el fleje
  // de un corte nacen abiertas, con un evento `BIRTH` del día de su alta.
  it('D-328: una bobina de compra nace sellada, sin evento de film', async () => {
    const fake = createFakeTx();
    await service.create(fake.tx, input());
    expect(fake.filmEvents).toHaveLength(0);
  });

  it('D-328: la hija de un partido nace abierta (evento BIRTH fechado en su alta)', async () => {
    const fake = createFakeTx();
    await service.create(
      fake.tx,
      input({
        parentCoilId: 'madre-1',
        splitId: 'split-1',
        refType: 'SPLIT',
        operationDate: '2026-09-10',
      }),
    );
    expect(fake.filmEvents).toHaveLength(1);
    expect(fake.filmEvents[0]).toMatchObject({
      coilId: 'coil-1',
      type: 'OPENED',
      source: 'BIRTH',
      actorId: ACTOR,
    });
    expect((fake.filmEvents[0]?.operationDate as Date).toISOString().slice(0, 10)).toBe(
      '2026-09-10',
    );
  });

  it('asegura el producto de trading con el SKU canónico de D-252 y emite la entrada de kardex', async () => {
    const fake = createFakeTx();
    await service.create(fake.tx, input());

    // D-252: espesor en centésimas con tres dígitos + tipo (sin color). Ya no `BOBGALV0.50`.
    expect(fake.upserts[0]?.create).toMatchObject({
      sku: 'BOB050GALVANIZADO',
      name: 'Bobina Galvanizado 0.50 mm',
      unit: 'KGM',
    });
    expect(inventory.record).toHaveBeenCalledWith(
      fake.tx,
      expect.objectContaining({
        itemType: 'COIL',
        type: 'IN',
        qty: '4500.000',
        unit: 'KGM',
        unitCost: '4.2400',
        refType: 'PURCHASE',
      }),
    );
  });
});
