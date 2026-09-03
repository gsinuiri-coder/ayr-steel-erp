import { Module } from '@nestjs/common';
import { CoilsModule } from '../coils/coils.module';
import { InventoryModule } from '../inventory/inventory.module';
import { BomsService } from './boms.service';
import { ProductionController } from './production.controller';
import { ProductionService } from './production.service';

/**
 * Producción de drywall (RF-32..35, RF-39, Fase 4). Depende de `coils` (bloquea los
 * flejes que consume) y de `inventory` (único escritor del kardex, regla dura 2).
 *
 * El guardrail que `coils`, `cutting` y `purchases` necesitan sobre los flejes asignados
 * (D-060) NO sale de este módulo: vive en `production-assignments.ts` como función suelta
 * para no meter a los tres en un ciclo de módulos con este.
 */
@Module({
  imports: [InventoryModule, CoilsModule],
  controllers: [ProductionController],
  providers: [ProductionService, BomsService],
  exports: [ProductionService, BomsService],
})
export class ProductionModule {}
