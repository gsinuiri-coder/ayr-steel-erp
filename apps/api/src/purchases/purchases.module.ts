import { Module } from '@nestjs/common';
import { CoilsModule } from '../coils/coils.module';
import { ColorsModule } from '../colors/colors.module';
import { DocumentsModule } from '../documents/documents.module';
import { ExchangeRatesModule } from '../exchange-rates/exchange-rates.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PurchasesController } from './purchases.controller';
import { PurchasesService } from './purchases.service';

/** Compras (D-030). Depende de kardex y bobinas porque la recepción escribe en ambos. */
@Module({
  imports: [InventoryModule, CoilsModule, ColorsModule, ExchangeRatesModule, DocumentsModule],
  controllers: [PurchasesController],
  providers: [PurchasesService],
  exports: [PurchasesService],
})
export class PurchasesModule {}
