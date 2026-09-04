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
import {
  createCustomerSchema,
  docNumberLengths,
  DocType,
  Role,
  updateCustomerSchema,
  type CreateCustomerInput,
  type CustomerDto,
  type DocumentLookupDto,
  type UpdateCustomerInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CustomersService } from './customers.service';
import { DocumentLookupService } from './document-lookup.service';

/** RF-80/RF-82/RF-85: clientes. Lectura para todos, mutación solo ADMINISTRADOR. */
@Controller('customers')
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly lookup: DocumentLookupService,
  ) {}

  @Get()
  findAll(): Promise<CustomerDto[]> {
    return this.customers.findAll();
  }

  /**
   * D-067: autocompletado de razón social y dirección desde apis.net.pe. Va **antes** de
   * `:id` porque `lookup` es una ruta fija y el `ParseUUIDPipe` de la otra la rechazaría.
   *
   * Con throttle propio, como la subida de XML de compras: cada llamada sale a un servicio
   * externo con nuestro token, así que un formulario en bucle no puede consumir la cuota.
   */
  @Get('lookup')
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
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<CustomerDto> {
    return this.customers.findOne(id);
  }

  @Post()
  @Roles(Role.ADMINISTRADOR)
  create(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(createCustomerSchema)) body: CreateCustomerInput,
  ): Promise<CustomerDto> {
    return this.customers.create(actor, body);
  }

  @Patch(':id')
  @Roles(Role.ADMINISTRADOR)
  update(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateCustomerSchema)) body: UpdateCustomerInput,
  ): Promise<CustomerDto> {
    return this.customers.update(actor, id, body);
  }
}
