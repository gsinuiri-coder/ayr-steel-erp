import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  cancelProductionOrderSchema,
  closeRoofingOrderSchema,
  createRoofingOrderSchema,
  mountRoofingCoilSchema,
  reportRoofingPiecesSchema,
  reverseMovementSchema,
  Role,
  updateRoofingPlanSchema,
  type CancelProductionOrderInput,
  type CloseRoofingOrderInput,
  type CreateRoofingOrderInput,
  type MountRoofingCoilInput,
  type ProductionOrderDto,
  type ReportRoofingPiecesInput,
  type ReverseMovementInput,
  type RoofingCoilOptionDto,
  type UpdateRoofingPlanInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RoofingProductionService } from './roofing-production.service';

/**
 * Producción de coberturas metálicas (RF-30..RF-33; D-082..D-091).
 *
 * Rutas propias y no un parámetro de `/production` (D-087): el cuerpo de cada operación es
 * distinto —largos en vez de piezas, kilos declarados en el cierre— y compartir endpoint
 * habría obligado a un schema con la mitad de los campos opcionales, que es como se cuela
 * un reporte de coberturas contra la aritmética de drywall.
 *
 * Mismos roles que la rama de drywall (§3.4, D-046): el supervisor opera y deshace lo que
 * registra en planta; anular la orden es de ADMINISTRADOR. Las consultas (listado y detalle)
 * viven en `/production`, que devuelve las dos clases de orden.
 */
@Controller('production/roofing')
@Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
export class RoofingProductionController {
  constructor(private readonly roofing: RoofingProductionService) {}

  /**
   * Bobinas que la orden puede montar: el filtro de D-086 ya aplicado (abierta, con saldo,
   * espesor dentro de tolerancia, mismo color). `reservationId` es la reserva propia de la
   * orden, para que su material no se excluya a sí mismo.
   */
  @Get('coils')
  coilOptions(
    @Query('productId', ParseUUIDPipe) productId: string,
    @Query('reservationId', new ParseUUIDPipe({ optional: true })) reservationId?: string,
  ): Promise<RoofingCoilOptionDto[]> {
    return this.roofing.coilOptions(productId, reservationId);
  }

  /** Crear la OP desde la reserva de un pedido (RF-31, D-084). */
  @Post()
  create(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(createRoofingOrderSchema)) body: CreateRoofingOrderInput,
  ): Promise<ProductionOrderDto> {
    return this.roofing.create(actor, body);
  }

  /** Ajustar el plan de corte que se copió del pedido (D-084). */
  @Put(':id/plan')
  updatePlan(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateRoofingPlanSchema)) body: UpdateRoofingPlanInput,
  ): Promise<ProductionOrderDto> {
    return this.roofing.updatePlan(actor, id, body);
  }

  /** Montar una bobina en la roladora (D-086; custodia, no mueve kardex). */
  @Post(':id/coils')
  mountCoil(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(mountRoofingCoilSchema)) body: MountRoofingCoilInput,
  ): Promise<ProductionOrderDto> {
    return this.roofing.mountCoil(actor, id, body);
  }

  /** Bajar una bobina montada por error, si todavía no roló nada. */
  @Post(':id/coils/:consumptionId/release')
  releaseCoil(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('consumptionId', ParseUUIDPipe) consumptionId: string,
  ): Promise<ProductionOrderDto> {
    return this.roofing.releaseCoil(actor, id, consumptionId);
  }

  /** Reportar los largos reales (D-083, parcial y N veces como D-058). */
  @Post(':id/report')
  report(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(reportRoofingPiecesSchema)) body: ReportRoofingPiecesInput,
  ): Promise<ProductionOrderDto> {
    return this.roofing.report(actor, id, body);
  }

  /** Revertir un reporte de largos (RF-33, D-088: devuelve la promesa a la bobina). */
  @Post(':id/reports/:reportId/reverse')
  reverseReport(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Body(new ZodValidationPipe(reverseMovementSchema)) body: ReverseMovementInput,
  ): Promise<ProductionOrderDto> {
    return this.roofing.reverseReport(actor, id, reportId, body.reason);
  }

  /** Cerrar: kilos consumidos declarados y merma por despunte (D-089). */
  @Post(':id/close')
  close(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(closeRoofingOrderSchema)) body: CloseRoofingOrderInput,
  ): Promise<ProductionOrderDto> {
    return this.roofing.close(actor, id, body);
  }

  /** Reabrir una orden cerrada: deshace el despunte y el costeo. */
  @Post(':id/reopen')
  reopen(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(reverseMovementSchema)) body: ReverseMovementInput,
  ): Promise<ProductionOrderDto> {
    return this.roofing.reopen(actor, id, body.reason);
  }

  /** Anular la orden y liberar las bobinas montadas (D-046: solo ADMINISTRADOR). */
  @Post(':id/cancel')
  @Roles(Role.ADMINISTRADOR)
  cancel(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(cancelProductionOrderSchema)) body: CancelProductionOrderInput,
  ): Promise<ProductionOrderDto> {
    return this.roofing.cancel(actor, id, body.reason);
  }
}
