import { Test } from '@nestjs/testing';
import { InventoryItemType, InventoryStrategy } from '@prisma/client';
import { Decimal } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import { ENV, type Env } from '../config/env';
import { InventoryService } from '../inventory/inventory.service';
import { RoofingProductionService } from '../production/roofing-production.service';
import { PrismaService } from '../prisma/prisma.service';
import { SalesOrdersService } from './sales-orders.service';

/**
 * RF-S3/M2 (D-228) — el card "Cotizaciones sin stock disponible" no puede volver a costar una
 * consulta por cotización ni por línea (D-224 en adelante ya lo dejó anotado como deuda).
 *
 * Todas las cotizaciones de esta suite son de stock simple (`PRODUCT`), a propósito: el
 * camino de materia prima (specs, bobinas, D-185/D-186) ya lo verifica de punta a punta
 * `e2e/tests/stock-shortage-f8s2b.spec.ts` contra una base real — acá lo que importa es
 * contar consultas, y el camino de stock alcanza para eso sin tener que fingir bobinas.
 */

const NOW = new Date('2026-09-17T12:00:00.000Z');

function quotationRow(overrides: {
  id: string;
  seq: number;
  customerName?: string;
  items: {
    lineNumber: number;
    productId: string;
    qty: string;
    reserveItemType: InventoryItemType;
    reserveItemId: string;
    reserveQty: string;
    reserveUnit: string;
    sku?: string;
    inventoryStrategy?: InventoryStrategy;
  }[];
}) {
  return {
    id: overrides.id,
    seq: overrides.seq,
    validUntil: null,
    customer: { name: overrides.customerName ?? 'ACME SAC' },
    items: overrides.items.map((i) => ({
      lineNumber: i.lineNumber,
      productId: i.productId,
      qty: new Decimal(i.qty),
      unit: 'NIU',
      description: 'Línea de prueba',
      reserveItemType: i.reserveItemType,
      reserveItemId: i.reserveItemId,
      reserveQty: new Decimal(i.reserveQty),
      reserveUnit: i.reserveUnit,
      product: {
        sku: i.sku ?? 'SKU-1',
        lengthMm: null,
        businessLine: { inventoryStrategy: i.inventoryStrategy ?? InventoryStrategy.STOCK },
      },
      pieces: [],
    })),
  };
}

