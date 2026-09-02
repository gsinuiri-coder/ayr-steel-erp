import { Module } from '@nestjs/common';
import { CoilsModule } from '../coils/coils.module';
import { DocumentsModule } from '../documents/documents.module';
import { CoilsImportAdapter } from './adapters/coils.adapter';
import { CustomersImportAdapter } from './adapters/customers.adapter';
import { ProductsImportAdapter } from './adapters/products.adapter';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

@Module({
  imports: [DocumentsModule, CoilsModule],
  controllers: [ImportsController],
  providers: [ImportsService, ProductsImportAdapter, CustomersImportAdapter, CoilsImportAdapter],
})
export class ImportsModule {}
