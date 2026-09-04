import { Module } from '@nestjs/common';
import { CoilsModule } from '../coils/coils.module';
import { InventoryModule } from '../inventory/inventory.module';
import { BomsService } from './boms.service';
import { ProductionController } from './production.controller';
import { ProductionService } from './production.service';
import { RoofingProductionController } from './roofing-production.controller';
import { RoofingProductionService } from './roofing-production.service';

/**
 * Producción: drywall (RF-32..35, RF-39, Fase 4) y coberturas (RF-30..33, Fase 6, D-087).
 * Una sola tabla y dos servicios; el controller de coberturas se declara **antes** para que
 * `/production/roofing/...` no lo coma el `:id` de `/production`.
 *
 * Depende de `coils` (bloquea los
 * rollos que consume) y de `inventory` (único escritor del kardex, regla dura 2).
 *
 * El guardrail que `coils`, `cutting` y `purchases` necesitan sobre los flejes asignados
 * (D-060) NO sale de este módulo: vive en `production-assignments.ts` como función suelta
 * para no meter a los tres en un ciclo de módulos con este.
 */
@Module({
  imports: [InventoryModule, CoilsModule],
  controllers: [RoofingProductionController, ProductionController],
  providers: [ProductionService, RoofingProductionService, BomsService],
  exports: [ProductionService, BomsService],
})
export class ProductionModule {}
