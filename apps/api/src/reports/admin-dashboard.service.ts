import { Injectable } from '@nestjs/common';
import {
  businessToday,
  COIL_REPORT_LINES,
  dashboardMonthRanges,
  type AdminDashboardDto,
} from '@ayr/shared';
import { assembleAdminDashboard } from './admin-dashboard';
import { CoilWasteService } from './coil-waste.service';
import { InventoryValuationService } from './inventory-valuation.service';
import { ReceivablesAgingService } from './receivables-aging.service';
import { SalesMarginService } from './sales-margin.service';

/**
 * cc26 (D-440, M4). El Panel del administrador. Solo lee y no tiene consultas propias: llama
 * **una vez** a cada reporte con el rango que su enlace también lleva, y elige campos de sus DTO
 * (`assembleAdminDashboard`). Su presupuesto de consultas es la suma de los presupuestos de esos
 * reportes, que cada uno ya fija en su spec; el de aquí fija que ninguno se llama dos veces.
 *
 * Ventas y margen va dos veces porque son dos rangos (el mes en curso y el mismo tramo del mes
 * anterior, D-443), y merma una vez por pestaña (Coberturas Aluzinc y Drywall), porque el reporte
 * es por línea.
 */
@Injectable()
export class AdminDashboardService {
  constructor(
    private readonly salesMargin: SalesMarginService,
    private readonly receivablesAging: ReceivablesAgingService,
    private readonly inventoryValuation: InventoryValuationService,
    private readonly coilWaste: CoilWasteService,
  ) {}

  async dashboard(today: string = businessToday()): Promise<AdminDashboardDto> {
    const { current, previous } = dashboardMonthRanges(today);
    const [salesCurrent, salesPrevious, receivables, inventory, ...waste] = await Promise.all([
      this.salesMargin.salesMargin(current),
      this.salesMargin.salesMargin(previous),
      this.receivablesAging.report({}),
      this.inventoryValuation.valuation({}),
      ...COIL_REPORT_LINES.map((businessLine) =>
        this.coilWaste.report({ ...current, businessLine }),
      ),
    ]);
    return assembleAdminDashboard({
      asOf: today,
      current,
      previous,
      salesCurrent,
      salesPrevious,
      receivables,
      inventory,
      waste,
    });
  }
}
