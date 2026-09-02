import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  createProductSchema,
  Role,
  updateProductSchema,
  type CreateProductInput,
  type ProductDto,
  type UpdateProductInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CatalogService } from './catalog.service';

/** RF-50: catálogo por línea. Lectura para todos, mutación solo ADMINISTRADOR. */
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  findAll(@Query('businessLineId') businessLineId?: string): Promise<ProductDto[]> {
    return this.catalog.findAll(businessLineId);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<ProductDto> {
    return this.catalog.findOne(id);
  }

  @Post()
  @Roles(Role.ADMINISTRADOR)
  create(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductInput,
  ): Promise<ProductDto> {
    return this.catalog.create(actor, body);
  }

  @Patch(':id')
  @Roles(Role.ADMINISTRADOR)
  update(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductInput,
  ): Promise<ProductDto> {
    return this.catalog.update(actor, id, body);
  }
}
