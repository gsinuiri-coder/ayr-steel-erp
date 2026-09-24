import { Test } from '@nestjs/testing';
import { InventoryStrategy, Prisma, Role, RoofingProductKind } from '@prisma/client';
import { Unit } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import { ENV, type Env } from '../config/env';
import { InventoryService } from '../inventory/inventory.service';
import { RoofingProductionService } from '../production/roofing-production.service';
import { PrismaService } from '../prisma/prisma.service';
import { SalesOrdersService } from './sales-orders.service';

/**
 * Correcciones 02 / M4 (D-280): el disponible del modal «Elegir producto» se pide en **una**
 * llamada (`GET /sales/stock-panel?productIds=…`), pero el servidor lo resolvía fila por fila:
 * cada cobertura a medida o plancha contra pedido buscaba su agregado, sus bobinas, saldos,
 * reservas y montajes por su cuenta, y el piso de precio volvía a buscar las bobinas de cada
 * agregado. Con los 20 resultados de una búsqueda eran cientos de consultas, en serie.
 *
 * El presupuesto: el número de consultas no depende de cuántos productos se muestren.
 */

const ADMIN = {
  id: 'admin-1',
  email: 'admin@ayr.test',
  name: 'Administrador',
  role: Role.ADMINISTRADOR,
  mustChangePassword: false,
  sessionId: 'session-admin-1',
};

const dec = (v: string) => new Prisma.Decimal(v);

function madeToOrderProduct(i: number) {
  return {
    id: `p-${String(i)}`,
    sku: `TECHO-${String(i)}`,
    name: `Techo ${String(i)}`,
    // Un color distinto por producto: cada uno es un agregado distinto.
    colorId: `color-${String(i)}`,
    businessLineId: 'bl-roofing',
    thicknessMm: dec('0.40'),
    widthMm: dec('1000.00'),
    unit: Unit.MTR,
    lengthMm: null,
    roofingKind: RoofingProductKind.A_MEDIDA,
    color: { name: `Color ${String(i)}` },
    finish: { densityFactor: dec('7.8500') },
    businessLine: { inventoryStrategy: InventoryStrategy.STOCK },
  };
}

describe('SalesOrdersService.stockPanel — presupuesto de consultas (D-280)', () => {
  let service: SalesOrdersService;
  let calls: number;
  let products: ReturnType<typeof madeToOrderProduct>[];

  beforeEach(async () => {
    calls = 0;
    products = [];
    const counted =
      <T>(value: () => T) =>
      () => {
        calls += 1;
        return Promise.resolve(value());
      };
    const prisma = {
      product: { findMany: jest.fn(counted(() => products)) },
      rawMaterialSpec: {
        findFirst: jest.fn(counted(() => null)),
        findMany: jest.fn(counted(() => [])),
      },
      coil: {
        // Una bobina de 1000 kg por producto, de su mismo color. Una consulta de un solo
        // agregado filtra por su color; una por lote (`OR`) trae todas y el código reparte.
        findMany: jest.fn(({ where }: { where: { colorId?: string } }) => {
          calls += 1;
          return Promise.resolve(
            products
              .filter((p) => where.colorId === undefined || where.colorId === p.colorId)
              .map((p) => ({
                id: `coil-${p.id}`,
                businessLineId: p.businessLineId,
                colorId: p.colorId,
                thicknessMm: dec('0.40'),
              })),
          );
        }),
      },
      inventoryBalance: {
        findMany: jest.fn(
          counted(() =>
            products.map((p) => ({ itemId: `coil-${p.id}`, qty: dec('1000'), avgCost: dec('4') })),
          ),
        ),
      },
      reservation: { groupBy: jest.fn(counted(() => [])) },
      quotationReservation: { groupBy: jest.fn(counted(() => [])) },
      productionOrderConsumption: { findMany: jest.fn(counted(() => [])) },
      pricingSetting: {
        findMany: jest.fn(
          counted(() => [
            {
              businessLineId: 'bl-roofing',
              minMarginPct: dec('10'),
              businessLine: { code: 'ROOFING' },
            },
          ]),
        ),
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        SalesOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { write: jest.fn(), log: jest.fn() } },
        { provide: InventoryService, useValue: {} },
        { provide: RoofingProductionService, useValue: {} },
        { provide: ENV, useValue: {} as Env },
      ],
    }).compile();
    service = moduleRef.get(SalesOrdersService);
  });

  async function countFor(n: number) {
    products = Array.from({ length: n }, (_, i) => madeToOrderProduct(i + 1));
    calls = 0;
    const panel = await service.stockPanel(ADMIN, {
      productIds: products.map((p) => p.id),
    });
    return { calls, panel };
  }

  it('las consultas no crecen con la cantidad de productos visibles', async () => {
    const one = await countFor(1);
    const twenty = await countFor(20);
    expect(twenty.calls).toBe(one.calls);
    // Medido: 13 con 1 producto y con 20 (antes del lote: 13 y 165).
    expect(twenty.calls).toBeLessThanOrEqual(13);
  });

  it('cada producto sigue recibiendo su propio disponible y su piso', async () => {
    const { panel } = await countFor(3);
    expect(panel.products).toHaveLength(3);
    for (const row of panel.products) {
      // 1000 kg de su bobina, nada reservado.
      expect(row.rawMaterialAvailableKg).toBe('1000.000');
      expect(row.minValuePen).not.toBeNull();
    }
  });
});
