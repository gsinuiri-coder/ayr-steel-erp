import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InventoryStrategy, Prisma } from '@prisma/client';
import { cents, Decimal } from '@ayr/shared';
import { ENV } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { receptionCost } from '../purchases/purchase-math';
import { InventoryService, type RecordMovementInput } from './inventory.service';

/**
 * D-359 — la entrada por compra entra al kardex por el **subtotal sin IGV × TC** al céntimo, no por
 * `qty × unitario de cuatro decimales`. `record` acepta `totalCost` y deriva/controla el unitario.
 */

const LINE = { id: 'line-roofing', inventoryStrategy: InventoryStrategy.STOCK };
const ITEM = '22222222-2222-4222-8222-222222222222';

function fakeTx() {
  const balance = { id: 'bal-1', qty: '0', avgCost: '0', unit: 'KGM', businessLineId: LINE.id };
  let created = false;
  const movements: Record<string, unknown>[] = [];
  const tx = {
    businessLine: { findUnique: jest.fn().mockResolvedValue(LINE) },
    $executeRaw: jest.fn(() => {
      created = true;
      return Promise.resolve(1);
    }),
    $queryRaw: jest.fn(() =>
      Promise.resolve(
        created
          ? [
              {
                id: balance.id,
                qty: { toString: () => balance.qty },
                avg_cost: { toString: () => balance.avgCost },
                unit: balance.unit,
                business_line_id: balance.businessLineId,
              },
            ]
          : [],
      ),
    ),
    inventoryBalance: {
      update: jest.fn(({ data }: { data: Record<string, string> }) => {
        balance.qty = data.qty ?? balance.qty;
        balance.avgCost = data.avgCost ?? balance.avgCost;
        return Promise.resolve({});
      }),
    },
    inventoryMovement: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        movements.push(data);
        return Promise.resolve({ id: BigInt(movements.length), ...data });
      }),
    },
    reservation: { aggregate: jest.fn().mockResolvedValue({ _sum: { qty: null } }) },
    quotationReservation: { aggregate: jest.fn().mockResolvedValue({ _sum: { qty: null } }) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, balance, movements };
}

function entry(over: Partial<RecordMovementInput>): RecordMovementInput {
  return {
    businessLineId: LINE.id,
    itemType: 'COIL',
    itemId: ITEM,
    type: 'IN',
    qty: '4520.000',
    unit: 'KGM',
    refType: 'PURCHASE',
    refId: 'p-1',
    actorId: '11111111-1111-4111-8111-111111111111',
    operationDate: '2026-09-20',
    ...over,
  };
}

describe('InventoryService.record — totalCost de una entrada (D-359)', () => {
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
    // La cronología y las invariantes de reserva no son lo que se prueba acá.
    jest
      .spyOn(service as never, 'assertChronological' as never)
      .mockResolvedValue(undefined as never);
  });

  // Bobina de 4 520 kg a 0.980123 USD/kg (seis decimales) con TC 3.745: subtotal 4 430.16 (céntimos).
  const subtotalUsd = cents(new Decimal('4520').times('0.980123'));
  const tc = new Prisma.Decimal('3.745');

  it('el kardex queda en subtotal × TC al céntimo, con el unitario derivado', async () => {
    const f = fakeTx();
    const cost = receptionCost(subtotalUsd, new Prisma.Decimal('4520'), tc);
    // 4430.16 × 3.745 = 16590.9492 → 16590.95.
    expect(cost).toEqual({ totalCost: '16590.9500', unitCost: '3.6706' });
    await service.record(f.tx, entry(cost));
    expect(f.movements[0]).toMatchObject({ unitCost: '3.6706', totalCost: '16590.9500' });
    // Con el unitario de cuatro decimales (0.9801 → 3.6705 en soles) habría entrado 16590.66.
    expect(f.balance.avgCost).toBe('3.6706');
  });

  it('el promedio pondera con el total del papel, no con qty × unitario', async () => {
    const f = fakeTx();
    await service.record(f.tx, entry({ qty: '2.000', unitCost: '0.0000' }));
    await service.record(f.tx, entry({ qty: '2.000', unitCost: '0.0001', totalCost: '0.0001' }));
    // Con el total: 0.0001 / 4 = 0.000025 → 0.0000. Con qty × unitario: 0.0002 / 4 → 0.0001.
    expect(f.balance.avgCost).toBe('0.0000');
    expect(f.movements[1]).toMatchObject({ totalCost: '0.0001', unitCost: '0.0001' });
  });

  it('un producto terminado en soles entra por su subtotal', async () => {
    const f = fakeTx();
    const cost = receptionCost(
      new Decimal('72.03'),
      new Prisma.Decimal('500'),
      new Prisma.Decimal(1),
    );
    expect(cost).toEqual({ totalCost: '72.0300', unitCost: '0.1441' });
    await service.record(
      f.tx,
      entry({ itemType: 'PRODUCT', qty: '500.000', unit: 'NIU', ...cost }),
    );
    expect(f.movements[0]).toMatchObject({ totalCost: '72.0300', unitCost: '0.1441' });
  });

  it('rechaza un unitario que no es el del total', async () => {
    const f = fakeTx();
    await expect(
      service.record(f.tx, entry({ unitCost: '3.6710', totalCost: '16590.9342' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.movements).toHaveLength(0);
  });

  it('una salida no acepta total propio: sale al promedio', async () => {
    const f = fakeTx();
    await service.record(f.tx, entry({ qty: '10.000', unitCost: '2.0000' }));
    await expect(
      service.record(
        f.tx,
        entry({ type: 'OUT', qty: '1.000', unitCost: undefined, totalCost: '5', refType: 'SCRAP' }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
