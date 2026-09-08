import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { DocType } from '@prisma/client';
import {
  createSupplierSchema,
  docNumberLengths,
  Role,
  updateSupplierSchema,
  type CreateSupplierInput,
  type DocumentLookupDto,
  type SupplierDto,
  type UpdateSupplierInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DocumentLookupService } from '../customers/document-lookup.service';
import { SuppliersService } from './suppliers.service';

/** RF-81/RF-83/RF-85: proveedores. Lectura para todos, mutación solo ADMINISTRADOR. */
@Controller('suppliers')
export class SuppliersController {
  constructor(
    private readonly suppliers: SuppliersService,
    private readonly lookup: DocumentLookupService,
  ) {}

  @Get()
  findAll(): Promise<SupplierDto[]> {
    return this.suppliers.findAll();
  }

  /**
   * D-151: el mismo autocompletado del alta de cliente (D-067), ahora en la de proveedor.
   * Un proveedor se identifica por RUC igual que un cliente, y tipear la razón social a mano
   * es de donde salen los nombres que después no coinciden con la factura.
   *
   * Va **antes** de `:id` porque `lookup` es una ruta fija y el `ParseUUIDPipe` de la otra la
   * rechazaría. Con el mismo throttle y el mismo motivo que la de clientes: cada llamada sale
   * a un servicio externo con nuestro token, que además es el del tipo de cambio (D-029).
   */
  @Get('lookup')
  // Solo quien puede dar de alta un proveedor: el resto no tiene por qué gastar la cuota.
  @Roles(Role.ADMINISTRADOR)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async documentLookup(
    @Query('docType') docType: string,
    @Query('docNumber') docNumber: string,
  ): Promise<DocumentLookupDto> {
    const type = (Object.values(DocType) as string[]).includes(docType)
      ? (docType as DocType)
      : null;
    if (!type) throw new BadRequestException('Tipo de documento inválido');
    const number = (docNumber ?? '').trim();
    const { min, max } = docNumberLengths[type];
    if (!/^[A-Za-z0-9]+$/.test(number) || number.length < min || number.length > max) {
      throw new BadRequestException(`Número de ${type} inválido`);
    }
    return this.lookup.lookup(type, number);
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
