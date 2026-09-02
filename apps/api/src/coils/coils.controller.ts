import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { coilQuerySchema, Role, type CoilDto, type CoilQuery } from '@ayr/shared';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CoilsService } from './coils.service';

/**
 * Bobinas (RF-10..RF-14, RF-23). Solo lectura: el alta entra por `purchases`
 * (manual/XML) o por `imports` (planilla), nunca por un POST directo a este módulo.
 * Restringido a ADMINISTRADOR y SUPERVISOR_PLANTA (§3.4) porque el DTO lleva el costo
 * de compra por kilo.
 */
@Controller('coils')
@Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
export class CoilsController {
  constructor(private readonly coils: CoilsService) {}

  @Get()
  findAll(@Query(new ZodValidationPipe(coilQuerySchema)) query: CoilQuery): Promise<CoilDto[]> {
    return this.coils.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<CoilDto> {
    return this.coils.findOne(id);
  }
}
