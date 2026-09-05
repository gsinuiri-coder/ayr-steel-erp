import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type ImportRow } from '@prisma/client';
import {
  ImportBatchStatus,
  ImportRowStatus,
  type ImportBatchDto,
  type ImportBatchWithRowsDto,
  type ImportEntity,
  type ImportRowDto,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { StorageService } from '../documents/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { CoilsImportAdapter } from './adapters/coils.adapter';
import { CustomersImportAdapter } from './adapters/customers.adapter';
import { FiscalDocumentsImportAdapter } from './adapters/fiscal-documents.adapter';
import {
  isGroupedAdapter,
  type GroupedImportAdapter,
  type ImportAdapter,
  type RowImportAdapter,
  type RowValidation,
} from './adapters/import-adapter.interface';
import { ProductsImportAdapter } from './adapters/products.adapter';
import { parseSpreadsheet } from './parse-spreadsheet';

/**
 * Nombre de archivo listo para ir en una key de R2 y en `file_name` (VARCHAR(200)):
 * solo caracteres seguros, sin separadores de ruta, longitud acotada.
 */
function sanitizeFileName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-150);
  return safe || 'archivo';
}

/**
 * Agrupa filas ya normalizadas por la clave del adaptador (RF-71). Las filas sin clave
 * quedan afuera a propósito: les falta la cabecera con la que se agrupa, así que su propia
 * validación ya las dejó inválidas y no hay grupo al que puedan pertenecer.
 */
function groupRows<T extends { data: Record<string, unknown> }>(
  rows: T[],
  adapter: GroupedImportAdapter,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = adapter.groupKey(row.data);
    if (!key) continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

/** Agrega a cada fila los errores que solo se ven mirando su grupo entero (RF-71). */
async function applyGroupErrors(
  rows: RowValidation[],
  adapter: GroupedImportAdapter,
): Promise<void> {
  for (const bucket of groupRows(rows, adapter).values()) {
    const extra = await adapter.validateGroup(
      bucket.map(({ data, errors }) => ({ data, errors: [...errors] })),
    );
    bucket.forEach((row, i) => {
      row.errors.push(...(extra[i]?.errors ?? []));
      row.warnings = [...(row.warnings ?? []), ...(extra[i]?.warnings ?? [])];
    });
  }
}

/** Cómo se guarda una fila revalidada: dato normalizado, errores, avisos y estado. */
function rowWriteData(validation: RowValidation): Prisma.ImportRowUpdateInput {
  const { data, errors, warnings } = validation;
  return {
    data: data as Prisma.InputJsonObject,
    errors: errors.length > 0 ? errors : Prisma.JsonNull,
    warnings: warnings && warnings.length > 0 ? warnings : Prisma.JsonNull,
    status: errors.length > 0 ? ImportRowStatus.INVALID : ImportRowStatus.VALID,
  };
}

/** Marca como INVALID cualquier fila cuyo `dedupeKey` ya apareció antes en el mismo lote. */
function markIntraBatchDuplicates(rows: RowValidation[], adapter: ImportAdapter): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.errors.length > 0) continue;
    const key = adapter.dedupeKey(row.data);
    if (!key) continue;
    if (seen.has(key)) {
      row.errors.push('Fila duplicada dentro del mismo archivo');
    } else {
      seen.add(key);
    }
  }
}

/**
 * Qué se le muestra al usuario cuando una fila (o un grupo) falla al confirmarse.
 *
 * Un error de dominio nuestro —`BadRequestException`, `ConflictException`— ya está escrito
 * en español y para él: "el comprobante ya tiene cobros" dice qué hacer, "no se pudo crear
 * el registro" no. Cualquier otra cosa se resume a propósito: un error de Prisma filtraría
 * nombres de columnas y restricciones a la pantalla.
 */
function confirmErrorMessage(err: unknown): string {
  if (err instanceof HttpException && err.getStatus() < 500) {
    const response = err.getResponse();
    const message =
      typeof response === 'string' ? response : (response as { message?: unknown })?.message;
    if (typeof message === 'string' && message.length > 0) return message.slice(0, 300);
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return 'Choca con un registro ya creado por otra fila de este mismo archivo';
  }
  return 'No se pudo crear el registro';
}

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

