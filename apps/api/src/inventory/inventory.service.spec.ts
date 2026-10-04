import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InventoryStrategy, type Prisma } from '@prisma/client';
import { Decimal } from '@ayr/shared';
import { ENV } from '../config/env';
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
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    // D-185: el ledger de reservas temporales, vacío salvo que un test lo llene.
    quotationReservation: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    // D-134: la invariante del **agregado** de materia prima parte de las bobinas que la
    // salida toca para saber qué agregados pueden quedar cortos. Sin ningún agregado con
    // promesas vivas no hay nada que comprobar, que es el caso de estos tests.
    coil: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    rawMaterialSpec: {
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
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: {} },
        // D-134: el servicio lee la tolerancia de espesor para la invariante del agregado.
        // El doble solo necesita la clave que `roofingToleranceMm` mira.
        { provide: ENV, useValue: { ROOFING_THICKNESS_TOLERANCE_MM: '' } },
      ],
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
        providers: [
          InventoryService,
          { provide: PrismaService, useValue: prisma },
          { provide: ENV, useValue: { ROOFING_THICKNESS_TOLERANCE_MM: '' } },
        ],
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
        reservation: { groupBy: jest.Mock; findMany: jest.Mock };
      };
      tx.reservation.groupBy.mockResolvedValue([
        { itemId: ITEM, _sum: { qty: { toString: () => qty } } },
      ]);
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

  describe('consulta del kardex (D-237)', () => {
    it('Punto 8: ordena establemente y calcula saldo corrido de 5 movimientos en el mismo dia', async () => {
      const m1 = movement(10n, '2026-09-15');
      m1.qty = new Decimal('100.000');
      const m2 = movement(11n, '2026-09-15');
      m2.type = 'OUT';
      m2.qty = new Decimal('20.000');
      const m3 = movement(12n, '2026-09-15');
      m3.type = 'OUT';
      m3.qty = new Decimal('10.000');
      const m4 = movement(13n, '2026-09-15');
      m4.qty = new Decimal('50.000');
      const m5 = movement(14n, '2026-09-15');
      m5.type = 'OUT';
      m5.qty = new Decimal('30.000');
      const prisma = setReadPrisma([m1, m2, m3, m4, m5]);
      const result = await service.findMovements({ itemType: 'COIL', itemId: ITEM }, true);
      expect(prisma.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ operationDate: 'asc' }, { at: 'asc' }, { id: 'asc' }],
        }),
      );
      expect(result.items.map((r) => r.balanceQty)).toEqual([
        '100.000',
        '80.000',
        '70.000',
        '120.000',
        '90.000',
      ]);
    });

    function movement(id: bigint, operationDate: string) {
      return {
        id,
        businessLine: { code: 'drywall' },
        itemType: 'COIL',
        itemId: ITEM,
        type: 'IN',
        qty: new Decimal('10.000'),
        unit: 'KGM',
        unitCost: new Decimal('5.0000'),
        totalCost: new Decimal('50.0000'),
        refType: 'PURCHASE',
        refId: null,
        notes: null,
        reversalOfId: null,
        reversals: [],
        actorId: null,
        at: new Date(`${operationDate}T12:00:00.000Z`),
        operationDate: new Date(`${operationDate}T00:00:00.000Z`),
      };
    }

    function setReadPrisma(rows: ReturnType<typeof movement>[], total = rows.length) {
      const findMany = jest.fn().mockResolvedValue(rows);
      const count = jest.fn().mockResolvedValue(total);
      const prisma = {
        inventoryMovement: { findMany, count },
        product: { findMany: jest.fn().mockResolvedValue([]) },
        coil: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: ITEM, code: 'BOB-E2E', typeKey: 'GALV-0.50' }]),
        },
      };
      (service as unknown as { prisma: PrismaService }).prisma = prisma as unknown as PrismaService;
      return { findMany, count };
    }

    it('entrega el historial individual completo en orden ascendente y como una sola página', async () => {
      const oldMovement = movement(1n, '2026-09-01');
      const newMovement = movement(2n, '2026-09-02');
      const prisma = setReadPrisma([oldMovement, newMovement]);

      const result = await service.findMovements(
        { itemType: 'COIL', itemId: ITEM, page: 9, pageSize: 1 },
        true,
      );

      expect(result.items.map((row) => row.id)).toEqual(['1', '2']);
      expect(result.items.map((row) => row.balanceQty)).toEqual(['10.000', '20.000']);
      expect(result).toMatchObject({ total: 2, page: 1, pageSize: 2 });
      expect(prisma.count).not.toHaveBeenCalled();
      expect(prisma.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ operationDate: 'asc' }, { at: 'asc' }, { id: 'asc' }],
          skip: 0,
          take: 10_000,
        }),
      );
    });

    it('conserva reciente primero y la paginación en el listado mezclado', async () => {
      const newMovement = movement(2n, '2026-09-02');
      const oldMovement = movement(1n, '2026-09-01');
      const prisma = setReadPrisma([newMovement, oldMovement], 12);

      const result = await service.findMovements({ page: 2, pageSize: 2 }, false);

      expect(result.items.map((row) => row.id)).toEqual(['2', '1']);
      expect(result).toMatchObject({ total: 12, page: 2, pageSize: 2 });
      expect(prisma.count).toHaveBeenCalledTimes(1);
      expect(prisma.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ operationDate: 'desc' }, { at: 'desc' }, { id: 'desc' }],
          skip: 2,
          take: 2,
        }),
      );
    });
  });
});

