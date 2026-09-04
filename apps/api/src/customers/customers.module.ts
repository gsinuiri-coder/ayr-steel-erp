import { Module } from '@nestjs/common';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { DocumentLookupService } from './document-lookup.service';

@Module({
  controllers: [CustomersController],
  providers: [CustomersService, DocumentLookupService],
  exports: [CustomersService],
})
export class CustomersModule {}