describe('SalesOrdersService.findStockShortages (RF-S3/M2)', () => {
  let service: SalesOrdersService;
  let prisma: {
    quotation: { findMany: jest.Mock };
    product: { findMany: jest.Mock };
    rawMaterialSpec: { findMany: jest.Mock };
    inventoryBalance: { findMany: jest.Mock };
    reservation: { groupBy: jest.Mock };
    quotationReservation: { findMany: jest.Mock; groupBy: jest.Mock };
    coil: { findMany: jest.Mock };
  };
  let callCounts: Record<string, number>;

  /** Solo reinicia el contador — los mocks son los mismos objetos que ya tiene inyectados
   * `service`, así que recrearlos no serviría de nada (D-228: el punto es medir sobre la
   * misma instancia, no sobre una nueva). */
  function resetCounts(): void {
    callCounts = {};
  }

  function buildPrisma(): typeof prisma {
    const count = (name: string) => {
      callCounts[name] = (callCounts[name] ?? 0) + 1;
    };
    return {
      quotation: { findMany: jest.fn(() => (count('quotation.findMany'), Promise.resolve([]))) },
      product: { findMany: jest.fn(() => (count('product.findMany'), Promise.resolve([]))) },
      rawMaterialSpec: {
        findMany: jest.fn(() => (count('rawMaterialSpec.findMany'), Promise.resolve([]))),
      },
      inventoryBalance: {
        findMany: jest.fn(() => (count('inventoryBalance.findMany'), Promise.resolve([]))),
      },
      reservation: {
        groupBy: jest.fn(() => (count('reservation.groupBy'), Promise.resolve([]))),
      },
      quotationReservation: {
        findMany: jest.fn(() => (count('quotationReservation.findMany'), Promise.resolve([]))),
        groupBy: jest.fn(() => (count('quotationReservation.groupBy'), Promise.resolve([]))),
      },
      coil: { findMany: jest.fn(() => (count('coil.findMany'), Promise.resolve([]))) },
    };
  }

  beforeEach(async () => {
    callCounts = {};
    prisma = buildPrisma();
    const env = {} as Env;
    const moduleRef = await Test.createTestingModule({
      providers: [
        SalesOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { write: jest.fn(), log: jest.fn() } },
        { provide: InventoryService, useValue: {} },
        { provide: RoofingProductionService, useValue: {} },
        { provide: ENV, useValue: env },
      ],
    }).compile();
    service = moduleRef.get(SalesOrdersService);
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function setQuotations(rows: ReturnType<typeof quotationRow>[]): void {
    prisma.quotation.findMany.mockResolvedValue(rows);
  }

  it('el número de consultas es el mismo con 1 cotización que con 5 que comparten el mismo ítem', async () => {
    const oneQuotation = [
      quotationRow({
        id: 'q-1',
        seq: 1,
        items: [
          {
            lineNumber: 1,
            productId: 'p-1',
            qty: '10',
            reserveItemType: InventoryItemType.PRODUCT,
            reserveItemId: 'item-1',
            reserveQty: '10',
            reserveUnit: 'NIU',
          },
        ],
      }),
    ];
    setQuotations(oneQuotation);
    await service.findStockShortages();
    const withOne = { ...callCounts };

    resetCounts();
    const fiveQuotations = Array.from({ length: 5 }, (_, i) =>
      quotationRow({
        id: `q-${String(i)}`,
        seq: i + 1,
        items: [
          {
            lineNumber: 1,
            productId: 'p-1',
            qty: '10',
            reserveItemType: InventoryItemType.PRODUCT,
            reserveItemId: 'item-1',
            reserveQty: '10',
            reserveUnit: 'NIU',
          },
        ],
      }),
    );
    setQuotations(fiveQuotations);
    await service.findStockShortages();
    const withFive = { ...callCounts };

    // Una sola vez cada consulta, sin importar cuántas cotizaciones compartan el ítem: si
    // esto creciera con N, `withFive` tendría más llamadas que `withOne` en alguna clave.
    expect(withFive).toEqual(withOne);
    expect(Object.values(withFive).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10);
  });

  it('no crece con el número de líneas por cotización tampoco (2 cotizaciones × 3 líneas, 2 ítems distintos)', async () => {
    const rows = Array.from({ length: 2 }, (_, i) =>
      quotationRow({
        id: `q-${String(i)}`,
        seq: i + 1,
        items: [
          {
            lineNumber: 1,
            productId: 'p-1',
            qty: '5',
            reserveItemType: InventoryItemType.PRODUCT,
            reserveItemId: 'item-A',
            reserveQty: '5',
            reserveUnit: 'NIU',
          },
          {
            lineNumber: 2,
            productId: 'p-2',
            qty: '5',
            reserveItemType: InventoryItemType.PRODUCT,
            reserveItemId: 'item-B',
            reserveQty: '5',
            reserveUnit: 'NIU',
          },
          {
            lineNumber: 3,
            productId: 'p-1',
            qty: '5',
            reserveItemType: InventoryItemType.PRODUCT,
            reserveItemId: 'item-A',
            reserveQty: '5',
            reserveUnit: 'NIU',
          },
        ],
      }),
    );
    setQuotations(rows);
    await service.findStockShortages();

    // inventoryBalance/reservation/quotationReservation.groupBy: una vez por tipo de ítem
    // presente (acá solo PRODUCT), nunca una vez por línea ni por cotización.
    expect(callCounts['inventoryBalance.findMany']).toBe(1);
    expect(callCounts['reservation.groupBy']).toBe(1);
    expect(callCounts['quotationReservation.groupBy']).toBe(1);
    expect(callCounts['quotationReservation.findMany']).toBe(1);
  });

  it('la reserva temporal propia no cuenta contra la cotización que la tiene, pero sí contra las demás', async () => {
    const rows = [
      quotationRow({
        id: 'q-holder',
        seq: 1,
        items: [
          {
            lineNumber: 1,
            productId: 'p-1',
            qty: '10',
            reserveItemType: InventoryItemType.PRODUCT,
            reserveItemId: 'item-1',
            reserveQty: '10',
            reserveUnit: 'NIU',
          },
        ],
      }),
      quotationRow({
        id: 'q-rival',
        seq: 2,
        items: [
          {
            lineNumber: 1,
            productId: 'p-1',
            qty: '3',
            reserveItemType: InventoryItemType.PRODUCT,
            reserveItemId: 'item-1',
            reserveQty: '3',
            reserveUnit: 'NIU',
          },
        ],
      }),
    ];
    setQuotations(rows);
    // 10 físicos, 10 reservados en total (todos de q-holder): sin el ajuste, las dos
    // cotizaciones verían 0 disponible y las dos aparecerían con faltante.
    prisma.inventoryBalance.findMany.mockResolvedValue([
      { itemId: 'item-1', qty: new Decimal('10') },
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);
    prisma.quotationReservation.groupBy.mockResolvedValue([
      { itemId: 'item-1', _sum: { qty: new Decimal('10') } },
    ]);
    prisma.quotationReservation.findMany.mockResolvedValue([
      {
        quotationId: 'q-holder',
        itemType: InventoryItemType.PRODUCT,
        itemId: 'item-1',
        qty: new Decimal('10'),
      },
    ]);

    const result = await service.findStockShortages();

    // q-holder: disponible = 10 - 10 (reservado por todos) + 10 (lo suyo, que no se resta a
    // sí misma) = 10 — le sobra para sus 10, sin faltante.
    expect(result.some((r) => r.quotationId === 'q-holder')).toBe(false);
    // q-rival: disponible = 10 - 10 + 0 (no tiene reserva propia) = 0 — le faltan sus 3.
    const rivalEntry = result.find((r) => r.quotationId === 'q-rival');
    expect(rivalEntry?.lines).toEqual([
      expect.objectContaining({ lineNumber: 1, missingQty: '3.000' }),
    ]);
  });

  it('una línea de servicio sin inventario (NOOP) nunca cuenta como faltante', async () => {
    const row = quotationRow({
      id: 'q-1',
      seq: 1,
      items: [
        {
          lineNumber: 1,
          productId: 'p-1',
          qty: '10',
          reserveItemType: InventoryItemType.PRODUCT,
          reserveItemId: 'item-1',
          reserveQty: '10',
          reserveUnit: 'NIU',
          inventoryStrategy: InventoryStrategy.NOOP,
        },
      ],
    });
    setQuotations([row]);
    prisma.inventoryBalance.findMany.mockResolvedValue([]);

    const result = await service.findStockShortages();
    expect(result).toEqual([]);
  });

  it('dos líneas de la MISMA cotización compiten por el mismo ítem: la primera se sirve, a la segunda le falta el resto (hallazgo de revisor)', async () => {
    const row = quotationRow({
      id: 'q-1',
      seq: 1,
      items: [
        {
          lineNumber: 1,
          productId: 'p-1',
          qty: '6',
          reserveItemType: InventoryItemType.PRODUCT,
          reserveItemId: 'item-1',
          reserveQty: '6',
          reserveUnit: 'NIU',
        },
        {
          lineNumber: 2,
          productId: 'p-1',
          qty: '6',
          reserveItemType: InventoryItemType.PRODUCT,
          reserveItemId: 'item-1',
          reserveQty: '6',
          reserveUnit: 'NIU',
        },
      ],
    });
    setQuotations([row]);
    // 10 físicos, nada reservado por nadie: entre las dos líneas piden 12, sobran 10.
    prisma.inventoryBalance.findMany.mockResolvedValue([
      { itemId: 'item-1', qty: new Decimal('10') },
    ]);

    const result = await service.findStockShortages();

    // La línea 1 toma 6 de los 10 (orden de la cotización, igual que `previewLinesOf`); a la
    // línea 2 le quedan 4 disponibles para pedir 6 — faltan 2, nunca 6 (eso sería contar el
    // ítem dos veces) ni 0 (eso sería no descontar lo que ya tomó la línea 1).
    const entry = result.find((r) => r.quotationId === 'q-1');
    expect(entry?.lines).toEqual([expect.objectContaining({ lineNumber: 2, missingQty: '2.000' })]);
  });
});
