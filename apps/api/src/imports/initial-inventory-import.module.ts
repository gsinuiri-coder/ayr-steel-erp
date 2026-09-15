import { Module } from '@nestjs/common';
import { CoilsModule } from '../coils/coils.module';
import { InventoryModule } from '../inventory/inventory.module';
import { InitialInventoryImportService } from './initial-inventory-import.service';
import { InitialInventoryProductImportService } from './initial-inventory-product-import.service';

/**
 * D-206: carga de inventario inicial (bobinas y, desde F8-S6a2, productos UPVC/reventa por
 * unidades). Sin `controllers` a propósito — el único llamador es el CLI de arranque
 * (`prisma/import-initial-inventory-cli.ts`); ninguna ruta HTTP la expone.
 */
@Module({
  imports: [CoilsModule, InventoryModule],
  providers: [InitialInventoryImportService, InitialInventoryProductImportService],
  exports: [InitialInventoryImportService, InitialInventoryProductImportService],
})
export class InitialInventoryImportModule {}
