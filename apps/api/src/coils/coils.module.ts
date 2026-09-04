import { Module } from '@nestjs/common';
import { ColorsModule } from '../colors/colors.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CoilOperationsService } from './coil-operations.service';
import { CoilsController } from './coils.controller';
import { CoilsService } from './coils.service';

/**
 * Bobinas (RF-10..RF-23). Exporta `CoilsService` para compras e importación de
 * planilla, y `CoilOperationsService` para que `purchases` pueda anular las bobinas
 * de una compra recibida (RF-21) e imputarles landed cost (D-043).
 */
@Module({
  imports: [InventoryModule, ColorsModule],
  controllers: [CoilsController],
  providers: [CoilsService, CoilOperationsService],
  exports: [CoilsService, CoilOperationsService],
})
export class CoilsModule {}
