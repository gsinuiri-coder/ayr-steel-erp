import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  BUSINESS_LINES,
  inventoryQuerySchema,
  type BusinessLine,
  type InventoryBalanceDto,
  type InventoryMovementDto,
  type InventoryQuery,
  type InventorySummaryDto,
} from '@ayr/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { InventoryService } from './inventory.service';

const summaryQuerySchema = z.object({
  businessLine: z.enum(BUSINESS_LINES, {
    errorMap: () => ({ message: 'Línea de negocio inválida' }),
  }),
});

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

  /** Inventario valorizado agregado de una línea (RF-51): bobinas por tipo y productos. */
  @Get('summary')
  summary(
    @Query(new ZodValidationPipe(summaryQuerySchema)) query: { businessLine: BusinessLine },
  ): Promise<InventorySummaryDto> {
    return this.inventory.summary(query.businessLine);
  }
}
