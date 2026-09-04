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
  type ReverseDispatchInput,
  type TransportSuggestionsDto,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DispatchesService } from './dispatches.service';
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
  ) {}

  /**
   * D-078: valores de transporte ya usados, para autocompletar. Va antes de `:id` porque
   * es una ruta fija y el `ParseUUIDPipe` de la otra la rechazaría.
   */
  @Get('transport-suggestions')
  transportSuggestions(): Promise<TransportSuggestionsDto> {
    return this.dispatches.transportSuggestions();
  }

  @Get()
  findAll(
    @Query(new ZodValidationPipe(dispatchQuerySchema)) query: DispatchQuery,
  ): Promise<DispatchListItemDto[]> {
    return this.dispatches.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<DispatchDto> {
    return this.dispatches.findOne(id);
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
    return this.dispatches.reverse(actor, id, body.reason);
  }
}
