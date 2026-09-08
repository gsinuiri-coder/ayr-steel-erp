import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  cancelQuotationSchema,
  cancelSalesOrderSchema,
  confirmQuotationSchema,
  createQuotationSchema,
  createSalesOrderSchema,
  quotationQuerySchema,
  releaseReservationSchema,
  reservationQuerySchema,
  Role,
  salesOrderQuerySchema,
  sellableCoilQuerySchema,
  stockPanelQuerySchema,
  setSalesOrderPrioritySchema,
  updatePromisedDeliveryDateSchema,
  updateQuotationSchema,
  type CancelQuotationInput,
  type CancelSalesOrderInput,
  type ConfirmQuotationInput,
  type CreateQuotationInput,
  type CreateSalesOrderInput,
  type ProductionQueueEntryDto,
  type PaginatedResult,
  type QuotationDto,
  type QuotationListItemDto,
  type QuotationQuery,
  type ReleaseReservationInput,
  type ReservationDto,
  type ReservationQuery,
  type SalesOrderDto,
  type SalesOrderListItemDto,
  type SalesOrderQuery,
  type SellableCoilDto,
  type StockPanelDto,
  type StockPanelQuery,
  type SellableCoilQuery,
  type SetSalesOrderPriorityInput,
  type UpdatePromisedDeliveryDateInput,
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
  ): Promise<PaginatedResult<QuotationListItemDto>> {
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

  /**
   * Hoja de planta del pedido (D-149): sin importes y armada al vuelo. Vive con las rutas
   * de pedidos —y no con las de producción— porque lo que imprime es el pedido, y quien la
   * baja es el mismo que lo mira.
   */
  @Get('orders/:id/pdf-planta')
  // El único documento de este controller que **no** es comercial: es el papel del taller, y
  // por eso suma SUPERVISOR_PLANTA a los roles de la clase (§3.4). No lleva importes, así que
  // no le abre nada de lo que el resto del módulo le oculta a ese rol.
  @Roles(Role.ADMINISTRADOR, Role.VENDEDOR, Role.SUPERVISOR_PLANTA)
  async plantOrderPdf(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const { buffer, filename } = await this.orders.plantPdf(id);
    res.setHeader('Content-Type', 'application/pdf');
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

  /**
   * D-119: duplica una cotización en cualquier estado a un BORRADOR nuevo (número propio),
   * con el mismo cliente y las mismas líneas revalidadas contra el catálogo y el kardex
   * vigentes. Los precios negociados se copian y quedan editables — "recalculables" es
   * justo eso, no un recálculo automático.
   */
  @Post('quotations/:id/duplicate')
  duplicateQuotation(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<QuotationDto> {
    return this.quotations.duplicate(actor, id);
  }

  @Post('quotations/:id/emit')
  emitQuotation(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<QuotationDto> {
    return this.quotations.emit(actor, id);
  }

  /**
   * RF-62: confirmar crea pedido + reserva en una transacción (D-054).
   * `promisedDeliveryDate` es opcional (D-096): única ventana en la que el vendedor la fija.
   */
  @Post('quotations/:id/confirm')
  confirmQuotation(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(confirmQuotationSchema)) body: ConfirmQuotationInput,
  ): Promise<SalesOrderDto> {
    return this.orders.confirm(actor, id, body.promisedDeliveryDate);
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
  ): Promise<PaginatedResult<SalesOrderListItemDto>> {
    return this.orders.findAll(query);
  }

  /**
   * La cola de producción (RF-37, D-092..D-096). **También la lee SUPERVISOR_PLANTA**, por
   * el mismo motivo que `reservations`: es la pantalla de entrada de `/planta`. Va antes de
   * `orders/:id` — si no, `ParseUUIDPipe` rechaza "queue" como si fuera un id.
   */
  @Get('orders/queue')
  @Roles(Role.ADMINISTRADOR, Role.VENDEDOR, Role.SUPERVISOR_PLANTA)
  findProductionQueue(): Promise<ProductionQueueEntryDto[]> {
    return this.orders.findProductionQueue();
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

  /** Prioridad manual excepcional de la cola (D-094): solo ADMINISTRADOR, con motivo. */
  @Patch('orders/:id/priority')
  @Roles(Role.ADMINISTRADOR)
  setOrderPriority(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(setSalesOrderPrioritySchema)) body: SetSalesOrderPriorityInput,
  ): Promise<SalesOrderDto> {
    return this.orders.setPriority(actor, id, body);
  }

  /** Fecha prometida, después de creado el pedido (D-096): solo ADMINISTRADOR. */
  @Patch('orders/:id/promised-delivery-date')
  @Roles(Role.ADMINISTRADOR)
  setOrderPromisedDeliveryDate(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updatePromisedDeliveryDateSchema))
    body: UpdatePromisedDeliveryDateInput,
  ): Promise<SalesOrderDto> {
    return this.orders.setPromisedDeliveryDate(actor, id, body.promisedDeliveryDate);
  }

  // -------------------------------------------------------------------------
  // Reservas (D-054, D-066)
  // -------------------------------------------------------------------------

  /**
   * Panel de stock en vivo del formulario de cotización (D-136): el agregado de materia
   * prima de una línea de negocio y el disponible de los SKU que el vendedor tiene puestos.
   * Solo lectura y sin ningún costo. Va antes de `reservations` solo por orden de lectura.
   */
  @Get('stock-panel')
  stockPanel(
    @Query(new ZodValidationPipe(stockPanelQuerySchema)) query: StockPanelQuery,
  ): Promise<StockPanelDto> {
    return this.orders.stockPanel(query);
  }

  /**
   * Bobinas DISPONIBLES para vender enteras (D-116): abiertas o cerradas, sin custodia de
   * corte ni de producción, con saldo. El formulario de cotización/pedido de tipo BOBINA
   * arma la línea contra `coilId`, así que acá no viaja ningún costo (mismo motivo que
   * `reservable-coils`).
   */
  @Get('sellable-coils')
  findSellableCoils(
    @Query(new ZodValidationPipe(sellableCoilQuerySchema)) query: SellableCoilQuery,
  ): Promise<SellableCoilDto[]> {
    return this.orders.findSellableCoils(query);
  }

  /**
   * Reservas activas. **También la lee SUPERVISOR_PLANTA**, que es la excepción al rol base
   * del módulo: la terminal de planta necesita saber qué pedidos esperan producción para
   * poder crear la orden contra su reserva (D-066). Sin eso, el material reservado quedaba
   * bloqueado para toda orden y planta no tenía forma de crear la única que podía tomarlo.
   * No transporta ningún costo — solo qué se prometió, a quién y cuánto.
   */
  @Get('reservations')
  @Roles(Role.ADMINISTRADOR, Role.VENDEDOR, Role.SUPERVISOR_PLANTA)
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
