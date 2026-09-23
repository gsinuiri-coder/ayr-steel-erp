import { Module } from '@nestjs/common';
import { ColorsModule } from '../colors/colors.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { CoilSkuNormalizationService } from './coil-sku-normalization.service';
import { PriceListImportController } from './price-list-import.controller';
import { PriceListImportService } from './price-list-import.service';

@Module({
  imports: [ColorsModule],
  controllers: [CatalogController, PriceListImportController],
  // D-252/D-253: la normalización de SKU de bobina solo la usa su CLI (dry-run por defecto).
  providers: [CatalogService, PriceListImportService, CoilSkuNormalizationService],
  exports: [CatalogService, CoilSkuNormalizationService],
})
export class CatalogModule {}
