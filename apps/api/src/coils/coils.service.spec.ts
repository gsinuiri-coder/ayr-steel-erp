import { Test } from '@nestjs/testing';
import { Currency, type Prisma } from '@prisma/client';
import { coilCode, coilSku, coilSkuFromTypeKey, coilTypeKey } from '@ayr/shared';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { CoilsService, type CreateCoilInput } from './coils.service';

const SUPPLIER = { id: 'sup-1', code: 'ACERO', name: 'Aceros del Norte' };
const FINISH = { id: 'fin-1', code: 'GALV', name: 'Galvanizado' };
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
  const queries: string[] = [];
  const upserts: { where: unknown; create: Record<string, unknown> }[] = [];

  const tx = {
    supplier: { findUnique: jest.fn().mockResolvedValue(SUPPLIER) },
    finish: { findUnique: jest.fn().mockResolvedValue(FINISH) },
    businessLine: { findUnique: jest.fn().mockResolvedValue({ id: 'line-trading' }) },
    product: {
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
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      queries.push(strings.join('?'));
      state.coilSeq += 1;
      return Promise.resolve([{ coil_seq: state.coilSeq }]);
    }),
  };

  return { tx: tx as unknown as Prisma.TransactionClient, created, queries, upserts };
}

describe('códigos de bobina (RF-13, RF-14, D-037)', () => {
  it('RF-14: el typeKey agrupa por acabado y espesor, ignorando el ancho', () => {
    expect(coilTypeKey('GALV', '0.5')).toBe('GALV-0.50');
    expect(coilTypeKey('galv', '0.50')).toBe('GALV-0.50');
    // Dos bobinas del mismo acabado y espesor con anchos distintos comparten typeKey.
    expect(coilTypeKey('GALV', '0.50')).toBe(coilTypeKey('GALV', '0.5000'));
  });

  it('D-037: el SKU es BOB{finishCode}{thicknessMm}, sin ancho ni guiones', () => {
    expect(coilSku('GALV', '0.50')).toBe('BOBGALV0.50');
    expect(coilSkuFromTypeKey(coilTypeKey('GALV', '0.50'))).toBe('BOBGALV0.50');
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
    expect(sql).toContain('"coil_seq" = "coil_seq" + 1');
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

  it('asegura el producto de trading con el SKU de D-037 y emite la entrada de kardex', async () => {
    const fake = createFakeTx();
    await service.create(fake.tx, input());

    expect(fake.upserts[0]?.create).toMatchObject({
      sku: 'BOBGALV0.50',
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
