import { BadRequestException, ConflictException } from '@nestjs/common';
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
  business_line_id: string;
}

/**
 * Transacción falsa que mantiene el saldo en memoria, para ejercitar el promedio
 * ponderado por el mismo camino de código que en producción (incluido el
 * `INSERT ... ON CONFLICT` y el `SELECT ... FOR UPDATE`), sin depender de Postgres.
 */
function createFakeTx(line: { id: string; inventoryStrategy: InventoryStrategy }) {
  const balances = new Map<
    string,
    { id: string; qty: string; avgCost: string; unit: string; businessLineId: string }
  >();
  const movements: FakeMovement[] = [];
  const executed: string[] = [];

  const tx = {
    businessLine: {
      findUnique: jest.fn().mockResolvedValue(line),
    },
    $executeRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      executed.push(strings.join('?'));
      const [, businessLineId, itemType, itemId, unit] = values as string[];
      const key = `${itemType}:${itemId}`;
      if (!balances.has(key)) {
        balances.set(key, {
          id: `bal-${balances.size + 1}`,
          qty: '0',
          avgCost: '0',
          unit: unit ?? 'KGM',
          businessLineId: businessLineId ?? line.id,
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
        business_line_id: found.businessLineId,
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
    // D-066: la invariante `disponible ≥ reservado` consulta el ledger en cada salida.
    // La transacción falsa lo devuelve vacío por defecto; los tests que necesiten una
    // reserva viva sobreescriben estos mocks.
    reservation: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { qty: null } }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    inventoryMovement: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        // Prisma devuelve `null` en las columnas opcionales que no se escribieron; sin
        // esto el `reversalOfId` llegaría como `undefined` y la guarda anti-doble-reversa
        // dispararía en el primer movimiento.
        const row = { id: BigInt(movements.length + 1), reversalOfId: null, ...data };
        movements.push(row);
        return Promise.resolve(row);
      }),
      findUnique: jest.fn(({ where }: { where: { id: bigint } }) =>
        Promise.resolve(movements.find((m) => m.id === where.id) ?? null),
      ),
      findFirst: jest.fn(({ where }: { where: { reversalOfId?: bigint } }) =>
        Promise.resolve(
          movements.find(
            (m) => where.reversalOfId !== undefined && m.reversalOfId === where.reversalOfId,
          ) ?? null,
        ),
      ),
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

/** Los movimientos falsos guardan strings; el servicio solo les pide `toString()`. */
type FakeMovement = Record<string, unknown> & { id: bigint };

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

  describe('reverse (Fase 2b) — anulación por movimiento inverso', () => {
    it('deja el saldo y el promedio exactamente como antes del movimiento anulado', async () => {
      const fake = createFakeTx(STOCK_LINE);
      await service.record(fake.tx, entry({ qty: '100.000', unitCost: '10.0000' }));
      await service.record(fake.tx, entry({ qty: '300.000', unitCost: '14.0000' }));
      const out = await service.record(
        fake.tx,
        entry({ type: 'OUT', qty: '200.000', unitCost: undefined, refType: 'SCRAP' }),
      );
      expect(fake.balanceOf('COIL', ITEM)).toMatchObject({ qty: '200.000', avgCost: '13.0000' });

      await service.reverse(fake.tx, out!.id, ACTOR, 'Merma mal registrada');

      // Vuelve al saldo previo a la salida: 400 kg al promedio de 13.00.
      expect(fake.balanceOf('COIL', ITEM)).toMatchObject({ qty: '400.000', avgCost: '13.0000' });
    });

    it('anular un ingreso saca su costo original, no el promedio vigente', async () => {
      const fake = createFakeTx(STOCK_LINE);
      const first = await service.record(fake.tx, entry({ qty: '100.000', unitCost: '10.0000' }));
      await service.record(fake.tx, entry({ qty: '100.000', unitCost: '20.0000' }));
      expect(fake.balanceOf('COIL', ITEM)).toMatchObject({ qty: '200.000', avgCost: '15.0000' });

      await service.reverse(fake.tx, first!.id, ACTOR, 'Ingreso duplicado');

      // Si la reversa hubiera salido al promedio (15), el saldo quedaría en 100 kg a
      // 20 × 100 = 2000 pero valorizado en 1500: el promedio arrastraría el error.
      expect(fake.balanceOf('COIL', ITEM)).toMatchObject({ qty: '100.000', avgCost: '20.0000' });
      const reversal = fake.movements[2];
      expect(reversal).toMatchObject({
        type: 'OUT',
        qty: '100.000',
        unitCost: '10.0000',
        totalCost: '1000.0000',
        reversalOfId: first!.id,
        notes: 'Ingreso duplicado',
      });
    });

    it('no anula dos veces el mismo movimiento', async () => {
      const fake = createFakeTx(STOCK_LINE);
      await service.record(fake.tx, entry({ qty: '500.000', unitCost: '10.0000' }));
      const out = await service.record(
        fake.tx,
        entry({ type: 'OUT', qty: '100.000', unitCost: undefined, refType: 'SCRAP' }),
      );

      await service.reverse(fake.tx, out!.id, ACTOR, 'Primera anulación');
      await expect(
        service.reverse(fake.tx, out!.id, ACTOR, 'Segunda anulación'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(fake.balanceOf('COIL', ITEM)).toMatchObject({ qty: '500.000' });
    });

    it('no anula un movimiento que ya es una anulación', async () => {
      const fake = createFakeTx(STOCK_LINE);
      await service.record(fake.tx, entry({ qty: '500.000', unitCost: '10.0000' }));
      const out = await service.record(
        fake.tx,
        entry({ type: 'OUT', qty: '100.000', unitCost: undefined, refType: 'SCRAP' }),
      );
      const reversal = await service.reverse(fake.tx, out!.id, ACTOR, 'Anulación');

      await expect(
        service.reverse(fake.tx, reversal.id, ACTOR, 'Anular la anulación'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza anular un ingreso cuyos kilos ya no están en el saldo', async () => {
      const fake = createFakeTx(STOCK_LINE);
      const first = await service.record(fake.tx, entry({ qty: '100.000', unitCost: '10.0000' }));
      await service.record(
        fake.tx,
        entry({ type: 'OUT', qty: '60.000', unitCost: undefined, refType: 'SALE' }),
      );

      await expect(service.reverse(fake.tx, first!.id, ACTOR, 'Tarde')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fake.balanceOf('COIL', ITEM)).toMatchObject({ qty: '40.000' });
    });

    it('secuencia IN-IN-OUT-reversa deja el promedio ponderado correcto', async () => {
      const fake = createFakeTx(STOCK_LINE);
      await service.record(fake.tx, entry({ qty: '200.000', unitCost: '5.0000' }));
      await service.record(fake.tx, entry({ qty: '200.000', unitCost: '9.0000' }));
      // Promedio: (1000 + 1800) / 400 = 7.00
      const out = await service.record(
        fake.tx,
        entry({ type: 'OUT', qty: '150.000', unitCost: undefined, refType: 'PRODUCTION' }),
      );
      expect(fake.balanceOf('COIL', ITEM)).toMatchObject({ qty: '250.000', avgCost: '7.0000' });

      await service.reverse(fake.tx, out!.id, ACTOR, 'Producción anulada');
      expect(fake.balanceOf('COIL', ITEM)).toMatchObject({ qty: '400.000', avgCost: '7.0000' });

      // Y una entrada posterior sigue promediando sobre la base correcta.
      await service.record(fake.tx, entry({ qty: '100.000', unitCost: '12.0000' }));
      // (400×7 + 100×12) / 500 = 4000 / 500 = 8.00
      expect(fake.balanceOf('COIL', ITEM)).toMatchObject({ qty: '500.000', avgCost: '8.0000' });
    });
  });

  describe('adjustCost (D-043) — costo sin cantidad', () => {
    it('sube el promedio sin tocar el saldo y guarda el delta por kilo', async () => {
      const fake = createFakeTx(STOCK_LINE);
      await service.record(fake.tx, entry({ qty: '1000.000', unitCost: '5.0000' }));

      const adjust = await service.adjustCost(fake.tx, {
        businessLineId: STOCK_LINE.id,
        itemType: 'COIL',
        itemId: ITEM,
        unit: 'KGM',
        amountPen: '500.0000',
        refType: 'PURCHASE',
        notes: 'Flete F001-1 (D-043)',
        actorId: ACTOR,
      });

      // 5000 + 500 = 5500 sobre 1000 kg → 5.50/kg, con la cantidad intacta.
      expect(fake.balanceOf('COIL', ITEM)).toMatchObject({ qty: '1000.000', avgCost: '5.5000' });
      expect(adjust).toMatchObject({
        type: 'ADJUST',
        qty: '1000.000',
        unitCost: '0.5000',
        totalCost: '500.0000',
      });
    });

    it('no hace nada si el ítem no tiene saldo', async () => {
      const fake = createFakeTx(STOCK_LINE);
      const adjust = await service.adjustCost(fake.tx, {
        businessLineId: STOCK_LINE.id,
        itemType: 'COIL',
        itemId: ITEM,
        unit: 'KGM',
        amountPen: '500.0000',
        refType: 'PURCHASE',
        actorId: ACTOR,
      });

      expect(adjust).toBeNull();
      expect(fake.movements).toHaveLength(0);
    });

    it('anular el ajuste devuelve el promedio a donde estaba', async () => {
      const fake = createFakeTx(STOCK_LINE);
      await service.record(fake.tx, entry({ qty: '1000.000', unitCost: '5.0000' }));
      const adjust = await service.adjustCost(fake.tx, {
        businessLineId: STOCK_LINE.id,
        itemType: 'COIL',
        itemId: ITEM,
        unit: 'KGM',
        amountPen: '500.0000',
        refType: 'PURCHASE',
        actorId: ACTOR,
      });
      expect(fake.balanceOf('COIL', ITEM)?.avgCost).toBe('5.5000');

      await service.reverse(fake.tx, adjust!.id, ACTOR, 'Flete anulado');
      expect(fake.balanceOf('COIL', ITEM)).toMatchObject({ qty: '1000.000', avgCost: '5.0000' });
    });
  });
  /**
   * D-066 — invariante `disponible ≥ reservado`. El ledger de reservas vive fuera del
   * kardex (D-054), así que el único punto donde una salida lo puede violar es este; los
   * tests le enchufan reservas vivas a la transacción falsa y comprueban los dos lados.
   */
  describe('invariante disponible ≥ reservado (D-066)', () => {
    function reserve(fake: ReturnType<typeof createFakeTx>, qty: string, orderSeq = 1): void {
      const tx = fake.tx as unknown as {
        reservation: { aggregate: jest.Mock; findMany: jest.Mock };
      };
      tx.reservation.aggregate.mockResolvedValue({ _sum: { qty: { toString: () => qty } } });
      tx.reservation.findMany.mockResolvedValue([
        {
          id: 'res-1',
          itemType: 'COIL',
          itemId: ITEM,
          qty: { toString: () => qty },
          unit: 'KGM',
          salesOrder: { id: 'ord-1', seq: orderSeq },
        },
      ]);
    }

    it('bloquea la salida que dejaría el saldo por debajo de lo reservado', async () => {
      const fake = createFakeTx(STOCK_LINE);
      await service.record(fake.tx, entry({ qty: '1000.000', unitCost: '5.0000' }));
      reserve(fake, '400.000');

      await expect(
        service.record(
          fake.tx,
          entry({ type: 'OUT', qty: '700.000', unitCost: undefined, refType: 'SCRAP' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Falla completa: el saldo queda intacto, sin movimiento a medias.
      expect(fake.balanceOf('COIL', ITEM)).toMatchObject({ qty: '1000.000' });
      expect(fake.movements).toHaveLength(1);
    });

    it('el mensaje nombra el pedido que tiene el material reservado', async () => {
      const fake = createFakeTx(STOCK_LINE);
      await service.record(fake.tx, entry({ qty: '1000.000', unitCost: '5.0000' }));
      reserve(fake, '400.000', 42);

      await expect(
        service.record(
          fake.tx,
          entry({ type: 'OUT', qty: '700.000', unitCost: undefined, refType: 'SCRAP' }),
        ),
      ).rejects.toThrow(/PED-000042/);
    });

    it('deja pasar la salida que respeta lo reservado, hasta el límite exacto', async () => {
      const fake = createFakeTx(STOCK_LINE);
      await service.record(fake.tx, entry({ qty: '1000.000', unitCost: '5.0000' }));
      reserve(fake, '400.000');

      await service.record(
        fake.tx,
        entry({ type: 'OUT', qty: '600.000', unitCost: undefined, refType: 'SCRAP' }),
      );
      expect(fake.balanceOf('COIL', ITEM)).toMatchObject({ qty: '400.000' });
    });

    it('una entrada nunca se bloquea, por reservado que esté el ítem', async () => {
      const fake = createFakeTx(STOCK_LINE);
      await service.record(fake.tx, entry({ qty: '100.000', unitCost: '5.0000' }));
      reserve(fake, '100.000');

      await service.record(fake.tx, entry({ qty: '50.000', unitCost: '6.0000' }));
      expect(fake.balanceOf('COIL', ITEM)).toMatchObject({ qty: '150.000' });
    });

    it('anular un ingreso también respeta la invariante (misma regla, otra puerta)', async () => {
      const fake = createFakeTx(STOCK_LINE);
      const first = await service.record(fake.tx, entry({ qty: '500.000', unitCost: '5.0000' }));
      await service.record(fake.tx, entry({ qty: '500.000', unitCost: '5.0000' }));
      reserve(fake, '600.000');

      await expect(
        service.reverse(fake.tx, first!.id, ACTOR, 'Compra anulada'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fake.balanceOf('COIL', ITEM)).toMatchObject({ qty: '1000.000' });
    });
  });
});