/**
 * D-372 (cc15b, D-382) — `replaceEntry` sobre la transacción falsa: el mismo camino interno que
 * `record` y `reverse`, las invariantes sobre el estado final y la precondición. Lo que depende de
 * Postgres de verdad (locks, concurrencia, la consulta por fecha) vive en
 * `replace-entry.db-spec.ts`.
 */
describe('InventoryService.replaceEntry (D-382)', () => {
  let service: InventoryService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: {} },
        { provide: ENV, useValue: { ROOFING_THICKNESS_TOLERANCE_MM: '' } },
      ],
    }).compile();
    service = moduleRef.get(InventoryService);
  });

  interface FakeTx {
    inventoryMovement: { findFirst: jest.Mock; findMany?: jest.Mock };
    reservation: { groupBy: jest.Mock; findMany: jest.Mock };
  }

  async function received(fake: ReturnType<typeof createFakeTx>): Promise<bigint> {
    const movement = await service.record(
      fake.tx,
      entry({ itemType: 'PRODUCT', qty: '100.000', unit: 'NIU', unitCost: '10.0000' }),
    );
    if (!movement) throw new Error('sin movimiento');
    const tx = fake.tx as unknown as FakeTx;
    // El saldo corrido lee todo el kardex del ítem.
    tx.inventoryMovement.findMany = jest.fn(() => Promise.resolve(fake.movements));
    // La precondición (`findFirst` con `type`) no encuentra nada posterior; el resto del
    // `findFirst` falso (la búsqueda de una anulación existente) sigue igual.
    const original = tx.inventoryMovement.findFirst.getMockImplementation();
    tx.inventoryMovement.findFirst.mockImplementation((args: { where: { type?: unknown } }) =>
      args.where.type !== undefined
        ? Promise.resolve(null)
        : (original?.(args) as Promise<unknown>),
    );
    return movement.id;
  }

  const replace = (
    fake: ReturnType<typeof createFakeTx>,
    movementId: bigint,
    qty: string,
    unitCost: string,
  ) =>
    service.replaceEntry(fake.tx, {
      movementId,
      qty,
      unitCost,
      totalCost: new Decimal(qty).times(unitCost).toFixed(4),
      actorId: ACTOR,
      reason: 'corrección',
    });

  it('escribe la reversa y el ingreso nuevo en la fecha del original, y el saldo queda con el costo nuevo', async () => {
    const fake = createFakeTx(STOCK_LINE);
    const id = await received(fake);
    const { reversal, entry: next } = await replace(fake, id, '100.000', '12.0000');
    expect(reversal).toMatchObject({ type: 'OUT', reversalOfId: id, totalCost: '1000.0000' });
    expect(next).toMatchObject({ type: 'IN', qty: '100.000', totalCost: '1200.0000' });
    expect(reversal.operationDate).toEqual(fake.movements[0]?.operationDate);
    expect(fake.balanceOf('PRODUCT', ITEM)).toMatchObject({ qty: '100.000', avgCost: '12.0000' });
  });

  it('con otras existencias, el promedio pondera el costo nuevo con el resto', async () => {
    const fake = createFakeTx(STOCK_LINE);
    const id = await received(fake);
    await service.record(
      fake.tx,
      entry({ itemType: 'PRODUCT', qty: '100.000', unit: 'NIU', unitCost: '20.0000' }),
    );
    await replace(fake, id, '100.000', '12.0000');
    // (100 × 12 + 100 × 20) / 200 = 16.
    expect(fake.balanceOf('PRODUCT', ITEM)).toMatchObject({ qty: '200.000', avgCost: '16.0000' });
  });

  it('precondición: un movimiento posterior que sale o ajusta lo bloquea, sin escribir nada', async () => {
    const fake = createFakeTx(STOCK_LINE);
    const id = await received(fake);
    const tx = fake.tx as unknown as FakeTx;
    const original = tx.inventoryMovement.findFirst.getMockImplementation();
    tx.inventoryMovement.findFirst.mockImplementation((args: { where: { type?: unknown } }) =>
      args.where.type !== undefined
        ? Promise.resolve({ id: 9n, type: 'OUT', refType: 'SALE' })
        : (original?.(args) as Promise<unknown>),
    );
    await expect(replace(fake, id, '100.000', '12.0000')).rejects.toThrow(/movimiento posterior/);
    expect(fake.movements).toHaveLength(1);
    expect(fake.balanceOf('PRODUCT', ITEM)).toMatchObject({ qty: '100.000', avgCost: '10.0000' });
  });

  it('reservas sobre el estado final: el precio pasa aunque todo esté reservado; una cantidad que no cubre, no', async () => {
    const fake = createFakeTx(STOCK_LINE);
    const id = await received(fake);
    const tx = fake.tx as unknown as FakeTx;
    tx.reservation.groupBy.mockResolvedValue([
      { itemId: ITEM, _sum: { qty: { toString: () => '100.000' } } },
    ]);
    tx.reservation.findMany.mockResolvedValue([
      {
        id: 'res-1',
        itemType: 'PRODUCT',
        itemId: ITEM,
        qty: { toString: () => '100.000' },
        unit: 'NIU',
        salesOrder: { id: 'ord-1', seq: 7 },
      },
    ]);
    // Con `reverse` + `record`, el estado intermedio (saldo 0) violaba la reserva.
    const { entry: next } = await replace(fake, id, '100.000', '12.0000');
    await expect(replace(fake, next.id, '90.000', '12.0000')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fake.balanceOf('PRODUCT', ITEM)).toMatchObject({ qty: '100.000', avgCost: '12.0000' });
  });

  it('una baja que dejaría el saldo corrido negativo en alguna fecha se rechaza (revisión P1-1)', async () => {
    const fake = createFakeTx(STOCK_LINE);
    const id = await received(fake);
    // Una salida y su anulación posteriores, que la vista del kardex sigue mostrando en su fecha.
    const later = new Date('2099-01-01T00:00:00.000Z');
    fake.movements.push(
      { id: 50n, type: 'OUT', qty: '100.000', operationDate: later, reversalOfId: null },
      { id: 51n, type: 'IN', qty: '100.000', operationDate: later, reversalOfId: 50n },
    );
    await expect(replace(fake, id, '40.000', '10.0000')).rejects.toThrow(/quedaría en -60.000/);
  });

  it('solo se reemplaza un ingreso vivo: ni una anulación, ni un ingreso ya reemplazado, ni una salida', async () => {
    const fake = createFakeTx(STOCK_LINE);
    const id = await received(fake);
    const { reversal } = await replace(fake, id, '100.000', '12.0000');
    await expect(replace(fake, reversal.id, '100.000', '12.0000')).rejects.toThrow(/anulación/);
    await expect(replace(fake, id, '100.000', '12.0000')).rejects.toBeInstanceOf(ConflictException);
    const out = await service.record(
      fake.tx,
      entry({ itemType: 'PRODUCT', type: 'OUT', qty: '1.000', unit: 'NIU', unitCost: undefined }),
    );
    await expect(replace(fake, out?.id ?? 0n, '1.000', '1.0000')).rejects.toThrow(
      /Solo se reemplaza un ingreso/,
    );
    await expect(replace(fake, 999n, '1.000', '1.0000')).rejects.toThrow(/no encontrado/);
  });

  it('una cantidad no positiva o un costo negativo se rechazan', async () => {
    const fake = createFakeTx(STOCK_LINE);
    const id = await received(fake);
    await expect(replace(fake, id, '0', '10.0000')).rejects.toThrow(/mayor a cero/);
    await expect(
      service.replaceEntry(fake.tx, {
        movementId: id,
        qty: '100.000',
        unitCost: '-1.0000',
        actorId: ACTOR,
        reason: 'x',
      }),
    ).rejects.toThrow(/no puede ser negativo/);
  });

  it('bobina: toma las bobinas antes que el saldo y, si bajan los kilos, comprueba el agregado al final', async () => {
    const fake = createFakeTx(STOCK_LINE);
    const movement = await service.record(fake.tx, entry({ qty: '100.000', unitCost: '10.0000' }));
    const tx = fake.tx as unknown as FakeTx & { coil: { findMany: jest.Mock } };
    tx.inventoryMovement.findMany = jest.fn(() => Promise.resolve(fake.movements));
    const original = tx.inventoryMovement.findFirst.getMockImplementation();
    tx.inventoryMovement.findFirst.mockImplementation((args: { where: { type?: unknown } }) =>
      args.where.type !== undefined
        ? Promise.resolve(null)
        : (original?.(args) as Promise<unknown>),
    );
    await replace(fake, movement?.id ?? 0n, '90.000', '10.0000');
    // `lockRawMaterialCoils` y `assertRawMaterialInvariant` leen las bobinas del agregado.
    expect(tx.coil.findMany).toHaveBeenCalled();
    expect(fake.balanceOf('COIL', ITEM)).toMatchObject({ qty: '90.000', avgCost: '10.0000' });
  });
});

