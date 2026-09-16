import { Module } from '@nestjs/common';
import { ColorsModule } from '../colors/colors.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { PriceListImportController } from './price-list-import.controller';
import { PriceListImportService } from './price-list-import.service';

@Module({
  imports: [ColorsModule],
  controllers: [CatalogController, PriceListImportController],
  providers: [CatalogService, PriceListImportService],
  exports: [CatalogService],
})
export class CatalogModule {}
