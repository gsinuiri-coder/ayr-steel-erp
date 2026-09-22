import { Role } from '@ayr/shared';
import { Roles } from '../auth/decorators/roles.decorator';
import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import type { BusinessLineDto } from '@ayr/shared';
import { BusinessLinesService } from './business-lines.service';

/** Lectura de líneas de negocio (§2.2): todos los roles autenticados. */
@Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA, Role.VENDEDOR)
@Controller('business-lines')
export class BusinessLinesController {
  constructor(private readonly businessLines: BusinessLinesService) {}

  @Get()
  findAll(): Promise<BusinessLineDto[]> {
    return this.businessLines.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<BusinessLineDto> {
    return this.businessLines.findOne(id);
  }
}
