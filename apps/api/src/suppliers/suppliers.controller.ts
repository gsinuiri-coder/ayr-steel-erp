import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  createSupplierSchema,
  Role,
  updateSupplierSchema,
  type CreateSupplierInput,
  type SupplierDto,
  type UpdateSupplierInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SuppliersService } from './suppliers.service';

/** RF-81/RF-83/RF-85: proveedores. Lectura para todos, mutación solo ADMINISTRADOR. */
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get()
  findAll(): Promise<SupplierDto[]> {
    return this.suppliers.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<SupplierDto> {
    return this.suppliers.findOne(id);
  }

  @Post()
  @Roles(Role.ADMINISTRADOR)
  create(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(createSupplierSchema)) body: CreateSupplierInput,
  ): Promise<SupplierDto> {
    return this.suppliers.create(actor, body);
  }

  @Patch(':id')
  @Roles(Role.ADMINISTRADOR)
  update(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateSupplierSchema)) body: UpdateSupplierInput,
  ): Promise<SupplierDto> {
    return this.suppliers.update(actor, id, body);
  }
}
