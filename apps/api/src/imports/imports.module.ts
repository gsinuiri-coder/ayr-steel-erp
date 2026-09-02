import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { CustomersImportAdapter } from './adapters/customers.adapter';
import { ProductsImportAdapter } from './adapters/products.adapter';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

@Module({
  imports: [DocumentsModule],
  controllers: [ImportsController],
  providers: [ImportsService, ProductsImportAdapter, CustomersImportAdapter],
})
export class ImportsModule {}
