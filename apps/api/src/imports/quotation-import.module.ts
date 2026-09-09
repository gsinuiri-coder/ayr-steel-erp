import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { SalesModule } from '../sales/sales.module';
import { QuotationImportController } from './quotation-import.controller';
import { QuotationImportService } from './quotation-import.service';

/**
 * Importador masivo de cotizaciones (D-152). Todo lo que crea pasa por `QuotationsService`,
 * que es de `SalesModule`: este módulo aporta la lectura del archivo y nada más.
 *
 * D-158 suma `CustomersModule`: el alta desde el padrón reusa `CustomersService.createInTx` y
 * `DocumentLookupService`, los mismos que el alta manual y el autocompletado de D-067.
 */
@Module({
  imports: [SalesModule, CustomersModule],
  controllers: [QuotationImportController],
  providers: [QuotationImportService],
})
export class QuotationImportModule {}
