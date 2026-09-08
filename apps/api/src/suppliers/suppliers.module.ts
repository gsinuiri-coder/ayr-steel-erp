import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

@Module({
  // D-151: el padrón de apis.net.pe lo provee `CustomersModule`, que es donde nació con el
  // alta de cliente (D-067). Se importa en vez de duplicarse: es el mismo token y la misma
  // cuota, y dos clientes del mismo servicio serían dos formas de quedarse sin ella.
  imports: [CustomersModule],
  controllers: [SuppliersController],
  providers: [SuppliersService],
  exports: [SuppliersService],
})
export class SuppliersModule {}
