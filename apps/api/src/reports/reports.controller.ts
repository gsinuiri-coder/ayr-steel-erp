import { Controller, Get, Query } from '@nestjs/common';
import {
  coilMonthReportQuerySchema,
  Role,
  type CoilMonthReportDto,
  type CoilMonthReportQuery,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ReportsService } from './reports.service';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * Reportes con corte mensual. Solo lectura.
 *
 * Los costos se enmascaran por rol con el mismo criterio que `/inventory` y `/coils`: un
 * VENDEDOR ve las cantidades que necesita para vender y no cuánto costó comprar el rollo.
 */
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  // El reporte es de planta: el menú ya lo restringe a estos dos roles (`nav.ts`) y la ruta
  // dice lo mismo, en vez de dejar que difieran. No es el caso de `/inventory`, que §3.4 sí le
  // abre al vendedor.
  @Get('coils')
  @Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
  coils(
    @CurrentUser() actor: RequestUser,
    @Query(new ZodValidationPipe(coilMonthReportQuerySchema)) query: CoilMonthReportQuery,
  ): Promise<CoilMonthReportDto> {
    return this.reports.coilsByMonth(query, canSeeCosts(actor));
  }
}

function canSeeCosts(actor: RequestUser): boolean {
  return actor.role === Role.ADMINISTRADOR || actor.role === Role.SUPERVISOR_PLANTA;
}
