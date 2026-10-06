import { Injectable } from '@nestjs/common';
import {
  businessToday,
  COIL_REPORT_LINES,
  CoilKind,
  CoilStatus,
  MAX_PAGE_SIZE,
  plantWeekRange,
  ProductionOrderStatus,
  type CoilDto,
  type PlantDashboardDto,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CoilsService } from '../coils/coils.service';
import { ProductionService } from '../production/production.service';
import { RoofingProductionService } from '../production/roofing-production.service';
import { CoilWasteService } from './coil-waste.service';
import { assemblePlantDashboard } from './plant-dashboard';

/** Tope de páginas de la lista de bobinas abiertas: 10 × 200, muy por encima del parque real. */
export const PLANT_COIL_PAGES_CAP = 10;

/**
 * cc26 (D-440, M5). El Panel del supervisor de planta. Solo lee, sin consultas propias: la cola
 * y las órdenes vivas con las mismas funciones que `/planta`, el consumo con el reporte de merma
 * (hoy y la semana, por pestaña) y las bobinas abiertas con la lista de `/bobinas`. Cada lectura
 * se hace una vez; la de bobinas se pagina por 200 hasta su total.
 */
@Injectable()
export class PlantDashboardService {
  constructor(
    private readonly roofing: RoofingProductionService,
    private readonly production: ProductionService,
    private readonly coils: CoilsService,
    private readonly coilWaste: CoilWasteService,
  ) {}

  async dashboard(actor: RequestUser, today: string = businessToday()): Promise<PlantDashboardDto> {
    const week = plantWeekRange(today);
    const day = { from: today, to: today };
    const [queue, liveOrders, openCoils, ...waste] = await Promise.all([
      this.roofing.queue(actor),
      this.production.findAll({
        status: [ProductionOrderStatus.DRAFT, ProductionOrderStatus.IN_PROGRESS],
      }),
      this.openCoils(),
      ...COIL_REPORT_LINES.map((businessLine) => this.coilWaste.report({ ...day, businessLine })),
      ...COIL_REPORT_LINES.map((businessLine) => this.coilWaste.report({ ...week, businessLine })),
    ]);
    return assemblePlantDashboard({
      asOf: today,
      week,
      queue,
      liveOrders,
      wasteToday: waste.slice(0, COIL_REPORT_LINES.length),
      wasteWeek: waste.slice(COIL_REPORT_LINES.length),
      openCoils,
    });
  }

  private async openCoils(): Promise<CoilDto[]> {
    const out: CoilDto[] = [];
    for (let page = 1; page <= PLANT_COIL_PAGES_CAP; page += 1) {
      const res = await this.coils.findAll({
        status: [CoilStatus.OPEN],
        kind: CoilKind.COIL,
        availability: 'available',
        page,
        pageSize: MAX_PAGE_SIZE,
      });
      out.push(...res.items);
      if (out.length >= res.total || res.items.length === 0) break;
    }
    return out;
  }
}
