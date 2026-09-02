import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { CoilsController } from './coils.controller';
import { CoilsService } from './coils.service';

/** Bobinas (RF-10..RF-14). Exporta el servicio para compras e importación de planilla. */
@Module({
  imports: [InventoryModule],
  controllers: [CoilsController],
  providers: [CoilsService],
  exports: [CoilsService],
})
export class CoilsModule {}
