import { Module } from '@nestjs/common';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { DocumentLookupService } from './document-lookup.service';

@Module({
  controllers: [CustomersController],
  providers: [CustomersService, DocumentLookupService],
  // D-137: los importadores históricos crean el proveedor o el cliente que falta
  // consultando el mismo padrón que ya usa el alta manual.
  exports: [CustomersService, DocumentLookupService],
})
export class CustomersModule {}
