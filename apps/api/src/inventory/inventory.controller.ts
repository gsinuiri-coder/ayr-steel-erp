import { Controller, Get, Query } from '@nestjs/common';
import {
  inventoryQuerySchema,
  type InventoryBalanceDto,
  type InventoryMovementDto,
  type InventoryQuery,
} from '@ayr/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { InventoryService } from './inventory.service';

/**
 * Kardex e inventario valorizado (RF-51, RF-53). Solo lectura: escribir stock es
 * exclusivo de `InventoryService.record`, que se llama desde el módulo que origina
 * el movimiento, nunca por HTTP (§3.2).
 */
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('balances')
  findBalances(
    @Query(new ZodValidationPipe(inventoryQuerySchema)) query: InventoryQuery,
  ): Promise<InventoryBalanceDto[]> {
    return this.inventory.findBalances(query);
  }

  @Get('movements')
  findMovements(
    @Query(new ZodValidationPipe(inventoryQuerySchema)) query: InventoryQuery,
  ): Promise<InventoryMovementDto[]> {
    return this.inventory.findMovements(query);
  }
}
