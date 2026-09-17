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
import {
  BUSINESS_LINES,
  createProductSchema,
  Role,
  searchQuerySchema,
  updateProductSchema,
  type BusinessLine,
  type CreateProductInput,
  type PriceListFloorDto,
  type PriceListFloorSummaryDto,
  type ProductDto,
  type ProductListPriceChangeDto,
  type SearchQuery,
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

  // D-217/M1: antes de ':id' — un GET de un solo segmento matchea contra ':id' si se
  // declara después, y 'price-list' se leería como un uuid inválido.
  @Get('price-list/changes')
  findPriceListChanges(
    @Query('productId') productId?: string,
  ): Promise<ProductListPriceChangeDto[]> {
    return this.catalog.findPriceListChanges(productId);
  }

  /**
   * RF-S3/M1: selector de producto con stock (D-188). Va **antes** de `:id`, mismo motivo
   * que `price-list/changes`.
   */
  @Get('search')
  search(
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQuery,
    @Query('businessLine') businessLine?: string,
  ): Promise<ProductDto[]> {
    // Hallazgo de `revisor` (RF-S3/cierre): un `businessLine` mal escrito se ignoraba en
    // silencio y la búsqueda seguía sin filtrar — un typo del front mostraba productos de
    // cualquier línea sin avisar nada. `undefined` (el parámetro no vino) sigue siendo "sin
    // filtro", a propósito; lo que ya no se acepta es un valor que no es ninguna línea real.
    if (
      businessLine !== undefined &&
      !(BUSINESS_LINES as readonly string[]).includes(businessLine)
    ) {
      throw new BadRequestException(`Línea de negocio inválida: ${businessLine}`);
    }
    return this.catalog.search(query.q, businessLine as BusinessLine | undefined);
  }

  /**
   * RF-S3/M4 (sacrificable): resumen agregado para el card del Panel. Va **antes** de
   * `:id`, mismo motivo que `price-list/changes` y `search`.
   *
   * Solo ADMINISTRADOR (hallazgo de `revisor`, RF-S3/cierre): el margen mínimo por línea
   * que decide este piso vive en Administración → Márgenes (D-175), y sin este guard
   * cualquier rol autenticado podía pedir el endpoint directo y ver qué SKU se vende bajo
   * margen en todo el catálogo — el control anterior era solo del lado del cliente
   * (`enabled: isAdmin` en la card), que no protege nada.
   */
  @Get('price-list/floor-summary')
  @Roles(Role.ADMINISTRADOR)
  findPriceListFloorSummary(): Promise<PriceListFloorSummaryDto> {
    return this.catalog.findPriceListFloorSummary();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<ProductDto> {
    return this.catalog.findOne(id);
  }

  @Get(':id/price-floor')
  priceFloor(@Param('id', ParseUUIDPipe) id: string): Promise<PriceListFloorDto> {
    return this.catalog.priceFloor(id);
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
