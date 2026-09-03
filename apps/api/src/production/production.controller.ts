import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  cancelProductionOrderSchema,
  closeProductionOrderSchema,
  consumeStripSchema,
  createProductionOrderSchema,
  productionOrderQuerySchema,
  reportPiecesSchema,
  reverseMovementSchema,
  Role,
  upsertProductBomSchema,
  type CancelProductionOrderInput,
  type CloseProductionOrderInput,
  type ConsumeStripInput,
  type CreateProductionOrderInput,
  type ProductBomDto,
  type ProductionOrderDto,
  type ProductionOrderListItemDto,
  type ProductionOrderQuery,
  type ProductionStripOptionDto,
  type ReportPiecesInput,
  type ReverseMovementInput,
  type UpsertProductBomInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { BomsService } from './boms.service';
import { ProductionService } from './production.service';

/**
 * Producción de drywall (RF-32..35, RF-39). Restringido a ADMINISTRADOR y
 * SUPERVISOR_PLANTA (§3.4: el supervisor opera planta, el vendedor no entra) — por eso,
 * a diferencia de `/inventory` y `/cutting/strips`, acá los costos no se ocultan por rol:
 * VENDEDOR no llega a estas rutas.
 *
 * Reparto de operaciones según D-046: el supervisor opera y deshace lo que registra en
 * planta (consumir, reportar, revertir un reporte, cerrar); la receta del maestro
 * (D-059) y la anulación de la orden son de ADMINISTRADOR.
 */
@Controller('production')
@Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
export class ProductionController {
  constructor(
    private readonly production: ProductionService,
    private readonly boms: BomsService,
  ) {}

  // -------------------------------------------------------------------------
  // D-059 — recetas. Van antes de `:id` porque `boms` es una ruta fija.
  // -------------------------------------------------------------------------

  @Get('boms')
  findBoms(
    @Query('productId', new ParseUUIDPipe({ optional: true })) productId?: string,
  ): Promise<ProductBomDto[]> {
    return this.boms.findAll(productId);
  }

  @Get('boms/:productId')
  findBom(@Param('productId', ParseUUIDPipe) productId: string): Promise<ProductBomDto> {
    return this.boms.findByProduct(productId);
  }

  @Put('boms/:productId')
  @Roles(Role.ADMINISTRADOR)
  upsertBom(
    @CurrentUser() actor: RequestUser,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body(new ZodValidationPipe(upsertProductBomSchema)) body: UpsertProductBomInput,
  ): Promise<ProductBomDto> {
    return this.boms.upsert(actor, productId, body);
  }

  /** Flejes disponibles para producir ese producto (lo que `/planta` ofrece al operario). */
  @Get('strips')
  stripOptions(
    @Query('productId', ParseUUIDPipe) productId: string,
  ): Promise<ProductionStripOptionDto[]> {
    return this.production.stripOptions(productId);
  }

  // -------------------------------------------------------------------------
  // RF-34 — órdenes de producción
  // -------------------------------------------------------------------------

  @Get()
  findAll(
    @Query(new ZodValidationPipe(productionOrderQuerySchema)) query: ProductionOrderQuery,
  ): Promise<ProductionOrderListItemDto[]> {
    return this.production.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<ProductionOrderDto> {
    return this.production.findOne(id);
  }

  @Post()
  create(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(createProductionOrderSchema)) body: CreateProductionOrderInput,
  ): Promise<ProductionOrderDto> {
    return this.production.create(actor, body);
  }

  /** Poner un fleje a disposición de la orden (D-060: no mueve kardex). */
  @Post(':id/consume')
  consume(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(consumeStripSchema)) body: ConsumeStripInput,
  ): Promise<ProductionOrderDto> {
    return this.production.consume(actor, id, body);
  }

  /** Devolver un fleje asignado por error, si todavía no alimentó ninguna pieza. */
  @Post(':id/consumptions/:consumptionId/release')
  release(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('consumptionId', ParseUUIDPipe) consumptionId: string,
  ): Promise<ProductionOrderDto> {
    return this.production.release(actor, id, consumptionId);
  }

  /** Reportar piezas buenas (RF-34, D-058: parcial, N veces). */
  @Post(':id/report')
  report(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(reportPiecesSchema)) body: ReportPiecesInput,
  ): Promise<ProductionOrderDto> {
    return this.production.report(actor, id, body);
  }

  /** Revertir un reporte de piezas (RF-35, D-060). */
  @Post(':id/reports/:reportId/reverse')
  reverseReport(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Body(new ZodValidationPipe(reverseMovementSchema)) body: ReverseMovementInput,
  ): Promise<ProductionOrderDto> {
    return this.production.reverseReport(actor, id, reportId, body.reason);
  }

  /** Cerrar la orden: merma de proceso por diferencia y costeo (D-057, D-056). */
  @Post(':id/close')
  close(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(closeProductionOrderSchema)) body: CloseProductionOrderInput,
  ): Promise<ProductionOrderDto> {
    return this.production.close(actor, id, body);
  }

  /** Reabrir una orden cerrada: deshace la merma de proceso y el costeo (D-060). */
  @Post(':id/reopen')
  reopen(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(reverseMovementSchema)) body: ReverseMovementInput,
  ): Promise<ProductionOrderDto> {
    return this.production.reopen(actor, id, body.reason);
  }

  /** Anular la orden y liberar los flejes no consumidos (D-046: solo ADMINISTRADOR). */
  @Post(':id/cancel')
  @Roles(Role.ADMINISTRADOR)
  cancel(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(cancelProductionOrderSchema)) body: CancelProductionOrderInput,
  ): Promise<ProductionOrderDto> {
    return this.production.cancel(actor, id, body);
  }
}
