import { Module } from '@nestjs/common';
import { CoilsModule } from '../coils/coils.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ProductionModule } from '../production/production.module';
import { AdminDashboardService } from './admin-dashboard.service';
import { CoilWasteService } from './coil-waste.service';
import { DocumentProfitabilityService } from './document-profitability.service';
import { InventoryValuationService } from './inventory-valuation.service';
import { KardexPepsService } from './kardex-peps.service';
import { KardexSheetService } from './kardex-sheet.service';
import { ReceivablesAgingService } from './receivables-aging.service';
import { PlantDashboardService } from './plant-dashboard.service';
import { ProductionSummaryService } from './production-summary.service';
import { SellerDashboardService } from './seller-dashboard.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { SalesByMaterialService } from './sales-by-material.service';
import { SalesMarginService } from './sales-margin.service';

@Module({
  imports: [InventoryModule, CoilsModule, ProductionModule],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    InventoryValuationService,
    SalesMarginService,
    SalesByMaterialService,
    KardexPepsService,
    KardexSheetService,
    DocumentProfitabilityService,
    ReceivablesAgingService,
    CoilWasteService,
    ProductionSummaryService,
    AdminDashboardService,
    PlantDashboardService,
    SellerDashboardService,
  ],
})
export class ReportsModule {}
