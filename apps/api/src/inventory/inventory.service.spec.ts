import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InventoryStrategy, type Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService, type RecordMovementInput } from './inventory.service';

const STOCK_LINE = { id: 'line-drywall', inventoryStrategy: InventoryStrategy.STOCK };
const NOOP_LINE = { id: 'line-services', inventoryStrategy: InventoryStrategy.NOOP };

const ACTOR = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';

/** Fila de saldo tal como la devuelve el `$queryRaw ... FOR UPDATE` (columnas snake_case). */
interface RawBalance {
  id: string;
  qty: { toString: () => string };
  avg_cost: { toString: () => string };
  unit: string;
}

/**
 * Transacción falsa que mantiene el saldo en memoria, para ejercitar el promedio
 * ponderado por el mismo camino de código que en producción (incluido el
 * `INSERT ... ON CONFLICT` y el `SELECT ... FOR UPDATE`), sin depender de Postgres.
 */
function createFakeTx(line: { id: string; inventoryStrategy: InventoryStrategy }) {
  const balances = new Map<string, { id: string; qty: string; avgCost: string; unit: string }>();
  const movements: Record<string, unknown>[] = [];
  const executed: string[] = [];

  const tx = {
    businessLine: {
      findUnique: jest.fn().mockResolvedValue(line),
    },
    $executeRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      executed.push(strings.join('?'));
      const [, , itemType, itemId, unit] = values as string[];
      const key = `${itemType}:${itemId}`;
      if (!balances.has(key)) {
        balances.set(key, {
          id: `bal-${balances.size + 1}`,
          qty: '0',
          avgCost: '0',
          unit: unit ?? 'KGM',
        });
      }
      return Promise.resolve(1);
    }),
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      executed.push(strings.join('?'));
      const [itemType, itemId] = values as string[];
      const found = balances.get(`${itemType}:${itemId}`);
      if (!found) return Promise.resolve([]);
      const row: RawBalance = {
        id: found.id,
        qty: { toString: () => found.qty },
        avg_cost: { toString: () => found.avgCost },
        unit: found.unit,
      };
      return Promise.resolve([row]);
    }),
    inventoryBalance: {
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Record<string, string> }) => {
          for (const balance of balances.values()) {
            if (balance.id === where.id) {
              balance.qty = data.qty ?? balance.qty;
              balance.avgCost = data.avgCost ?? balance.avgCost;
              balance.unit = data.unit ?? balance.unit;
            }
          }
          return Promise.resolve({});
        },
      ),
    },
    inventoryMovement: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        movements.push(data);
        return Promise.resolve({ id: BigInt(movements.length), ...data });
      }),
    },
  };

  return {
    tx: tx as unknown as Prisma.TransactionClient,
    balances,
    movements,
    executed,
    balanceOf: (itemType: string, itemId: string) => balances.get(`${itemType}:${itemId}`),
  };
}

function entry(overrides: Partial<RecordMovementInput> = {}): RecordMovementInput {
  return {
    businessLineId: STOCK_LINE.id,
    itemType: 'COIL',
    itemId: ITEM,
    type: 'IN',
    qty: '100.000',
    unit: 'KGM',
    unitCost: '10.0000',
    refType: 'PURCHASE',
    actorId: ACTOR,
    ...overrides,
  };
}

