import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
import { CustomersImportAdapter } from './adapters/customers.adapter';
import type { ImportAdapter, RowValidation } from './adapters/import-adapter.interface';
import { ProductsImportAdapter } from './adapters/products.adapter';
import { parseSpreadsheet } from './parse-spreadsheet';

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

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

/** Importación masiva genérica (RF-52, base de RF-12/RF-71). Ver `adapters/`. */
@Injectable()
export class ImportsService {
  private readonly adapters: Record<ImportEntity, ImportAdapter>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    productsAdapter: ProductsImportAdapter,
    customersAdapter: CustomersImportAdapter,
  ) {
    const adapters: ImportAdapter[] = [productsAdapter, customersAdapter];
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
    const key = `imports/${entity.toLowerCase()}/${randomUUID()}-${file.originalname}`;
    await this.storage.putObject(key, file.buffer, file.mimetype);

    // Secuencial (no Promise.all): cada validateRow puede consultar la DB y un archivo
    // de hasta 2000 filas no debe abrir 2000 conexiones a la vez.
    const validated: RowValidation[] = [];
    for (const raw of rawRows) {
      validated.push(await adapter.validateRow(raw));
    }
    markIntraBatchDuplicates(validated, adapter);

    const batchId = await this.prisma.$transaction(
      async (tx) => {
        const batch = await tx.importBatch.create({
          data: {
            entity,
            fileKey: key,
            fileName: file.originalname,
            status: ImportBatchStatus.PARSED,
            createdById: actor.id,
          },
        });
        let rowNumber = 0;
        for (const { data, errors } of validated) {
          rowNumber += 1;
          await tx.importRow.create({
            data: {
              batchId: batch.id,
              rowNumber,
              data: data as Prisma.InputJsonObject,
              errors: errors.length > 0 ? errors : undefined,
              status: errors.length > 0 ? ImportRowStatus.INVALID : ImportRowStatus.VALID,
            },
          });
        }
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'imports.upload',
          entity: 'import_batches',
          entityId: batch.id,
          after: { entity, fileName: file.originalname, rows: rawRows.length },
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
    const { data, errors } = await adapter.validateRow(edited);
    const updated = await this.prisma.importRow.update({
      where: { id: rowId },
      data: {
        data: data as Prisma.InputJsonObject,
        errors: errors.length > 0 ? errors : Prisma.JsonNull,
        status: errors.length > 0 ? ImportRowStatus.INVALID : ImportRowStatus.VALID,
      },
    });
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
            actor.id,
          );
          await tx.importRow.update({
            where: { id: row.id },
            data: { status: ImportRowStatus.CONFIRMED, createdEntityId: entityId },
          });
        });
        confirmedCount += 1;
      } catch (err) {
        await this.prisma.importRow.update({
          where: { id: row.id },
          data: {
            status: ImportRowStatus.INVALID,
            errors: [`No se pudo crear: ${err instanceof Error ? err.message : String(err)}`],
          },
        });
      }
    }

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
    status: r.status,
    createdEntityId: r.createdEntityId,
  };
}
