import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  createDispatchSchema,
  dispatchQuerySchema,
  reverseDispatchSchema,
  Role,
  type CreateDispatchInput,
  type DispatchDto,
  type DispatchListItemDto,
  type DispatchQuery,
  type FiscalDocumentDto,
  type InvoiceDispatchPlanDto,
  type InvoiceDispatchResultDto,
  type PaginatedResult,
  type ReverseDispatchInput,
  type TransportSuggestionsDto,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DispatchesService } from './dispatches.service';
import { InvoiceDispatchService } from './invoice-dispatch.service';
import { InvoicingService } from './invoicing.service';

/**
 * Despachos (RF-77..RF-79).
 *
 * **El rol base incluye SUPERVISOR_PLANTA**, a diferencia del resto del módulo: despachar
 * es un acto de almacén (D-074) y quien saca la mercadería es planta, no el vendedor. El
 * despacho no transporta ningún precio, así que no hay costo que ocultar por rol.
 *
 * La excepción es **revertir**: devuelve stock al kardex y cambia el estado del pedido, que
 * es exactamente lo que D-046 reserva a ADMINISTRADOR.
 */
@Controller('dispatches')
@Roles(Role.ADMINISTRADOR, Role.VENDEDOR, Role.SUPERVISOR_PLANTA)
export class DispatchesController {
  constructor(
    private readonly dispatches: DispatchesService,
    private readonly invoicing: InvoicingService,
    private readonly invoiceDispatch: InvoiceDispatchService,
  ) {}

  /**
   * D-078: valores de transporte ya usados, para autocompletar. Va antes de `:id` porque
   * es una ruta fija y el `ParseUUIDPipe` de la otra la rechazaría.
   */
  @Get('transport-suggestions')
  transportSuggestions(): Promise<TransportSuggestionsDto> {
    return this.dispatches.transportSuggestions();
  }

  /**
   * D-278: qué haría «Despachar a la fecha del comprobante». Solo lectura. Rutas fijas antes
   * de `:id`, por el mismo motivo que `transport-suggestions`.
   */
  @Get('at-issue-date/:invoiceId')
  previewAtIssueDate(
    @CurrentUser() actor: RequestUser,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
  ): Promise<InvoiceDispatchPlanDto> {
    return this.invoiceDispatch.preview(actor, invoiceId);
  }

  /**
   * D-278: despacha lo facturado y no despachado con fecha de operación = fecha de emisión.
   * Retrofechar sigue siendo privilegio de ADMINISTRADOR (D-124): `OperationDateService`
   * rechaza a cualquier otro rol cuando la emisión no es de hoy.
   */
  @Post('at-issue-date/:invoiceId')
  @Roles(Role.ADMINISTRADOR)
  executeAtIssueDate(
    @CurrentUser() actor: RequestUser,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
  ): Promise<InvoiceDispatchResultDto> {
    return this.invoiceDispatch.executeForInvoice(actor, invoiceId);
  }

  @Get()
  findAll(
    @CurrentUser() actor: RequestUser,
    @Query(new ZodValidationPipe(dispatchQuerySchema)) query: DispatchQuery,
  ): Promise<PaginatedResult<DispatchListItemDto>> {
    return this.dispatches.findAll(query, actor);
  }

  @Get(':id')
  findOne(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DispatchDto> {
    return this.dispatches.findOne(id, actor);
  }

  /** RF-77: saca la mercadería, mueve kardex y cierra el pedido (D-074). */
  @Post()
  create(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(createDispatchSchema)) body: CreateDispatchInput,
  ): Promise<DispatchDto> {
    return this.dispatches.create(actor, body);
  }

  /** RF-78: guía de remisión remitente del despacho (D-078). */
  @Post(':id/dispatch-note')
  issueDispatchNote(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FiscalDocumentDto> {
    return this.invoicing.issueDispatchNote(actor, id);
  }

  /** RF-79: devuelve stock y estado del pedido (D-046: solo ADMINISTRADOR). */
  @Post(':id/reverse')
  @Roles(Role.ADMINISTRADOR)
  reverse(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(reverseDispatchSchema)) body: ReverseDispatchInput,
  ): Promise<DispatchDto> {
    return this.dispatches.reverse(actor, id, body);
  }
}
