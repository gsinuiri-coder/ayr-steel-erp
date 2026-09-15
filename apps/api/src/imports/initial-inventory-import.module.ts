import { Module } from '@nestjs/common';
import { CoilsModule } from '../coils/coils.module';
import { InitialInventoryImportService } from './initial-inventory-import.service';

/**
 * D-206: carga de inventario inicial. Sin `controllers` a propósito — el único llamador es el
 * CLI de arranque (`prisma/import-initial-inventory-cli.ts`); ninguna ruta HTTP la expone.
 */
@Module({
  imports: [CoilsModule],
  providers: [InitialInventoryImportService],
  exports: [InitialInventoryImportService],
})
export class InitialInventoryImportModule {}
