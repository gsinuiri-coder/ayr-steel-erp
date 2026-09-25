import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  coilMonthReportQuerySchema,
  kardexPepsQuerySchema,
  salesMarginQuerySchema,
  Role,
  type CoilMonthReportDto,
  type CoilMonthReportQuery,
  type InventoryValuationDto,
  type KardexPepsQuery,
  type KardexPepsReportDto,
  type SalesMarginDto,
  type SalesMarginQuery,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { InventoryValuationService } from './inventory-valuation.service';
import { kardexPepsToDto } from './kardex-peps-dto';
import { kardexPepsXlsx } from './kardex-peps-xlsx';
import { KardexPepsService } from './kardex-peps.service';
import { inventoryValuationXlsx, salesMarginXlsx } from './reports-xlsx';
import { ReportsService } from './reports.service';
import { SalesMarginService } from './sales-margin.service';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * Reportes con corte mensual. Solo lectura.
 *
 * Los costos se enmascaran por rol con el mismo criterio que `/inventory` y `/coils`: un
 * VENDEDOR ve las cantidades que necesita para vender y no cuánto costó comprar el rollo.
 */
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly inventoryValuation: InventoryValuationService,
    private readonly salesMargin: SalesMarginService,
    private readonly kardexPeps: KardexPepsService,
  ) {}

  // El reporte es de planta: el menú ya lo restringe a estos dos roles (`nav.ts`) y la ruta
  // dice lo mismo, en vez de dejar que difieran. No es el caso de `/inventory`, que §3.4 sí le
  // abre al vendedor.
  @Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
  @Get('coils')
  coils(
    @CurrentUser() actor: RequestUser,
    @Query(new ZodValidationPipe(coilMonthReportQuerySchema)) query: CoilMonthReportQuery,
  ): Promise<CoilMonthReportDto> {
    return this.reports.coilsByMonth(query, canSeeCosts(actor));
  }

  /**
   * RF-S4a/M1. **Solo ADMINISTRADOR**, y a diferencia de `/reports/coils` no enmascara nada:
   * un reporte de costeo sin costos no es un reporte, así que en vez de vaciar columnas se
   * cierra la ruta entera. Lo mismo vale para `/reports/sales-margin`.
   */
  @Roles(Role.ADMINISTRADOR)
  @Get('inventory-valuation')
  inventoryValuationReport(): Promise<InventoryValuationDto> {
    return this.inventoryValuation.valuation();
  }

  /** RF-S4a/M2. Solo ADMINISTRADOR, por el mismo motivo. */
  @Roles(Role.ADMINISTRADOR)
  @Get('sales-margin')
  salesMarginReport(
    @Query(new ZodValidationPipe(salesMarginQuerySchema)) query: SalesMarginQuery,
  ): Promise<SalesMarginDto> {
    return this.salesMargin.salesMargin(query);
  }

  /**
   * RF-S4a/M3. El xlsx sale del **mismo DTO** que la pantalla, no de una segunda consulta:
   * dos caminos hasta la base para la misma pregunta es cómo el archivo y la pantalla
   * terminan diciendo números distintos.
   */
  @Roles(Role.ADMINISTRADOR)
  @Get('inventory-valuation/xlsx')
  async inventoryValuationXlsxFile(@Res() res: Response): Promise<void> {
    const report = await this.inventoryValuation.valuation();
    sendXlsx(res, inventoryValuationXlsx(report));
  }

  /** RF-S4a/M3. */
  @Roles(Role.ADMINISTRADOR)
  @Get('sales-margin/xlsx')
  async salesMarginXlsxFile(
    @Query(new ZodValidationPipe(salesMarginQuerySchema)) query: SalesMarginQuery,
    @Res() res: Response,
  ): Promise<void> {
    const report = await this.salesMargin.salesMargin(query);
    sendXlsx(res, salesMarginXlsx(report));
  }

  /**
   * D-296. El mismo kardex PEPS, en JSON, para verlo en pantalla junto al costo promedio.
   * Sale del mismo servicio que el Excel (`KardexPepsService.report`): no recalcula nada. Solo
   * ADMINISTRADOR, como el Excel.
   */
  @Roles(Role.ADMINISTRADOR)
  @Get('kardex-peps')
  async kardexPepsJson(
    @Query(new ZodValidationPipe(kardexPepsQuerySchema)) query: KardexPepsQuery,
  ): Promise<KardexPepsReportDto> {
    return kardexPepsToDto(await this.kardexPeps.report(query));
  }

  /**
   * D-279. Kardex PEPS de un producto o una bobina en el formato 13.1 de SUNAT. Solo
   * ADMINISTRADOR: es un reporte de costos. No cambia la valorización del sistema (D-028).
   */
  @Roles(Role.ADMINISTRADOR)
  @Get('kardex-peps/xlsx')
  async kardexPepsXlsxFile(
    @Query(new ZodValidationPipe(kardexPepsQuerySchema)) query: KardexPepsQuery,
    @Res() res: Response,
  ): Promise<void> {
    const report = await this.kardexPeps.report(query);
    sendXlsx(res, kardexPepsXlsx(report));
  }
}

function sendXlsx(res: Response, file: { buffer: Buffer; filename: string }): void {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.send(file.buffer);
}

function canSeeCosts(actor: RequestUser): boolean {
  return actor.role === Role.ADMINISTRADOR || actor.role === Role.SUPERVISOR_PLANTA;
}