/** D-382 (P2-B): la anulación de una compra bloquea bobinas antes que saldos (D-134). */
describe('InventoryService.lockItemsForReversal', () => {
  let service: InventoryService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: {} },
        { provide: ENV, useValue: { ROOFING_THICKNESS_TOLERANCE_MM: '' } },
      ],
    }).compile();
    service = moduleRef.get(InventoryService);
  });

  const ref = (itemType: 'COIL' | 'PRODUCT', itemId: string) => ({
    businessLineId: STOCK_LINE.id,
    itemType,
    itemId,
    unit: itemType === 'COIL' ? 'KGM' : 'NIU',
  });
  const balanceLocks = (executed: string[]) =>
    executed.filter((sql) => sql.includes('FOR UPDATE') && sql.includes('inventory_balances'));

  it('primero las bobinas, después cada saldo una sola vez', async () => {
    const fake = createFakeTx(STOCK_LINE);
    const tx = fake.tx as unknown as { coil: { findMany: jest.Mock } };
    let locksWhenCoils = -1;
    tx.coil.findMany = jest.fn(() => {
      if (locksWhenCoils < 0) locksWhenCoils = balanceLocks(fake.executed).length;
      return Promise.resolve([]);
    });
    await service.lockItemsForReversal(fake.tx, [
      ref('PRODUCT', 'p-2'),
      ref('COIL', 'c-1'),
      ref('PRODUCT', 'p-2'),
      ref('PRODUCT', 'p-1'),
    ]);
    expect(locksWhenCoils).toBe(0);
    expect(balanceLocks(fake.executed)).toHaveLength(3);
  });

  it('sin bobinas no las lee', async () => {
    const fake = createFakeTx(STOCK_LINE);
    const tx = fake.tx as unknown as { coil: { findMany: jest.Mock } };
    tx.coil.findMany = jest.fn(() => Promise.resolve([]));
    await service.lockItemsForReversal(fake.tx, [ref('PRODUCT', 'p-1')]);
    expect(tx.coil.findMany).not.toHaveBeenCalled();
    expect(balanceLocks(fake.executed)).toHaveLength(1);
  });
});

