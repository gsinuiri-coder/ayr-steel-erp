import { Module } from '@nestjs/common';
import { CoilsModule } from '../coils/coils.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CuttingController } from './cutting.controller';
import { CuttingService } from './cutting.service';

/** Corte tercerizado (RF-40..42, RF-22). Depende de `coils` (crea flejes) y `inventory` (kardex). */
@Module({
  imports: [InventoryModule, CoilsModule],
  controllers: [CuttingController],
  providers: [CuttingService],
  exports: [CuttingService],
})
export class CuttingModule {}
