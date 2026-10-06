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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  createCustomerSchema,
  businessToday,
  customerExportQuerySchema,
  customerQuerySchema,
  docNumberLengths,
  DocType,
  Role,
  searchQuerySchema,
  updateCustomerSchema,
  type CreateCustomerInput,
  type CustomerDto,
  type CustomerExportQuery,
  type CustomerQuery,
  type DocumentLookupDto,
  type PaginatedResult,
  type SearchQuery,
  type UpdateCustomerInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { sendXlsx } from '../common/list-export';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { customersXlsx } from './customers-xlsx';
import { CustomersService } from './customers.service';
import { DocumentLookupService } from './document-lookup.service';

/**
 * RF-80/RF-82/RF-85: clientes. Lectura para todos; alta y edición de datos básicos para
 * ADMINISTRADOR y VENDEDOR (D-076), con los campos sensibles —documento, días de crédito
 * y baja lógica— separados dentro del servicio, no por ruta.
 */
@Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA, Role.VENDEDOR)
@Controller('customers')
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly lookup: DocumentLookupService,
  ) {}

  @Get()
  findAll(
    @Query(new ZodValidationPipe(customerQuerySchema)) query: CustomerQuery,
  ): Promise<PaginatedResult<CustomerDto>> {
    return this.customers.findAll(query);
  }

  /**
   * cc26 M2 (D-provisional): el Excel de la lista de clientes, con la búsqueda y el orden de la
   * pantalla, sin paginar y hasta `LIST_XLSX_MAX_ROWS` (más, 400). Mismos roles que la lista
   * (D-439: no se cambia ningún permiso) y su mismo alcance: la lista no filtra por vendedor.
   * Va **antes** de `:id`: si no, `ParseUUIDPipe` rechaza «xlsx» como id.
   */
  @Get('xlsx')
  async findAllXlsx(
    @CurrentUser() actor: RequestUser,
    @Query(new ZodValidationPipe(customerExportQuerySchema)) query: CustomerExportQuery,
    @Res() res: Response,
  ): Promise<void> {
    const rows = await this.customers.exportAll(query);
    sendXlsx(res, customersXlsx(rows, actor.role, businessToday()));
  }

  /**
   * D-067: autocompletado de razón social y dirección desde apis.net.pe. Va **antes** de
   * `:id` porque `lookup` es una ruta fija y el `ParseUUIDPipe` de la otra la rechazaría.
   *
   * Con throttle propio, como la subida de XML de compras: cada llamada sale a un servicio
   * externo con nuestro token, así que un formulario en bucle no puede consumir la cuota.
   */
  @Get('lookup')
  // §3.4: el maestro de clientes es de ADMINISTRADOR y VENDEDOR. Sin este `@Roles`,
  // cualquier usuario autenticado gastaba la cuota del token de apis.net.pe, que además es
  // el mismo del tipo de cambio SUNAT (D-029).
  @Roles(Role.ADMINISTRADOR, Role.VENDEDOR)
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

  /**
   * RF-S3/M1: selector de cliente de cotizaciones y pedidos. Va **antes** de `:id` por el
   * mismo motivo que `lookup` — es una ruta fija, no un id.
   */
  @Get('search')
  search(
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQuery,
  ): Promise<CustomerDto[]> {
    return this.customers.search(query.q);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<CustomerDto> {
    return this.customers.findOne(id);
  }

  /** D-076: el vendedor da de alta al cliente que acaba de buscar por RUC (D-067). */
  @Post()
  @Roles(Role.ADMINISTRADOR, Role.VENDEDOR)
  create(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(createCustomerSchema)) body: CreateCustomerInput,
  ): Promise<CustomerDto> {
    return this.customers.create(actor, body);
  }

  /**
   * D-076: el vendedor edita datos básicos. Los días de crédito y la baja lógica los
   * rechaza `CustomersService.update` por rol, y el cliente del sistema (D-077) no se
   * edita con ninguno.
   */
  @Patch(':id')
  @Roles(Role.ADMINISTRADOR, Role.VENDEDOR)
  update(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateCustomerSchema)) body: UpdateCustomerInput,
  ): Promise<CustomerDto> {
    return this.customers.update(actor, id, body);
  }
}
