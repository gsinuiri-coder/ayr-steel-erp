import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { InventoryValuationService } from './inventory-valuation.service';
import { KardexPepsService } from './kardex-peps.service';
import { KardexSheetService } from './kardex-sheet.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { SalesMarginService } from './sales-margin.service';

@Module({
  imports: [InventoryModule],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    InventoryValuationService,
    SalesMarginService,
    KardexPepsService,
    KardexSheetService,
  ],
})
export class ReportsModule {}
