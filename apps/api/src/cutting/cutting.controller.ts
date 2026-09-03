import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  cancelCuttingOrderSchema,
  createCuttingOrderSchema,
  cuttingOrderQuerySchema,
  receiveCuttingOrderCoilSchema,
  reverseMovementSchema,
  Role,
  stripStockQuerySchema,
  type CancelCuttingOrderInput,
  type CreateCuttingOrderInput,
  type CuttingOrderDto,
  type CuttingOrderListItemDto,
  type CuttingOrderQuery,
  type ReceiveCuttingOrderCoilInput,
  type ReverseMovementInput,
  type StripStockQuery,
  type StripStockRowDto,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CuttingService } from './cutting.service';

/**
 * Corte tercerizado (RF-40..42, RF-22). SUPERVISOR_PLANTA opera envío, recepción y
 * cancelación (§3.4: bobinas, producción, corte tercerizado, inventario); vincular la
 * factura del servicio es flujo normal de `purchases`. El stock de flejes (RF-42) queda
 * abierto a los tres roles, igual que el resto de inventario de solo lectura.
 */
@Controller('cutting')
@Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
export class CuttingController {
  constructor(private readonly cutting: CuttingService) {}

  /** RF-42. Va antes de `:id` porque `strips` es una ruta fija. */
  @Get('strips')
  @Roles()
  stripStock(
    @CurrentUser() actor: RequestUser,
    @Query(new ZodValidationPipe(stripStockQuerySchema)) query: StripStockQuery,
  ): Promise<StripStockRowDto[]> {
    return this.cutting.stripStock(query, canSeeCosts(actor));
  }

  @Get()
  findAll(
    @Query(new ZodValidationPipe(cuttingOrderQuerySchema)) query: CuttingOrderQuery,
  ): Promise<CuttingOrderListItemDto[]> {
    return this.cutting.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<CuttingOrderDto> {
    return this.cutting.findOne(id);
  }

  /** Enviar bobinas a corte tercerizado (RF-40). */
  @Post()
  send(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(createCuttingOrderSchema)) body: CreateCuttingOrderInput,
  ): Promise<CuttingOrderDto> {
    return this.cutting.send(actor, body);
  }

  /** Recibir los flejes de una bobina de la orden, con posible merma y diferencia vs. plan (RF-41). */
  @Post(':id/coils/:coilId/receive')
  receive(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('coilId', ParseUUIDPipe) coilId: string,
    @Body(new ZodValidationPipe(receiveCuttingOrderCoilSchema)) body: ReceiveCuttingOrderCoilInput,
  ): Promise<CuttingOrderDto> {
    return this.cutting.receive(actor, id, coilId, body);
  }

  /** Revertir la recepción de una bobina de la orden (Fase 3b, simétrico a RF-16). */
  @Post(':id/coils/:coilId/reverse')
  reverse(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('coilId', ParseUUIDPipe) coilId: string,
    @Body(new ZodValidationPipe(reverseMovementSchema)) body: ReverseMovementInput,
  ): Promise<CuttingOrderDto> {
    return this.cutting.reverse(actor, id, coilId, body.reason);
  }

  /** Cancelar lo no recibido de la orden (RF-22). */
  @Post(':id/cancel')
  cancel(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(cancelCuttingOrderSchema)) body: CancelCuttingOrderInput,
  ): Promise<CuttingOrderDto> {
    return this.cutting.cancel(actor, id, body.reason);
  }
}

function canSeeCosts(actor: RequestUser): boolean {
  return actor.role === Role.ADMINISTRADOR || actor.role === Role.SUPERVISOR_PLANTA;
}
