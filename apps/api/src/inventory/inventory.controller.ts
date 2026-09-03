import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  BUSINESS_LINES,
  inventoryQuerySchema,
  Role,
  type BusinessLine,
  type InventoryBalanceDto,
  type InventoryMovementDto,
  type InventoryQuery,
  type InventorySummaryDto,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
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
 *
 * §3.4 le da a VENDEDOR "inventario (lectura)", que son **cantidades**: los costos de
 * compra quedan fuera de su alcance, igual que en `coils` y `purchases`. En vez de
 * cerrarle la ruta entera, el servicio le devuelve los campos de costo en `null`, así
 * ve el stock que necesita para cotizar sin ver cuánto costó comprarlo.
 */
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('balances')
  findBalances(
    @CurrentUser() actor: RequestUser,
    @Query(new ZodValidationPipe(inventoryQuerySchema)) query: InventoryQuery,
  ): Promise<InventoryBalanceDto[]> {
    return this.inventory.findBalances(query, canSeeCosts(actor));
  }

  @Get('movements')
  findMovements(
    @CurrentUser() actor: RequestUser,
    @Query(new ZodValidationPipe(inventoryQuerySchema)) query: InventoryQuery,
  ): Promise<InventoryMovementDto[]> {
    return this.inventory.findMovements(query, canSeeCosts(actor));
  }

  /** Inventario valorizado agregado de una línea (RF-51): bobinas por tipo y productos. */
  @Get('summary')
  summary(
    @CurrentUser() actor: RequestUser,
    @Query(new ZodValidationPipe(summaryQuerySchema)) query: { businessLine: BusinessLine },
  ): Promise<InventorySummaryDto> {
    return this.inventory.summary(query.businessLine, canSeeCosts(actor));
  }
}

function canSeeCosts(actor: RequestUser): boolean {
  return actor.role === Role.ADMINISTRADOR || actor.role === Role.SUPERVISOR_PLANTA;
}
