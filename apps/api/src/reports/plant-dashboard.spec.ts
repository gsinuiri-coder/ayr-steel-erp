import {
  BusinessLine,
  plantWeekRange,
  Role,
  type CoilDto,
  type CoilWasteDto,
  type ProductionOrderListItemDto,
  type ProductionQueueEntryDto,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import type { CoilsService } from '../coils/coils.service';
import type { ProductionService } from '../production/production.service';
import type { RoofingProductionService } from '../production/roofing-production.service';
import type { CoilWasteService } from './coil-waste.service';
import { assemblePlantDashboard, PLANT_QUEUE_PREVIEW } from './plant-dashboard';
import { PlantDashboardService } from './plant-dashboard.service';

/**
 * cc26 (D-440, M5). El Panel de planta no calcula: la cola es la de `/planta`, lo consumido es el
 * `totals.consumedKg` de merma para el mismo rango y las bobinas son las de `/bobinas`. Lo único
 * que decide es qué bobina está por terminarse (D-448).
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function queueEntry(n: number, over: Partial<ProductionQueueEntryDto> = {}) {
  return {
    orderId: uuid(n),
    code: `OP-${String(n).padStart(6, '0')}`,
    customerName: 'Cliente',
    productName: 'Plancha',
    planMeters: '10.00',
    promisedDeliveryDate: null,
    overdue: false,
    priority: false,
    ...over,
  } as ProductionQueueEntryDto;
}

function order(n: number, mountedCoilCodes: string[]) {
  return { id: uuid(100 + n), code: `OP-${n}`, mountedCoilCodes } as ProductionOrderListItemDto;
}

function coil(n: number, weightKg: string, availableKg: string, over: Partial<CoilDto> = {}) {
  return {
    id: uuid(200 + n),
    code: `B-${n}`,
    kind: 'COIL',
    status: 'OPEN',
    businessLine: BusinessLine.METALLIC_ROOFING,
    colorName: 'Rojo',
    weightKg,
    availableKg,
    ...over,
  } as CoilDto;
}

function waste(businessLine: CoilWasteDto['businessLine'], consumedKg: string, coilCount: number) {
  return { businessLine, totals: { consumedKg, coilCount } } as CoilWasteDto;
}

describe('plantWeekRange (D-447)', () => {
  it('va del lunes a hoy; el domingo cierra su semana', () => {
    expect(plantWeekRange('2026-10-06')).toEqual({ from: '2026-10-05', to: '2026-10-06' }); // martes
    expect(plantWeekRange('2026-10-05')).toEqual({ from: '2026-10-05', to: '2026-10-05' }); // lunes
    expect(plantWeekRange('2026-10-11')).toEqual({ from: '2026-10-05', to: '2026-10-11' }); // domingo
    expect(plantWeekRange('2026-11-01')).toEqual({ from: '2026-10-26', to: '2026-11-01' });
  });
});

describe('assemblePlantDashboard', () => {
  const build = () =>
    assemblePlantDashboard({
      asOf: '2026-10-06',
      week: { from: '2026-10-05', to: '2026-10-06' },
      queue: [
        queueEntry(1, { overdue: true }),
        queueEntry(2, { priority: true }),
        ...Array.from({ length: 8 }, (_, i) => queueEntry(10 + i)),
      ],
      liveOrders: [order(1, ['B-1', 'B-2']), order(2, ['B-1']), order(3, [])],
      wasteToday: [waste(BusinessLine.METALLIC_ROOFING, '120.500', 2)],
      wasteWeek: [
        waste(BusinessLine.METALLIC_ROOFING, '900.000', 5),
        waste(BusinessLine.DRYWALL, '40.000', 1),
      ],
      openCoils: [
        coil(1, '5000.000', '400.000'), // 8 %, montada
        coil(2, '5000.000', '2000.000'), // 40 %
        coil(3, '1000.000', '100.000'), // 10 %: el umbral entra
        coil(4, '1000.000', '0.000'), // sin saldo: no
        coil(5, '1000.000', '50.000', { kind: 'STRIP' }), // fleje: no
      ],
    });

  it('la cola: el conteo, los vencidos y prioritarios, y las primeras en su orden', () => {
    const d = build();
    expect(d.queue.count).toBe(10);
    expect(d.queue.overdueCount).toBe(1);
    expect(d.queue.priorityCount).toBe(1);
    expect(d.queue.next).toHaveLength(PLANT_QUEUE_PREVIEW);
    expect(d.queue.next.map((q) => q.code)[0]).toBe('OP-000001');
  });

  it('las bobinas montadas, con las órdenes que las tienen', () => {
    expect(build().mounted).toEqual([
      {
        coilCode: 'B-1',
        orders: [
          { orderId: uuid(101), code: 'OP-1' },
          { orderId: uuid(102), code: 'OP-2' },
        ],
      },
      { coilCode: 'B-2', orders: [{ orderId: uuid(101), code: 'OP-1' }] },
    ]);
  });

  it('lo consumido es el total del reporte de merma para cada rango; sin reporte del día, cero', () => {
    expect(build().production).toEqual([
      {
        businessLine: BusinessLine.METALLIC_ROOFING,
        todayKg: '120.500',
        todayCoilCount: 2,
        weekKg: '900.000',
        weekCoilCount: 5,
      },
      {
        businessLine: BusinessLine.DRYWALL,
        todayKg: '0.000',
        todayCoilCount: 0,
        weekKg: '40.000',
        weekCoilCount: 1,
      },
    ]);
  });

  it('por terminarse: bobinas abiertas con saldo hasta el 10 % de su peso, la más corta primero', () => {
    expect(build().lowCoils.map((c) => [c.code, c.remainingPct, c.mounted])).toEqual([
      ['B-1', '8.0', true],
      ['B-3', '10.0', false],
    ]);
  });
});

describe('PlantDashboardService (presupuesto de consultas)', () => {
  it('lee cada fuente una vez por rango y pagina las bobinas hasta su total', async () => {
    const roofing = { queue: jest.fn().mockResolvedValue([]) };
    const production = { findAll: jest.fn().mockResolvedValue([]) };
    const coils = {
      findAll: jest
        .fn()
        .mockResolvedValueOnce({
          items: Array.from({ length: 200 }, (_, i) => coil(i, '1', '1')),
          total: 250,
        })
        .mockResolvedValueOnce({
          items: Array.from({ length: 50 }, (_, i) => coil(i, '1', '1')),
          total: 250,
        }),
    };
    const coilWaste = {
      report: jest
        .fn()
        .mockImplementation((q: { businessLine: CoilWasteDto['businessLine'] }) =>
          Promise.resolve(waste(q.businessLine, '0.000', 0)),
        ),
    };
    const service = new PlantDashboardService(
      roofing as unknown as RoofingProductionService,
      production as unknown as ProductionService,
      coils as unknown as CoilsService,
      coilWaste as unknown as CoilWasteService,
    );
    const actor = { id: uuid(9), role: Role.SUPERVISOR_PLANTA } as RequestUser;
    await service.dashboard(actor, '2026-10-06');

    expect(roofing.queue).toHaveBeenCalledTimes(1);
    expect(roofing.queue).toHaveBeenCalledWith(actor);
    expect(production.findAll).toHaveBeenCalledTimes(1);
    expect(production.findAll).toHaveBeenCalledWith({ status: ['DRAFT', 'IN_PROGRESS'] });
    expect(coils.findAll).toHaveBeenCalledTimes(2);
    expect(coilWaste.report).toHaveBeenCalledTimes(4);
    for (const businessLine of [BusinessLine.METALLIC_ROOFING, BusinessLine.DRYWALL]) {
      expect(coilWaste.report).toHaveBeenCalledWith({
        from: '2026-10-06',
        to: '2026-10-06',
        businessLine,
      });
      expect(coilWaste.report).toHaveBeenCalledWith({
        from: '2026-10-05',
        to: '2026-10-06',
        businessLine,
      });
    }
  });
});
