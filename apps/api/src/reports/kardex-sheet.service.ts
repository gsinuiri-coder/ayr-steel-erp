import { Injectable } from '@nestjs/common';
import {
  movementsToKardexSheet,
  pepsToKardexSheet,
  type KardexSheet,
  type KardexSheetQuery,
} from '@ayr/shared';
import { InventoryService } from '../inventory/inventory.service';
import { kardexPepsToDto } from './kardex-peps-dto';
import { KardexPepsService } from './kardex-peps.service';

/**
 * D-298 — la hoja del kardex de un ítem con el formato del cliente, en el método elegido. Solo
 * lectura: **compone** lo que ya existe —el kardex a costo promedio (`InventoryService`) o el
 * reporte PEPS de D-279 (`KardexPepsService`)— y no calcula ningún costo nuevo.
 */
@Injectable()
export class KardexSheetService {
  constructor(
    private readonly inventory: InventoryService,
    private readonly peps: KardexPepsService,
  ) {}

  async sheet(query: KardexSheetQuery): Promise<KardexSheet> {
    if (query.method === 'PEPS') {
      return pepsToKardexSheet(kardexPepsToDto(await this.peps.report(query)));
    }
    const [item, movements] = await Promise.all([
      this.inventory.resolveItem({ itemType: query.itemType, itemId: query.itemId }),
      // Con `showCosts`: la ruta es de ADMINISTRADOR, que ve todos los costos.
      this.inventory.findMovements(
        { itemType: query.itemType, itemId: query.itemId, from: query.from, to: query.to },
        true,
      ),
    ]);
    return movementsToKardexSheet(movements.items, {
      itemCode: item.code,
      itemDescription: item.description,
      from: query.from,
      to: query.to,
      unit: movements.items[0]?.unit ?? null,
    });
  }
}
