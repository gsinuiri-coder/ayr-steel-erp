import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  cancelQuotationSchema,
  cancelSalesOrderSchema,
  createQuotationSchema,
  createSalesOrderSchema,
  quotationQuerySchema,
  releaseReservationSchema,
  reservationQuerySchema,
  Role,
  salesOrderQuerySchema,
  updateQuotationSchema,
  type CancelQuotationInput,
  type CancelSalesOrderInput,
  type CreateQuotationInput,
  type CreateSalesOrderInput,
  type QuotationDto,
  type QuotationListItemDto,
  type QuotationQuery,
  type ReleaseReservationInput,
  type ReservationDto,
  type ReservationQuery,
  type SalesOrderDto,
  type SalesOrderListItemDto,
  type SalesOrderQuery,
  type UpdateQuotationInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { QuotationsService } from './quotations.service';
import { SalesOrdersService } from './sales-orders.service';

/**
 * Ciclo comercial de Fase 5a (RF-61, RF-62, RF-65, RF-69).
 *
 * Rol base VENDEDOR + ADMINISTRADOR (§3.4: el vendedor cotiza y vende; el supervisor de
 * planta no entra al módulo comercial). Dos excepciones, ambas por D-046 —lo que toca
 * inventario de forma difícil de deshacer es de ADMINISTRADOR—: anular un pedido, que
 * libera stock prometido, y liberar una reserva a mano (D-054).
 *
 * Los precios y los totales de este módulo son **precios de venta**, no costos, así que no
 * se enmascaran por rol como en `/inventory`: el vendedor tiene que verlos para trabajar.
 */
@Controller('sales')
@Roles(Role.ADMINISTRADOR, Role.VENDEDOR)
export class SalesController {
  constructor(
    private readonly quotations: QuotationsService,
    private readonly orders: SalesOrdersService,
  ) {}

  // -------------------------------------------------------------------------
  // RF-69 — cotizaciones
  // -------------------------------------------------------------------------

  @Get('quotations')
  findQuotations(
    @Query(new ZodValidationPipe(quotationQuerySchema)) query: QuotationQuery,
  ): Promise<QuotationListItemDto[]> {
    return this.quotations.findAll(query);
  }

  @Get('quotations/:id')
  findQuotation(@Param('id', ParseUUIDPipe) id: string): Promise<QuotationDto> {
    return this.quotations.findOne(id);
  }

  /** PDF de la cotización (D-068). Se descarga desde R2; se genera al vuelo si falta. */
  @Get('quotations/:id/pdf')
  async quotationPdf(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const { buffer, filename } = await this.quotations.pdf(id);
    res.setHeader('Content-Type', 'application/pdf');
    // `attachment` y no `inline`: el nombre viene de un correlativo del sistema, no del
    // usuario, pero descargar en vez de renderizar deja al navegador fuera del asunto.
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  @Post('quotations')
  createQuotation(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(createQuotationSchema)) body: CreateQuotationInput,
  ): Promise<QuotationDto> {
    return this.quotations.create(actor, body);
  }

  /** RF-66: editar mientras siga en borrador. */
  @Put('quotations/:id')
  updateQuotation(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateQuotationSchema)) body: UpdateQuotationInput,
  ): Promise<QuotationDto> {
    return this.quotations.update(actor, id, body);
  }

  @Post('quotations/:id/emit')
  emitQuotation(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<QuotationDto> {
    return this.quotations.emit(actor, id);
  }

  /** RF-62: confirmar crea pedido + reserva en una transacción (D-054). */
  @Post('quotations/:id/confirm')
  confirmQuotation(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SalesOrderDto> {
    return this.orders.confirm(actor, id);
  }

  /** RF-65: anular una cotización no confirmada. */
  @Post('quotations/:id/cancel')
  cancelQuotation(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(cancelQuotationSchema)) body: CancelQuotationInput,
  ): Promise<QuotationDto> {
    return this.quotations.cancel(actor, id, body.reason);
  }

  /**
   * D-069: marca vencidas las cotizaciones cuya vigencia pasó. Lo corre el job diario de
   * pg-boss; el endpoint existe porque el API escala a cero en Cloud Run y hace falta
   * poder ponerlo al día bajo demanda (y probarlo end-to-end).
   */
  @Post('quotations/expire')
  @Roles(Role.ADMINISTRADOR)
  async expireQuotations(@CurrentUser() actor: RequestUser): Promise<{ expired: number }> {
    return { expired: await this.quotations.expireDue(actor.id) };
  }

  // -------------------------------------------------------------------------
  // Pedidos
  // -------------------------------------------------------------------------

  @Get('orders')
  findOrders(
    @Query(new ZodValidationPipe(salesOrderQuerySchema)) query: SalesOrderQuery,
  ): Promise<SalesOrderListItemDto[]> {
    return this.orders.findAll(query);
  }

  @Get('orders/:id')
  findOrder(@Param('id', ParseUUIDPipe) id: string): Promise<SalesOrderDto> {
    return this.orders.findOne(id);
  }

  /** D-065: pedido directo, solo en líneas cuya cotización es opcional. */
  @Post('orders')
  createOrder(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(createSalesOrderSchema)) body: CreateSalesOrderInput,
  ): Promise<SalesOrderDto> {
    return this.orders.createDirect(actor, body);
  }

  /** Anular el pedido y liberar sus reservas (D-046: solo ADMINISTRADOR). */
  @Post('orders/:id/cancel')
  @Roles(Role.ADMINISTRADOR)
  cancelOrder(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(cancelSalesOrderSchema)) body: CancelSalesOrderInput,
  ): Promise<SalesOrderDto> {
    return this.orders.cancel(actor, id, body.reason);
  }

  // -------------------------------------------------------------------------
  // Reservas (D-054, D-066)
  // -------------------------------------------------------------------------

  @Get('reservations')
  findReservations(
    @Query(new ZodValidationPipe(reservationQuerySchema)) query: ReservationQuery,
  ): Promise<ReservationDto[]> {
    return this.orders.findReservations(query);
  }

  /** Liberación manual (D-054): solo ADMINISTRADOR, siempre con motivo. */
  @Post('reservations/:id/release')
  @Roles(Role.ADMINISTRADOR)
  releaseReservation(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(releaseReservationSchema)) body: ReleaseReservationInput,
  ): Promise<ReservationDto> {
    return this.orders.releaseReservation(actor, id, body.reason);
  }
}
