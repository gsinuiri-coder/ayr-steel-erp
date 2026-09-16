import { Controller, Get, Query } from '@nestjs/common';
import { auditQuerySchema, Role, type AuditPageDto, type AuditQuery } from '@ayr/shared';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuditQueryService } from './audit-query.service';

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
}
