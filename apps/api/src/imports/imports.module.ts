import { Module } from '@nestjs/common';
import { CoilsModule } from '../coils/coils.module';
import { DocumentsModule } from '../documents/documents.module';
import { InvoicingModule } from '../invoicing/invoicing.module';
import { CoilsImportAdapter } from './adapters/coils.adapter';
import { CustomersImportAdapter } from './adapters/customers.adapter';
import { FiscalDocumentsImportAdapter } from './adapters/fiscal-documents.adapter';
import { ProductsImportAdapter } from './adapters/products.adapter';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

@Module({
  // `invoicing` porque el comprobante importado (RF-71) lo crea `FiscalImportService`:
  // las reglas de qué serie le toca y qué se puede reimportar son de ese módulo, no de acá.
  imports: [DocumentsModule, CoilsModule, InvoicingModule],
  controllers: [ImportsController],
  providers: [
    ImportsService,
    ProductsImportAdapter,
    CustomersImportAdapter,
    CoilsImportAdapter,
    FiscalDocumentsImportAdapter,
  ],
})
export class ImportsModule {}
