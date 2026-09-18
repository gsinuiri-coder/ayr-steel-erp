import { Test } from '@nestjs/testing';
import { Decimal } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import { ColorsService } from '../colors/colors.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogService } from './catalog.service';

/**
 * RF-S3/M4 (sacrificable, D-224/D-228) — el card «SKUs con lista bajo piso» del Panel no
 * puede costar una consulta por SKU: `computePriceFloors` ya lo evita para una cotización
 * (D-150), y este método lo reusa para todo el catálogo activo con precio de lista.
 */

function productRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'p-1',
    sku: 'PLA-001',
    name: 'Plancha lisa',
    unit: 'UND',
    listPricePen: new Decimal('10.0000'),
    businessLineId: 'bl-1',
    ...overrides,
  };
}

describe('CatalogService.findPriceListFloorSummary (RF-S3/M4)', () => {
  let service: CatalogService;
  let prisma: {
    product: { findMany: jest.Mock };
    pricingSetting: { findMany: jest.Mock };
    inventoryBalance: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let callCounts: Record<string, number>;

  beforeEach(async () => {
    callCounts = {};
    const count = (name: string) => {
      callCounts[name] = (callCounts[name] ?? 0) + 1;
    };
    prisma = {
      product: { findMany: jest.fn(() => (count('product.findMany'), Promise.resolve([]))) },
      pricingSetting: {
        findMany: jest.fn(() => (count('pricingSetting.findMany'), Promise.resolve([]))),
      },
      inventoryBalance: {
        findMany: jest.fn(() => (count('inventoryBalance.findMany'), Promise.resolve([]))),
      },
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        CatalogService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { write: jest.fn() } },
        { provide: ColorsService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(CatalogService);
  });

  it('devuelve el resumen vacío sin consultar pisos cuando no hay precios de lista', async () => {
    prisma.product.findMany.mockResolvedValue([]);

    await expect(service.findPriceListFloorSummary()).resolves.toEqual({
      totalWithListPrice: 0,
      withoutFloor: 0,
      belowFloor: [],
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('el número de consultas es el mismo con 1 SKU que con 50 (nunca una por SKU)', async () => {
    prisma.product.findMany.mockResolvedValue([productRow()]);
    prisma.pricingSetting.findMany.mockResolvedValue([
      { businessLineId: 'bl-1', minMarginPct: new Decimal('10') },
    ]);
    prisma.inventoryBalance.findMany.mockResolvedValue([
      { itemId: 'p-1', avgCost: new Decimal('5.0000') },
    ]);
    await service.findPriceListFloorSummary();
    const withOne = { ...callCounts };

    callCounts = {};
    prisma.product.findMany.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => productRow({ id: `p-${String(i)}` })),
    );
    prisma.inventoryBalance.findMany.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => ({
        itemId: `p-${String(i)}`,
        avgCost: new Decimal('5.0000'),
      })),
    );
    await service.findPriceListFloorSummary();
    const withFifty = { ...callCounts };

    expect(withFifty).toEqual(withOne);
    expect(Object.values(withFifty).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(4);
  });

  it('un SKU con precio de lista bajo el piso aparece, y uno por encima no', async () => {
    prisma.product.findMany.mockResolvedValue([
      productRow({ id: 'p-bajo', sku: 'BAJO-1', listPricePen: new Decimal('5.0000') }),
      productRow({ id: 'p-alto', sku: 'ALTO-1', listPricePen: new Decimal('20.0000') }),
    ]);
    // Margen mínimo 10%: piso = 5 / (1 - 0.10) = 5.5556 de valor sin IGV.
    prisma.pricingSetting.findMany.mockResolvedValue([
      { businessLineId: 'bl-1', minMarginPct: new Decimal('10') },
    ]);
    prisma.inventoryBalance.findMany.mockResolvedValue([
      { itemId: 'p-bajo', avgCost: new Decimal('5.0000') },
      { itemId: 'p-alto', avgCost: new Decimal('5.0000') },
    ]);

    const result = await service.findPriceListFloorSummary();

    expect(result.totalWithListPrice).toBe(2);
    expect(result.withoutFloor).toBe(0);
    expect(result.belowFloor).toHaveLength(1);
    expect(result.belowFloor[0]).toEqual(expect.objectContaining({ sku: 'BAJO-1' }));
  });

  it('un SKU sin costo en el kardex se cuenta aparte, no como infractor', async () => {
    prisma.product.findMany.mockResolvedValue([productRow({ id: 'p-sin-costo' })]);
    prisma.pricingSetting.findMany.mockResolvedValue([
      { businessLineId: 'bl-1', minMarginPct: new Decimal('10') },
    ]);
    prisma.inventoryBalance.findMany.mockResolvedValue([]);

    const result = await service.findPriceListFloorSummary();

    expect(result.withoutFloor).toBe(1);
    expect(result.belowFloor).toHaveLength(0);
  });
});
