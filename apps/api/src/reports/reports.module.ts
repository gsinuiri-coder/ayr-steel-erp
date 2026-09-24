import { Module } from '@nestjs/common';
import { InventoryValuationService } from './inventory-valuation.service';
import { KardexPepsService } from './kardex-peps.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { SalesMarginService } from './sales-margin.service';

@Module({
  controllers: [ReportsController],
  providers: [ReportsService, InventoryValuationService, SalesMarginService, KardexPepsService],
})
export class ReportsModule {}