describe('InventoryService (§3.2, D-028)', () => {
  let service: InventoryService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [InventoryService, { provide: PrismaService, useValue: {} }],
    }).compile();
    service = moduleRef.get(InventoryService);
  });

  describe('promedio ponderado', () => {
    it('promedia tres entradas de distinto costo ponderando por cantidad', async () => {
      const fake = createFakeTx(STOCK_LINE);

      await service.record(fake.tx, entry({ qty: '100.000', unitCost: '10.0000' }));
      await service.record(fake.tx, entry({ qty: '300.000', unitCost: '14.0000' }));
      await service.record(fake.tx, entry({ qty: '100.000', unitCost: '20.0000' }));

      // (100×10 + 300×14 + 100×20) / 500 = 7200 / 500 = 14.40
      const balance = fake.balanceOf('COIL', ITEM);
      expect(balance?.qty).toBe('500.000');
      expect(balance?.avgCost).toBe('14.4000');
    });

    it('la primera entrada fija el promedio en su propio costo', async () => {
      const fake = createFakeTx(STOCK_LINE);
      await service.record(fake.tx, entry({ qty: '250.500', unitCost: '3.3333' }));
      expect(fake.balanceOf('COIL', ITEM)).toMatchObject({
        qty: '250.500',
        avgCost: '3.3333',
      });
    });

    it('una salida no cambia el promedio y se valoriza al promedio vigente', async () => {
      const fake = createFakeTx(STOCK_LINE);
      await service.record(fake.tx, entry({ qty: '100.000', unitCost: '10.0000' }));
      await service.record(fake.tx, entry({ qty: '300.000', unitCost: '14.0000' }));
      await service.record(
        fake.tx,
        entry({ type: 'OUT', qty: '200.000', unitCost: undefined, refType: 'SCRAP' }),
      );

      // Promedio tras las dos entradas: (1000 + 4200) / 400 = 13.00
      expect(fake.balanceOf('COIL', ITEM)).toMatchObject({ qty: '200.000', avgCost: '13.0000' });
      const out = fake.movements[2];
      expect(out).toMatchObject({ type: 'OUT', unitCost: '13.0000', totalCost: '2600.0000' });
    });

    it('redondea el promedio a la escala de dinero (4 decimales, D-003)', async () => {
      const fake = createFakeTx(STOCK_LINE);
      await service.record(fake.tx, entry({ qty: '1.000', unitCost: '1.0000' }));
      await service.record(fake.tx, entry({ qty: '2.000', unitCost: '2.0000' }));
      // (1 + 4) / 3 = 1.6666...
      expect(fake.balanceOf('COIL', ITEM)?.avgCost).toBe('1.6667');
    });
  });

  describe('líneas sin inventario (NOOP)', () => {
    it('no crea movimiento ni saldo y devuelve null', async () => {
      const fake = createFakeTx(NOOP_LINE);
      const result = await service.record(
        fake.tx,
        entry({ businessLineId: NOOP_LINE.id, itemType: 'PRODUCT' }),
      );

      expect(result).toBeNull();
      expect(fake.movements).toHaveLength(0);
      expect(fake.balances.size).toBe(0);
    });
  });

  describe('validaciones', () => {
    it('rechaza una entrada sin costo unitario', async () => {
      const fake = createFakeTx(STOCK_LINE);
      await expect(service.record(fake.tx, entry({ unitCost: undefined }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rechaza cantidad cero o negativa', async () => {
      const fake = createFakeTx(STOCK_LINE);
      await expect(service.record(fake.tx, entry({ qty: '0' }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.record(fake.tx, entry({ qty: '-5.000' }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rechaza una salida mayor al saldo y deja el saldo intacto', async () => {
      const fake = createFakeTx(STOCK_LINE);
      await service.record(fake.tx, entry({ qty: '10.000', unitCost: '5.0000' }));

      await expect(
        service.record(fake.tx, entry({ type: 'OUT', qty: '10.001', unitCost: undefined })),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(fake.balanceOf('COIL', ITEM)).toMatchObject({ qty: '10.000' });
      expect(fake.movements).toHaveLength(1);
    });
  });

  describe('atomicidad', () => {
    it('escribe saldo y movimiento con el mismo tx que recibe, sin abrir uno propio', async () => {
      const prisma = { $transaction: jest.fn() };
      const moduleRef = await Test.createTestingModule({
        providers: [InventoryService, { provide: PrismaService, useValue: prisma }],
      }).compile();
      const scoped = moduleRef.get(InventoryService);

      const fake = createFakeTx(STOCK_LINE);
      await scoped.record(fake.tx, entry());

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(fake.movements).toHaveLength(1);
      expect(fake.balances.size).toBe(1);
    });

    it('bloquea el saldo con FOR UPDATE antes de calcular el promedio', async () => {
      const fake = createFakeTx(STOCK_LINE);
      await service.record(fake.tx, entry());

      const lockQuery = fake.executed.find((sql) => sql.includes('FOR UPDATE'));
      expect(lockQuery).toBeDefined();
      expect(fake.executed[0]).toContain('ON CONFLICT');
      expect(fake.executed[1]).toContain('FOR UPDATE');
    });
  });
});
