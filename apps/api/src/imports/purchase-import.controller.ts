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
  confirmPurchaseImportSchema,
  Role,
  validatePurchaseImportSchema,
  type ConfirmPurchaseImportInput,
  type PurchaseImportDocumentDto,
  type PurchaseImportPreviewDto,
  type PurchaseImportResultDto,
  type PurchaseImportUndoResultDto,
  type ValidatePurchaseImportInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PurchaseImportService } from './purchase-import.service';

/** 5 MB: una carga mensual de compras son decenas de KB. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Extensiones que `parseSpreadsheet` sabe leer. */
const ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.csv'];

/**
 * Importador masivo de compras (D-351). Los mismos roles que registrar una compra hoy
 * (ADMINISTRADOR y SUPERVISOR_PLANTA, `PurchasesController`); deshacer un lote anula compras, y
 * anular es solo ADMINISTRADOR.
 *
 * Sin estado entre rutas: el preview no escribe nada ni guarda el archivo; lo que llega a la
 * confirmación es lo que el usuario revisó en pantalla.
 */
@Controller('imports/purchases')
@Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
export class PurchaseImportController {
  constructor(private readonly imports: PurchaseImportService) {}

  @Post('preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }))
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  preview(@UploadedFile() file?: Express.Multer.File): Promise<PurchaseImportPreviewDto> {
    if (!file) throw new BadRequestException('Falta el archivo');
    const name = file.originalname || 'archivo';
    if (!ALLOWED_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))) {
      throw new BadRequestException(
        `Formato no soportado: se admite ${ALLOWED_EXTENSIONS.join(', ')}`,
      );
    }
    return this.imports.preview(name, file.buffer);
  }

  /** Revalida los comprobantes editados en pantalla, con la misma regla. No escribe nada. */
  @Post('validate')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async validate(
    @Body(new ZodValidationPipe(validatePurchaseImportSchema)) body: ValidatePurchaseImportInput,
  ): Promise<PurchaseImportDocumentDto[]> {
    return (await this.imports.validate(body.documents)).documents;
  }

  /** Crea una compra en borrador por comprobante. Todo o nada, idempotente (D-182). */
  @Post()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  confirm(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(confirmPurchaseImportSchema)) body: ConfirmPurchaseImportInput,
  ): Promise<PurchaseImportResultDto> {
    return this.imports.confirm(actor, body);
  }

  /** Anula por el servicio las compras del lote que sigan en borrador y sin pagos. */
  @Post('batches/:batchId/undo')
  @Roles(Role.ADMINISTRADOR)
  undo(
    @CurrentUser() actor: RequestUser,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
  ): Promise<PurchaseImportUndoResultDto> {
    return this.imports.undo(actor, batchId);
  }
}
