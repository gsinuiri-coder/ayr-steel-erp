import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { coilQuerySchema, type CoilDto, type CoilQuery } from '@ayr/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CoilsService } from './coils.service';

/**
 * Bobinas (RF-10..RF-14, RF-23). Solo lectura: el alta entra por `purchases`
 * (manual/XML) o por `imports` (planilla), nunca por un POST directo a este módulo.
 */
@Controller('coils')
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
