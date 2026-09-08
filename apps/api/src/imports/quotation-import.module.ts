import { Module } from '@nestjs/common';
import { SalesModule } from '../sales/sales.module';
import { QuotationImportController } from './quotation-import.controller';
import { QuotationImportService } from './quotation-import.service';

/**
 * Importador masivo de cotizaciones (D-152). Todo lo que crea pasa por `QuotationsService`,
 * que es de `SalesModule`: este módulo aporta la lectura del archivo y nada más.
 */
@Module({
  imports: [SalesModule],
  controllers: [QuotationImportController],
  providers: [QuotationImportService],
})
export class QuotationImportModule {}
