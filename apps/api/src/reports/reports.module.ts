import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { CoilWasteService } from './coil-waste.service';
import { DocumentProfitabilityService } from './document-profitability.service';
import { InventoryValuationService } from './inventory-valuation.service';
import { KardexPepsService } from './kardex-peps.service';
import { KardexSheetService } from './kardex-sheet.service';
import { ReceivablesAgingService } from './receivables-aging.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { SalesByMaterialService } from './sales-by-material.service';
import { SalesMarginService } from './sales-margin.service';

@Module({
  imports: [InventoryModule],
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
  ],
})
export class ReportsModule {}
