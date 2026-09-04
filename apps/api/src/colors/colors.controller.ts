import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  createColorSchema,
  Role,
  updateColorSchema,
  type ColorDto,
  type CreateColorInput,
  type UpdateColorInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ColorsService } from './colors.service';

/**
 * RF-54: maestro de colores (D-085). Lectura para todos —el vendedor lo necesita para
 * cotizar y planta para elegir el rollo—, mutación solo ADMINISTRADOR, igual que acabados.
 */
@Controller('colors')
export class ColorsController {
  constructor(private readonly colors: ColorsService) {}

  @Get()
  findAll(): Promise<ColorDto[]> {
    return this.colors.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<ColorDto> {
    return this.colors.findOne(id);
  }

  @Post()
  @Roles(Role.ADMINISTRADOR)
  create(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(createColorSchema)) body: CreateColorInput,
  ): Promise<ColorDto> {
    return this.colors.create(actor, body);
  }

  @Patch(':id')
  @Roles(Role.ADMINISTRADOR)
  update(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateColorSchema)) body: UpdateColorInput,
  ): Promise<ColorDto> {
    return this.colors.update(actor, id, body);
  }
}
