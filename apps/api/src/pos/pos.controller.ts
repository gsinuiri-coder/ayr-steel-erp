import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  cashSessionQuerySchema,
  closeCashSessionSchema,
  createPosSaleSchema,
  openCashSessionSchema,
  posProductQuerySchema,
  Role,
  voidPosSaleSchema,
  type CashSessionDto,
  type CashSessionQuery,
  type CloseCashSessionInput,
  type CreatePosSaleInput,
  type OpenCashSessionInput,
  type PosContextDto,
  type PosProductDto,
  type PosProductQuery,
  type PosSaleListItemDto,
  type VoidPosSaleInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CashSessionsService } from './cash-sessions.service';
import { PosService } from './pos.service';

/**
 * Punto de venta de mostrador (RF-60; D-098..D-104).
 *
 * **Rol base VENDEDOR + ADMINISTRADOR**: el mostrador es del vendedor. El supervisor de
 * planta queda fuera por el mismo motivo que en `sales` — no vende ni cobra.
 *
 * Las dos operaciones que suben de rol están marcadas una por una, y las dos por el mismo
 * criterio de D-046 (deshacer y aceptar diferencias es de quien responde):
 *
 * - **anular una venta** revierte cobro, comprobante, despacho y pedido;
 * - **cerrar una caja con diferencia** acepta un faltante o un sobrante de dinero. Cerrar
 *   una caja **cuadrada** sigue siendo del cajero, que es el caso normal; el servicio
 *   distingue los dos, porque el rol solo se puede exigir cuando ya se sabe si cuadra.
 */
@Controller('pos')
@Roles(Role.ADMINISTRADOR, Role.VENDEDOR)
export class PosController {
  constructor(
    private readonly pos: PosService,
    private readonly cashSessions: CashSessionsService,
  ) {}

  /** Todo lo que `/pos` necesita al abrirse: turno, cliente genérico y estado del PSE. */
  @Get('context')
  context(@CurrentUser() actor: RequestUser): Promise<PosContextDto> {
    return this.pos.context(actor);
  }

  /** Buscador del carrito: productos con disponible real (D-098). */
  @Get('products')
  findProducts(
    @Query(new ZodValidationPipe(posProductQuerySchema)) query: PosProductQuery,
  ): Promise<PosProductDto[]> {
    return this.pos.findProducts(query);
  }

  // -------------------------------------------------------------------------
  // Caja (D-101)
  // -------------------------------------------------------------------------

  @Get('cash-sessions')
  findCashSessions(
    @CurrentUser() actor: RequestUser,
    @Query(new ZodValidationPipe(cashSessionQuerySchema)) query: CashSessionQuery,
  ): Promise<CashSessionDto[]> {
    return this.cashSessions.findAll(actor, query);
  }

  @Get('cash-sessions/:id')
  findCashSession(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CashSessionDto> {
    return this.cashSessions.findOne(actor, id);
  }

  /** Ventas del turno, vigentes y anuladas. */
  @Get('cash-sessions/:id/sales')
  findCashSessionSales(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PosSaleListItemDto[]> {
    return this.pos.findByCashSession(actor, id);
  }

  @Post('cash-sessions')
  openCashSession(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(openCashSessionSchema)) body: OpenCashSessionInput,
  ): Promise<CashSessionDto> {
    return this.cashSessions.open(actor, body);
  }

  /**
   * Cierre con arqueo. El rol **no** se exige acá sino en el servicio: hasta no calcular el
   * esperado no se sabe si hay diferencia, y exigir ADMINISTRADOR para todo cierre le
   * quitaría al cajero la operación que más hace.
   */
  @Post('cash-sessions/:id/close')
  closeCashSession(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(closeCashSessionSchema)) body: CloseCashSessionInput,
  ): Promise<CashSessionDto> {
    return this.cashSessions.close(actor, id, body);
  }

  // -------------------------------------------------------------------------
  // Ventas (D-099, D-100)
  // -------------------------------------------------------------------------

  /** RF-60: pedido + despacho + comprobante + cobro en una transacción (D-099). */
  @Post('sales')
  sell(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(createPosSaleSchema)) body: CreatePosSaleInput,
  ): Promise<PosSaleListItemDto> {
    return this.pos.sell(actor, body);
  }

  @Get('sales/:id')
  findSale(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PosSaleListItemDto> {
    return this.pos.findOne(id, actor);
  }

  /** D-100: cadena de reversas completa. Solo ADMINISTRADOR, como toda reversa (D-046). */
  @Post('sales/:id/void')
  @Roles(Role.ADMINISTRADOR)
  voidSale(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(voidPosSaleSchema)) body: VoidPosSaleInput,
  ): Promise<PosSaleListItemDto> {
    return this.pos.voidSale(actor, id, body.reason);
  }
}
