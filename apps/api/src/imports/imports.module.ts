import { Module } from '@nestjs/common';
import { CoilsModule } from '../coils/coils.module';
import { DocumentsModule } from '../documents/documents.module';
import { InventoryModule } from '../inventory/inventory.module';
import { InvoicingModule } from '../invoicing/invoicing.module';
import { CustomersModule } from '../customers/customers.module';
import { ProductionModule } from '../production/production.module';
import { SalesModule } from '../sales/sales.module';
import { CoilsImportAdapter } from './adapters/coils.adapter';
import { CoilsHistoryImportAdapter } from './adapters/coils-history.adapter';
import { CustomersImportAdapter } from './adapters/customers.adapter';
import { FiscalDocumentsImportAdapter } from './adapters/fiscal-documents.adapter';
import { ProductsImportAdapter } from './adapters/products.adapter';
import { SalesHistoryImportAdapter } from './adapters/sales-history.adapter';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

@Module({
  // `invoicing` porque el comprobante importado (RF-71) lo crea `FiscalImportService`:
  // las reglas de qué serie le toca y qué se puede reimportar son de ese módulo, no de acá.
  // `customers` por `DocumentLookupService`: el importador histórico crea el proveedor
  // que falta consultando el mismo padrón que ya usa el alta de clientes (D-067).
  // `sales` y `production` porque cada comprobante de ventas importado crea además su pedido
  // (D-141) y, si el dueño lo marcó pendiente, la OP en cola de cada línea a medida: las
  // tres cosas nacen en la **misma** transacción o el documento no entra.
  imports: [
    DocumentsModule,
    CoilsModule,
    InventoryModule,
    InvoicingModule,
    CustomersModule,
    SalesModule,
    ProductionModule,
  ],
  controllers: [ImportsController],
  providers: [
    ImportsService,
    ProductsImportAdapter,
    CustomersImportAdapter,
    CoilsImportAdapter,
    CoilsHistoryImportAdapter,
    FiscalDocumentsImportAdapter,
    SalesHistoryImportAdapter,
  ],
})
export class ImportsModule {}