/** Las dos ramas de valor negativo de la reversa de un ingreso (`stockAfterReverseIn`). */
describe('InventoryService.reverse — valor negativo (D-382, camino compartido)', () => {
  let service: InventoryService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: {} },
        { provide: ENV, useValue: { ROOFING_THICKNESS_TOLERANCE_MM: '' } },
      ],
    }).compile();
    service = moduleRef.get(InventoryService);
  });

  const product = (overrides: Partial<RecordMovementInput> = {}) =>
    entry({ itemType: 'PRODUCT', unit: 'NIU', ...overrides });

  it('sin kilos, el residuo negativo es redondeo y el saldo se cierra en cero', async () => {
    const fake = createFakeTx(STOCK_LINE);
    const a = await service.record(fake.tx, product({ qty: '100.000', unitCost: '10.0000' }));
    await service.adjustCost(fake.tx, {
      businessLineId: STOCK_LINE.id,
      itemType: 'PRODUCT',
      itemId: ITEM,
      unit: 'NIU',
      amountPen: '-900',
      refType: 'PURCHASE',
      actorId: ACTOR,
    });
    await service.reverse(fake.tx, a?.id ?? 0n, ACTOR, 'anulación');
    expect(fake.balanceOf('PRODUCT', ITEM)).toMatchObject({ qty: '0.000', avgCost: '0.0000' });
  });

  it('con kilos, sacar más valor del que hay se rechaza', async () => {
    const fake = createFakeTx(STOCK_LINE);
    const a = await service.record(fake.tx, product({ qty: '100.000', unitCost: '10.0000' }));
    await service.record(fake.tx, product({ qty: '100.000', unitCost: '10.0000' }));
    await service.adjustCost(fake.tx, {
      businessLineId: STOCK_LINE.id,
      itemType: 'PRODUCT',
      itemId: ITEM,
      unit: 'NIU',
      amountPen: '-1500',
      refType: 'PURCHASE',
      actorId: ACTOR,
    });
    await expect(service.reverse(fake.tx, a?.id ?? 0n, ACTOR, 'anulación')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