/** Importación masiva genérica (RF-52, base de RF-12/RF-71). Ver `adapters/`. */
@Injectable()
export class ImportsService {
  private readonly logger = new Logger(ImportsService.name);
  private readonly adapters: Record<ImportEntity, ImportAdapter>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    productsAdapter: ProductsImportAdapter,
    customersAdapter: CustomersImportAdapter,
    coilsAdapter: CoilsImportAdapter,
    fiscalDocumentsAdapter: FiscalDocumentsImportAdapter,
  ) {
    const adapters: ImportAdapter[] = [
      productsAdapter,
      customersAdapter,
      coilsAdapter,
      fiscalDocumentsAdapter,
    ];
    this.adapters = Object.fromEntries(adapters.map((a) => [a.entity, a])) as Record<
      ImportEntity,
      ImportAdapter
    >;
  }

  private adapterFor(entity: ImportEntity): ImportAdapter {
    const adapter = this.adapters[entity];
    if (!adapter) throw new BadRequestException(`Entidad de importación no soportada: ${entity}`);
    return adapter;
  }

  async upload(
    actor: RequestUser,
    entity: ImportEntity,
    file: UploadedFile,
  ): Promise<ImportBatchWithRowsDto> {
    const adapter = this.adapterFor(entity);
    const rawRows = parseSpreadsheet(file.buffer);
    const fileName = sanitizeFileName(file.originalname);
    const key = `imports/${entity.toLowerCase()}/${randomUUID()}-${fileName}`;
    await this.storage.putObject(key, file.buffer, file.mimetype);

    // Secuencial (no Promise.all): cada validateRow puede consultar la DB y un archivo
    // de hasta 2000 filas no debe abrir 2000 conexiones a la vez.
    const validated: RowValidation[] = [];
    for (const raw of rawRows) {
      validated.push(await adapter.validateRow(raw));
    }
    markIntraBatchDuplicates(validated, adapter);
    if (isGroupedAdapter(adapter)) await applyGroupErrors(validated, adapter);

    const batchId = await this.prisma.$transaction(
      async (tx) => {
        const batch = await tx.importBatch.create({
          data: {
            entity,
            fileKey: key,
            fileName,
            status: ImportBatchStatus.PARSED,
            createdById: actor.id,
          },
        });
        let rowNumber = 0;
        for (const { data, errors, warnings } of validated) {
          rowNumber += 1;
          await tx.importRow.create({
            data: {
              batchId: batch.id,
              rowNumber,
              data: data as Prisma.InputJsonObject,
              errors: errors.length > 0 ? errors : undefined,
              warnings: warnings && warnings.length > 0 ? warnings : undefined,
              status: errors.length > 0 ? ImportRowStatus.INVALID : ImportRowStatus.VALID,
            },
          });
        }
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'imports.upload',
          entity: 'import_batches',
          entityId: batch.id,
          after: { entity, fileName, rows: rawRows.length },
        });
        return batch.id;
      },
      { timeout: 30_000 },
    );
    return this.findOne(batchId);
  }

  async findOne(id: string): Promise<ImportBatchWithRowsDto> {
    const batch = await this.prisma.importBatch.findUnique({
      where: { id },
      include: { rows: { orderBy: { rowNumber: 'asc' } } },
    });
    if (!batch) throw new NotFoundException('Lote de importación no encontrado');
    return { ...toBatchDto(batch), rows: batch.rows.map(toRowDto) };
  }

  async findAll(): Promise<ImportBatchDto[]> {
    const batches = await this.prisma.importBatch.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return batches.map(toBatchDto);
  }

  async updateRow(
    batchId: string,
    rowId: string,
    edited: Record<string, unknown>,
  ): Promise<ImportRowDto> {
    const batch = await this.prisma.importBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('Lote de importación no encontrado');
    if (batch.status === ImportBatchStatus.CONFIRMED) {
      throw new BadRequestException('El lote ya fue confirmado, no se puede editar');
    }
    const row = await this.prisma.importRow.findFirst({ where: { id: rowId, batchId } });
    if (!row) throw new NotFoundException('Fila no encontrada');

    const adapter = this.adapterFor(batch.entity);
    const validated = await adapter.validateRow(edited);
    if (isGroupedAdapter(adapter)) {
      return this.updateGroupedRow(batchId, row, validated, adapter);
    }
    const updated = await this.prisma.importRow.update({
      where: { id: rowId },
      data: rowWriteData(validated),
    });
    return toRowDto(updated);
  }

  /**
   * Guarda la edición de una fila que pertenece a un grupo (RF-71) y **revalida el grupo
   * entero**, que es lo que un adaptador agrupado obliga a hacer: corregir el precio de una
   * línea cambia si el comprobante cuadra o no, y esa respuesta vive en las otras filas.
   *
   * Revalida dos grupos y no uno cuando la edición toca la cabecera: la fila se muda, y el
   * grupo del que salió también cambió (le falta una línea, o dejó de cuadrar).
   */
  private async updateGroupedRow(
    batchId: string,
    row: ImportRow,
    validated: RowValidation,
    adapter: GroupedImportAdapter,
  ): Promise<ImportRowDto> {
    const previousKey = adapter.groupKey(row.data as Record<string, unknown>);
    const nextKey = adapter.groupKey(validated.data);
    const affectedKeys = new Set([previousKey, nextKey].filter((k): k is string => Boolean(k)));

    const siblings = await this.prisma.importRow.findMany({
      where: { batchId },
      orderBy: { rowNumber: 'asc' },
    });
    // La fila editada entra con su dato nuevo: el resto del grupo se juzga contra lo que
    // quedaría guardado, no contra lo que había antes de esta edición.
    const candidates = siblings.map((r) =>
      r.id === row.id
        ? { row: r, data: validated.data }
        : { row: r, data: r.data as Record<string, unknown> },
    );
    const inScope = candidates.filter(({ data }) => {
      const key = adapter.groupKey(data);
      return key !== undefined && affectedKeys.has(key);
    });
    // La fila editada puede haberse quedado sin clave (borraron el número): igual hay que
    // guardarla, aunque no participe de ningún grupo.
    const revalidated = new Map<string, RowValidation>();
    for (const { row: sibling, data } of inScope) {
      revalidated.set(
        sibling.id,
        sibling.id === row.id ? validated : await adapter.validateRow(data),
      );
    }
    if (!revalidated.has(row.id)) revalidated.set(row.id, validated);

    for (const key of affectedKeys) {
      const bucket = inScope
        .filter(({ data }) => adapter.groupKey(data) === key)
        .map(({ row: sibling }) => revalidated.get(sibling.id))
        .filter((v): v is RowValidation => v !== undefined);
      if (bucket.length === 0) continue;
      const extra = await adapter.validateGroup(
        bucket.map(({ data, errors }) => ({ data, errors: [...errors] })),
      );
      bucket.forEach((v, i) => {
        v.errors.push(...(extra[i]?.errors ?? []));
        v.warnings = [...(v.warnings ?? []), ...(extra[i]?.warnings ?? [])];
      });
    }

    await this.prisma.$transaction(
      [...revalidated.entries()].map(([id, validation]) =>
        this.prisma.importRow.update({ where: { id }, data: rowWriteData(validation) }),
      ),
    );
    const updated = await this.prisma.importRow.findUniqueOrThrow({ where: { id: row.id } });
    return toRowDto(updated);
  }

  /** Confirma solo las filas válidas del lote; las inválidas se quedan sin crear (RF-52). */
  async confirm(actor: RequestUser, batchId: string): Promise<ImportBatchWithRowsDto> {
    const batch = await this.prisma.importBatch.findUnique({
      where: { id: batchId },
      include: { rows: { orderBy: { rowNumber: 'asc' } } },
    });
    if (!batch) throw new NotFoundException('Lote de importación no encontrado');
    if (batch.status === ImportBatchStatus.CONFIRMED) {
      throw new BadRequestException('El lote ya fue confirmado');
    }
    const adapter = this.adapterFor(batch.entity);
    const validRows = batch.rows.filter((r) => r.status === ImportRowStatus.VALID);
    if (validRows.length === 0) {
      throw new BadRequestException('No hay filas válidas para confirmar');
    }

    const confirmedCount = isGroupedAdapter(adapter)
      ? await this.confirmGroups(batchId, batch.rows, adapter, actor.id)
      : await this.confirmRows(batchId, validRows, adapter, actor.id);

    await this.prisma.$transaction(async (tx) => {
      await tx.importBatch.update({
        where: { id: batchId },
        data: { status: ImportBatchStatus.CONFIRMED },
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'imports.confirm',
        entity: 'import_batches',
        entityId: batchId,
        after: { confirmedRows: confirmedCount, skippedRows: batch.rows.length - confirmedCount },
      });
    });
    return this.findOne(batchId);
  }

  /**
   * Confirma grupo por grupo (RF-71): un comprobante entra entero o no entra. Un grupo con
   * alguna línea inválida se saltea completo —la validación de grupo ya marcó a las demás,
   * así que el usuario ve el motivo en cada renglón— y las tres filas de otro comprobante
   * no se caen con él.
   */
  private async confirmGroups(
    batchId: string,
    rows: ImportRow[],
    adapter: GroupedImportAdapter,
    actorId: string,
  ): Promise<number> {
    let confirmedCount = 0;
    for (const bucket of groupRows(
      rows.map((row) => ({ row, data: row.data as Record<string, unknown> })),
      adapter,
    ).values()) {
      if (bucket.some(({ row }) => row.status !== ImportRowStatus.VALID)) continue;
      try {
        await this.prisma.$transaction(
          async (tx) => {
            const entityId = await adapter.createGroup(
              tx,
              bucket.map(({ data }) => data),
              actorId,
            );
            await tx.importRow.updateMany({
              where: { id: { in: bucket.map(({ row }) => row.id) } },
              data: { status: ImportRowStatus.CONFIRMED, createdEntityId: entityId },
            });
          },
          { timeout: 30_000 },
        );
        confirmedCount += bucket.length;
      } catch (err) {
        const first = bucket[0]?.row.rowNumber ?? 0;
        this.logger.error(`Grupo que empieza en la fila ${first} del lote ${batchId} falló`, err);
        await this.prisma.importRow.updateMany({
          where: { id: { in: bucket.map(({ row }) => row.id) } },
          data: { status: ImportRowStatus.INVALID, errors: [confirmErrorMessage(err)] },
        });
      }
    }
    return confirmedCount;
  }

  /** Confirmación fila a fila, el camino de siempre (RF-52). */
  private async confirmRows(
    batchId: string,
    validRows: ImportRow[],
    adapter: RowImportAdapter,
    actorId: string,
  ): Promise<number> {
    // Cada fila se confirma en su propia transacción: una fila que choca contra otra del
    // mismo lote (p. ej. dos filas con el mismo SKU, aún no detectable al validar contra la
    // DB) queda INVALID sin arrastrar al resto de filas válidas a un rollback conjunto.
    let confirmedCount = 0;
    for (const row of validRows) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const entityId = await adapter.createEntity(
            tx,
            row.data as Record<string, unknown>,
            actorId,
          );
          await tx.importRow.update({
            where: { id: row.id },
            data: { status: ImportRowStatus.CONFIRMED, createdEntityId: entityId },
          });
        });
        confirmedCount += 1;
      } catch (err) {
        // El mensaje que ve el usuario es genérico a propósito (no filtra detalles de
        // Prisma), pero el error real tiene que quedar en el log para poder diagnosticar.
        this.logger.error(`Fila ${row.rowNumber} del lote ${batchId} falló al confirmarse`, err);
        await this.prisma.importRow.update({
          where: { id: row.id },
          data: { status: ImportRowStatus.INVALID, errors: [confirmErrorMessage(err)] },
        });
      }
    }
    return confirmedCount;
  }
}

function toBatchDto(b: {
  id: string;
  entity: ImportEntity;
  fileName: string;
  status: ImportBatchStatus;
  createdById: string;
  createdAt: Date;
}): ImportBatchDto {
  return {
    id: b.id,
    entity: b.entity,
    fileName: b.fileName,
    status: b.status,
    createdById: b.createdById,
    createdAt: b.createdAt.toISOString(),
  };
}

function toRowDto(r: ImportRow): ImportRowDto {
  return {
    id: r.id,
    rowNumber: r.rowNumber,
    data: r.data as Record<string, unknown>,
    errors: (r.errors as string[] | null) ?? null,
    warnings: (r.warnings as string[] | null) ?? null,
    status: r.status,
    createdEntityId: r.createdEntityId,
  };
}
