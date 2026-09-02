import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  createFinishSchema,
  Role,
  updateFinishSchema,
  type CreateFinishInput,
  type FinishDto,
  type UpdateFinishInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { FinishesService } from './finishes.service';

/** RF-25: catálogo de acabados. Lectura para todos, mutación solo ADMINISTRADOR. */
@Controller('finishes')
export class FinishesController {
  constructor(private readonly finishes: FinishesService) {}

  @Get()
  findAll(): Promise<FinishDto[]> {
    return this.finishes.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<FinishDto> {
    return this.finishes.findOne(id);
  }

  @Post()
  @Roles(Role.ADMINISTRADOR)
  create(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(createFinishSchema)) body: CreateFinishInput,
  ): Promise<FinishDto> {
    return this.finishes.create(actor, body);
  }

  @Patch(':id')
  @Roles(Role.ADMINISTRADOR)
  update(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateFinishSchema)) body: UpdateFinishInput,
  ): Promise<FinishDto> {
    return this.finishes.update(actor, id, body);
  }
}
