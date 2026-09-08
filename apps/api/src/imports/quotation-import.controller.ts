/// <reference types="multer" />
import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  importQuotationsSchema,
  Role,
  type ImportQuotationsInput,
  type QuotationImportPreviewDto,
  type QuotationImportResultDto,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { QuotationImportService } from './quotation-import.service';

/** 5 MB: el export de un mes ronda los 25 KB, así que sobra por tres órdenes de magnitud. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Extensiones que `parseSpreadsheet` sabe leer. Cortar acá evita parsear basura. */
const ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.csv'];

/**
 * Importador masivo de cotizaciones (D-152).
 *
 * Solo ADMINISTRADOR: crea documentos comerciales en tanda a nombre de clientes reales, y es
 * la clase de operación que §3.4 no le da al vendedor aunque cotizar de a una sí sea suya.
 *
 * Dos rutas y **ningún estado entre ellas**: la previsualización no escribe nada y no guarda
 * el archivo. Lo que el navegador manda a `confirm` es lo que el usuario revisó y editó, no
 * un identificador de lote que hubiera que volver a leer del disco.
 */
@Controller('imports/quotations')
@Roles(Role.ADMINISTRADOR)
export class QuotationImportController {
  constructor(private readonly imports: QuotationImportService) {}

  /**
   * Lee el archivo y devuelve las filas resueltas contra el maestro. No escribe **nada**:
   * ni el archivo, ni un lote, ni una fila.
   */
  @Post('preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }))
  // Parsear una planilla es caro y no hay motivo para hacerlo en bucle.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  preview(@UploadedFile() file?: Express.Multer.File): Promise<QuotationImportPreviewDto> {
    if (!file) throw new BadRequestException('Falta el archivo');
    const name = file.originalname || 'archivo';
    if (!ALLOWED_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))) {
      throw new BadRequestException(
        `Formato no soportado: se admite ${ALLOWED_EXTENSIONS.join(', ')}`,
      );
    }
    return this.imports.preview(name, file.buffer);
  }

  /** Crea una cotización en borrador por documento. Todo o nada (D-152). */
  @Post()
  // Abre una transacción de hasta cinco minutos: dos importaciones simultáneas retienen
  // conexiones del pool todo ese rato. Es solo ADMINISTRADOR, pero el límite cuesta una línea.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  confirm(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(importQuotationsSchema)) body: ImportQuotationsInput,
  ): Promise<QuotationImportResultDto> {
    return this.imports.confirm(actor, body);
  }
}
