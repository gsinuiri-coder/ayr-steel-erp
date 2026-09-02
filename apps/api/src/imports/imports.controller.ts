/// <reference types="multer" />
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  IMPORT_ENTITIES,
  Role,
  updateImportRowSchema,
  type ImportBatchDto,
  type ImportBatchWithRowsDto,
  type ImportEntity,
  type ImportRowDto,
  type UpdateImportRowInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ImportsService } from './imports.service';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** RF-52: importación masiva desde planilla. Catálogo y clientes son maestros → solo ADMINISTRADOR. */
@Controller('imports')
@Roles(Role.ADMINISTRADOR)
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Get()
  findAll(): Promise<ImportBatchDto[]> {
    return this.imports.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<ImportBatchWithRowsDto> {
    return this.imports.findOne(id);
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }))
  upload(
    @CurrentUser() actor: RequestUser,
    @Body('entity') entity: string,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ImportBatchWithRowsDto> {
    if (!file) throw new BadRequestException('Falta el archivo');
    if (!IMPORT_ENTITIES.includes(entity as ImportEntity)) {
      throw new BadRequestException(`Entidad de importación inválida: ${entity}`);
    }
    return this.imports.upload(actor, entity as ImportEntity, {
      originalname: file.originalname,
      mimetype: file.mimetype,
      buffer: file.buffer,
    });
  }

  @Patch(':id/rows/:rowId')
  updateRow(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Body(new ZodValidationPipe(updateImportRowSchema)) body: UpdateImportRowInput,
  ): Promise<ImportRowDto> {
    return this.imports.updateRow(id, rowId, body.data);
  }

  @Post(':id/confirm')
  confirm(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ImportBatchWithRowsDto> {
    return this.imports.confirm(actor, id);
  }
}
