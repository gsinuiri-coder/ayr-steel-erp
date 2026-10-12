import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  auditExportQuerySchema,
  auditQuerySchema,
  businessToday,
  Role,
  type AuditExportQuery,
  type AuditPageDto,
  type AuditQuery,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { sendXlsx } from '../common/list-export';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuditQueryService } from './audit-query.service';
import { auditXlsx } from './audit-xlsx';

/** Visor de auditoría (D-218/RF-S2/M3). Solo ADMINISTRADOR — decisión del dueño (A3). */
@Controller('audit')
@Roles(Role.ADMINISTRADOR)
export class AuditController {
  constructor(private readonly auditQuery: AuditQueryService) {}

  @Get()
  findPage(
    @Query(new ZodValidationPipe(auditQuerySchema)) query: AuditQuery,
  ): Promise<AuditPageDto> {
    return this.auditQuery.findPage(query);
  }

  /**
   * cc48 (D-634): el Excel del visor, con el buscar y los filtros de la pantalla, todas sus
   * páginas y el código legible de cada entidad (D-633). Mismo permiso que la lista. Pasado el tope
   * de filas (`LIST_XLSX_MAX_ROWS`), 400 «acota los filtros»; nunca un archivo recortado.
   */
  @Get('xlsx')
  async findXlsx(
    @CurrentUser() actor: RequestUser,
    @Query(new ZodValidationPipe(auditExportQuerySchema)) query: AuditExportQuery,
    @Res() res: Response,
  ): Promise<void> {
    const rows = await this.auditQuery.exportAll(query);
    sendXlsx(res, auditXlsx(rows, actor.role, businessToday()));
  }
}
