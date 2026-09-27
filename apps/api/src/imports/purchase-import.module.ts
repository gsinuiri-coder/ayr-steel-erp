import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { PurchasesModule } from '../purchases/purchases.module';
import { SuppliersModule } from '../suppliers/suppliers.module';
import { PurchaseImportController } from './purchase-import.controller';
import { PurchaseImportService } from './purchase-import.service';

/**
 * Importador masivo de compras (D-351). Todo lo que crea pasa por `PurchasesService` y
 * `SuppliersService`; el padrón es el mismo `DocumentLookupService` del alta de cliente (D-158).
 */
@Module({
  imports: [PurchasesModule, SuppliersModule, CustomersModule],
  controllers: [PurchaseImportController],
  providers: [PurchaseImportService],
})
export class PurchaseImportModule {}
