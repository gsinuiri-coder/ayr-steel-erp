/// <reference types="multer" />
import {
  BadRequestException,
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  confirmPriceListImportSchema,
  revertPriceListImportSchema,
  Role,
  type ConfirmPriceListImportInput,
  type PriceListImportPreviewDto,
  type PriceListImportResultDto,
  type PriceListRevertResultDto,
  type RevertPriceListImportInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PriceListImportService } from './price-list-import.service';

/** 5 MB: sobra por varios órdenes de magnitud para un catálogo de miles de SKU. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.csv'];

/**
 * Carga masiva del precio de lista (D-217/M1c). Solo ADMINISTRADOR — mismo criterio que el
 * importador de cotizaciones (D-152): dos rutas y ningún estado entre ellas.
 */
@Controller('catalog/price-list/import')
@Roles(Role.ADMINISTRADOR)
export class PriceListImportController {
  constructor(private readonly imports: PriceListImportService) {}

  @Post('preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }))
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  preview(@UploadedFile() file?: Express.Multer.File): Promise<PriceListImportPreviewDto> {
    if (!file) throw new BadRequestException('Falta el archivo');
    const name = file.originalname || 'archivo';
    if (!ALLOWED_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))) {
      throw new BadRequestException(
        `Formato no soportado: se admite ${ALLOWED_EXTENSIONS.join(', ')}`,
      );
    }
    return this.imports.preview(file.buffer);
  }

  @Post()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  confirm(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(confirmPriceListImportSchema)) body: ConfirmPriceListImportInput,
  ): Promise<PriceListImportResultDto> {
    return this.imports.confirm(actor, body);
  }

  @Post(':batchId/revert')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  revert(
    @CurrentUser() actor: RequestUser,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Body(new ZodValidationPipe(revertPriceListImportSchema)) body: RevertPriceListImportInput,
  ): Promise<PriceListRevertResultDto> {
    return this.imports.revert(actor, batchId, body);
  }
}
