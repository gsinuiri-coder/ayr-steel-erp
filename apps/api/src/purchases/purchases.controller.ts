/// <reference types="multer" />
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  createPurchaseSchema,
  createSupplierPaymentSchema,
  purchaseQuerySchema,
  Role,
  type CreatePurchaseInput,
  type CreateSupplierPaymentInput,
  type InvoiceXmlPreviewDto,
  type PurchaseDto,
  type PurchaseListItemDto,
  type PurchaseQuery,
  type SupplierStatementDto,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PurchasesService } from './purchases.service';

/** Una factura electrónica real pesa unos pocos KB; 2 MB es holgado y acota el DoS. */
const MAX_XML_BYTES = 2 * 1024 * 1024;

/**
 * Compras (D-030). Todo el módulo queda fuera del alcance de VENDEDOR (§3.4): expone
 * costos de compra y cuentas por pagar, que no son parte de su trabajo. Registrar y
 * recibir es de ADMINISTRADOR y SUPERVISOR_PLANTA (el supervisor maneja bobinas e
 * inventario, y la recepción es justamente eso); pagar, anular y el estado de cuenta
 * del proveedor son solo de ADMINISTRADOR.
 */
@Controller('purchases')
@Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Get()
  findAll(
    @Query(new ZodValidationPipe(purchaseQuerySchema)) query: PurchaseQuery,
  ): Promise<PurchaseListItemDto[]> {
    return this.purchases.findAll(query);
  }

  @Get('suppliers/:supplierId/statement')
  @Roles(Role.ADMINISTRADOR)
  statement(@Param('supplierId', ParseUUIDPipe) supplierId: string): Promise<SupplierStatementDto> {
    return this.purchases.supplierStatement(supplierId);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<PurchaseDto> {
    return this.purchases.findOne(id);
  }

  /** RF-11: sube el XML de la factura del proveedor y devuelve la compra prellenada. */
  @Post('xml/preview')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_XML_BYTES, files: 1 },
      fileFilter: (_req, file, cb) => {
        const isXml = /.xml$/i.test(file.originalname) || /xml/i.test(file.mimetype);
        cb(isXml ? null : new BadRequestException('Solo se admite un archivo .xml'), isXml);
      },
    }),
  )
  previewXml(
    @CurrentUser() actor: RequestUser,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<InvoiceXmlPreviewDto> {
    if (!file) throw new BadRequestException('Falta el archivo XML');
    return this.purchases.previewFromXml(actor, {
      originalname: file.originalname,
      buffer: file.buffer,
    });
  }

  @Post()
  @Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
  create(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(createPurchaseSchema)) body: CreatePurchaseInput,
  ): Promise<PurchaseDto> {
    return this.purchases.create(actor, body);
  }

  @Post(':id/receive')
  @Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
  receive(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PurchaseDto> {
    return this.purchases.receive(actor, id);
  }

  @Post(':id/payments')
  @Roles(Role.ADMINISTRADOR)
  addPayment(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createSupplierPaymentSchema)) body: CreateSupplierPaymentInput,
  ): Promise<PurchaseDto> {
    return this.purchases.addPayment(actor, id, body);
  }

  @Post(':id/cancel')
  @Roles(Role.ADMINISTRADOR)
  cancel(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PurchaseDto> {
    return this.purchases.cancel(actor, id);
  }
}
