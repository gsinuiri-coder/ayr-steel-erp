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
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  IMPORT_ENTITIES,
  importOptionsSchema,
  paginationQuerySchema,
  Role,
  updateImportGroupSchema,
  updateImportRowSchema,
  type CoilImportCheckDto,
  type ImportBatchDto,
  type ImportBatchWithRowsDto,
  type ImportEntity,
  type ImportOptions,
  type ImportRowDto,
  type PaginatedResult,
  type PaginationQuery,
  type UpdateImportGroupInput,
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
  findAll(
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<PaginatedResult<ImportBatchDto>> {
    return this.imports.findAll(query);
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
    @Body('options') options?: string,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ImportBatchWithRowsDto> {
    if (!file) throw new BadRequestException('Falta el archivo');
    if (!IMPORT_ENTITIES.includes(entity as ImportEntity)) {
      throw new BadRequestException(`Entidad de importación inválida: ${entity}`);
    }
    return this.imports.upload(
      actor,
      entity as ImportEntity,
      {
        originalname: file.originalname,
        mimetype: file.mimetype,
        buffer: file.buffer,
      },
      // D-137: las opciones del lote viajan como JSON en un campo del `multipart`, que es la
      // única forma de mandar un objeto junto al archivo. Se validan con el mismo schema
      // que las guarda: un JSON roto es un 400 acá y no una opción ignorada en silencio.
      parseOptions(options),
    );
  }

  /**
   * Saldo vs objetivo de una carga de bobinas (D-137). En modo replay dice dónde no cuadra
   * después de cargar los consumos; en modo ajuste tiene que dar cero desde el primer día.
   */
  @Get(':id/coil-stock-check')
  coilStockCheck(@Param('id', ParseUUIDPipe) id: string): Promise<CoilImportCheckDto> {
    return this.imports.coilStockCheck(id);
  }

  /**
   * D-141: una corrección que vale para todo un grupo (el toggle "entregado / pendiente" de
   * un comprobante). Devuelve el lote entero porque cambiar un documento cambia el veredicto
   * de todas sus líneas a la vez.
   */
  @Patch(':id/group')
  updateGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateImportGroupSchema)) body: UpdateImportGroupInput,
  ): Promise<ImportBatchWithRowsDto> {
    return this.imports.updateGroup(id, body.groupKey, body.data);
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

/** Las opciones del lote que vienen en el `multipart`, ya validadas. */
function parseOptions(raw: string | undefined): ImportOptions | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new BadRequestException('Las opciones de importación no son un JSON válido');
  }
  const parsed = importOptionsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new BadRequestException(
      parsed.error.issues[0]?.message ?? 'Opciones de importación inválidas',
    );
  }
  return parsed.data;
}
