import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type ImportRow } from '@prisma/client';
import {
  CoilImportMode,
  ImportBatchStatus,
  ImportEntity as ImportEntityEnum,
  ImportRowStatus,
  importOptionsSchema,
  paginate,
  toDecimal,
  toSkipTake,
  type CoilImportCheckDto,
  type CoilImportCheckRowDto,
  type ImportOptions,
  type ImportBatchDto,
  type ImportBatchWithRowsDto,
  type ImportEntity,
  type ImportRowDto,
  type PaginatedResult,
  type PaginationQuery,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { StorageService } from '../documents/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { CoilsImportAdapter } from './adapters/coils.adapter';
import { CoilsHistoryImportAdapter } from './adapters/coils-history.adapter';
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
import { SalesHistoryImportAdapter } from './adapters/sales-history.adapter';
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
  // Solo estas dos, y no "cualquier HttpException < 500": las lanza el dominio propio y
  // están escritas en español para el usuario. Un 4xx que viniera de una capa ajena —un
  // cliente HTTP, un pipe— llegaría literal a la pantalla sin que nadie lo haya redactado.
  if (err instanceof BadRequestException || err instanceof ConflictException) {
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
    coilsHistoryAdapter: CoilsHistoryImportAdapter,
    fiscalDocumentsAdapter: FiscalDocumentsImportAdapter,
    salesHistoryAdapter: SalesHistoryImportAdapter,
  ) {
    const adapters: ImportAdapter[] = [
      productsAdapter,
      customersAdapter,
      coilsAdapter,
      coilsHistoryAdapter,
      fiscalDocumentsAdapter,
      salesHistoryAdapter,
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
    options?: ImportOptions,
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
      validated.push(await adapter.validateRow(raw, options));
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
            options: options === undefined ? undefined : (options as Prisma.InputJsonObject),
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
          after: { entity, fileName, rows: rawRows.length, options: options ?? null },
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

  async findAll(query: PaginationQuery): Promise<PaginatedResult<ImportBatchDto>> {
    const { skip, take } = toSkipTake(query);
    const [total, batches] = await Promise.all([
      this.prisma.importBatch.count(),
      this.prisma.importBatch.findMany({ orderBy: { createdAt: 'desc' }, skip, take }),
    ]);
    return paginate(batches.map(toBatchDto), total, query);
  }

  /**
   * Aplica una corrección a **todas las filas de un grupo** y revalida el grupo una sola vez
   * (D-141).
   *
   * Es la puerta del toggle "entregado / pendiente", que es una decisión del comprobante y
   * no de una de sus líneas. Hacerlo con N `PATCH` de fila —uno por línea— tenía dos
   * problemas y ninguno es de rendimiento: entre la primera y la última petición el
   * comprobante quedaba marcado a medias, y la validación de grupo, que corre en cada una,
   * veía ese estado incoherente y marcaba con un error las filas que todavía faltaban
   * tocar. Acá el documento cambia de una pieza.
   *
   * `data` se **mezcla** sobre lo que cada fila ya tiene: cambiar el toggle no borra el SKU
   * que el usuario acababa de corregir en una línea.
   */
  async updateGroup(
    batchId: string,
    groupKey: string,
    data: Record<string, unknown>,
  ): Promise<ImportBatchWithRowsDto> {
    const batch = await this.prisma.importBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('Lote de importación no encontrado');
    if (batch.status === ImportBatchStatus.CONFIRMED) {
      throw new BadRequestException('El lote ya fue confirmado, no se puede editar');
    }
    const adapter = this.adapterFor(batch.entity);
    if (!isGroupedAdapter(adapter)) {
      throw new BadRequestException(
        'Esta importación no agrupa filas: corrige cada fila por separado',
      );
    }
    const options = parseOptions(batch.options);
    const rows = await this.prisma.importRow.findMany({
      where: { batchId },
      orderBy: { rowNumber: 'asc' },
    });
    const target = rows.filter(
      (r) => adapter.groupKey(r.data as Record<string, unknown>) === groupKey,
    );
    if (target.length === 0) throw new NotFoundException('No hay filas con esa clave de grupo');

    const validated = new Map<string, RowValidation>();
    for (const row of target) {
      validated.set(
        row.id,
        await adapter.validateRow({ ...(row.data as Record<string, unknown>), ...data }, options),
      );
    }
    const bucket = target.flatMap((row) => {
      const v = validated.get(row.id);
      return v ? [v] : [];
    });
    const extra = await adapter.validateGroup(
      bucket.map(({ data: rowData, errors }) => ({ data: rowData, errors: [...errors] })),
    );
    bucket.forEach((v, i) => {
      v.errors.push(...(extra[i]?.errors ?? []));
      v.warnings = [...(v.warnings ?? []), ...(extra[i]?.warnings ?? [])];
    });

    await this.prisma.$transaction(
      [...validated.entries()].map(([id, validation]) =>
        this.prisma.importRow.update({ where: { id }, data: rowWriteData(validation) }),
      ),
    );
    return this.findOne(batchId);
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
    const options = parseOptions(batch.options);
    const validated = await adapter.validateRow(edited, options);
    if (isGroupedAdapter(adapter)) {
      return this.updateGroupedRow(batchId, row, validated, adapter, options);
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
    options: ImportOptions | undefined,
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
        sibling.id === row.id ? validated : await adapter.validateRow(data, options),
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

    // El lote se **reclama** antes de crear nada, con la misma condición en el `WHERE`: dos
    // POST simultáneos sobre el mismo lote pasaban los dos la comprobación de arriba, y con
    // el adaptador agrupado eso significa crear el comprobante dos veces —el segundo archiva
    // al primero y deja las filas del primero apuntando a un id que ya no es el vigente—.
    // Es el mismo patrón que el estado `VOIDING` de D-100: reclamar y después trabajar.
    const claimed = await this.prisma.importBatch.updateMany({
      where: { id: batchId, status: ImportBatchStatus.PARSED },
      data: { status: ImportBatchStatus.CONFIRMED },
    });
    if (claimed.count === 0) throw new BadRequestException('El lote ya fue confirmado');

    let confirmedCount = 0;
    try {
      const options = parseOptions(batch.options);
      confirmedCount = isGroupedAdapter(adapter)
        ? await this.confirmGroups(batchId, batch.rows, adapter, actor.id, options)
        : await this.confirmRows(batchId, validRows, adapter, actor.id, options);
    } finally {
      if (confirmedCount === 0) {
        // Nada entró: dejar el lote confirmado lo volvía irreparable —ni se puede editar una
        // fila ni reintentar—, y la única salida era volver a subir el archivo.
        await this.prisma.importBatch.updateMany({
          where: { id: batchId },
          data: { status: ImportBatchStatus.PARSED },
        });
      }
    }

    await this.audit.log({
      actorId: actor.id,
      action: 'imports.confirm',
      entity: 'import_batches',
      entityId: batchId,
      after: { confirmedRows: confirmedCount, skippedRows: batch.rows.length - confirmedCount },
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
    options: ImportOptions | undefined,
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
              options,
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

  /**
   * Reporte de saldo vs objetivo de una carga de bobinas (D-137).
   *
   * Es la contrapartida del modo `REPLAY`: la bobina entró con el peso de compra y el stock
   * que el Excel decía tener quedó **anotado**, no aplicado. Esto compara ese objetivo con
   * lo que el kardex dice hoy, después de que se hayan cargado (o no) los consumos.
   *
   * Sirve en los dos modos y por eso no se restringe a uno: en `ADJUST` tiene que dar cero
   * diferencia el mismo día de la carga, y que no la dé es exactamente lo que hay que ver.
   */
  async coilStockCheck(batchId: string): Promise<CoilImportCheckDto> {
    const batch = await this.prisma.importBatch.findUnique({
      where: { id: batchId },
      include: { rows: { orderBy: { rowNumber: 'asc' } } },
    });
    if (!batch) throw new NotFoundException('Lote de importación no encontrado');
    if (batch.entity !== ImportEntityEnum.COILS_HISTORY) {
      throw new BadRequestException('El reporte de saldo solo aplica a una carga de bobinas');
    }
    const options = parseOptions(batch.options);
    // `flatMap` y no `filter`: además de descartar, estrecha el tipo de `createdEntityId`,
    // así que de acá para abajo no hace falta ninguna aserción.
    const confirmed = batch.rows.flatMap((r) =>
      r.createdEntityId === null ? [] : [{ row: r, coilId: r.createdEntityId }],
    );
    const coilIds = confirmed.map((c) => c.coilId);
    const [coils, balances] = await Promise.all([
      this.prisma.coil.findMany({
        where: { id: { in: coilIds } },
        select: { id: true, code: true },
      }),
      this.prisma.inventoryBalance.findMany({
        where: { itemType: 'COIL', itemId: { in: coilIds } },
        select: { itemId: true, qty: true },
      }),
    ]);
    const codeById = new Map(coils.map((c) => [c.id, c.code]));
    const qtyById = new Map(balances.map((b) => [b.itemId, b.qty.toString()]));

    const rows: CoilImportCheckRowDto[] = confirmed.map(({ row, coilId }) => {
      const data = row.data as Record<string, unknown>;
      const target = toDecimal((data.stockKg as string | undefined) ?? '0');
      const current = toDecimal(qtyById.get(coilId) ?? '0');
      const difference = current.minus(target);
      return {
        rowNumber: row.rowNumber,
        coilId,
        coilCode: codeById.get(coilId) ?? null,
        targetKg: target.toFixed(3),
        currentKg: current.toFixed(3),
        differenceKg: difference.toFixed(3),
        matches: difference.isZero(),
      };
    });
    return {
      batchId,
      mode: options?.mode ?? CoilImportMode.REPLAY,
      rows,
      matching: rows.filter((r) => r.matches).length,
      mismatching: rows.filter((r) => !r.matches).length,
    };
  }

  /** Confirmación fila a fila, el camino de siempre (RF-52). */
  private async confirmRows(
    batchId: string,
    validRows: ImportRow[],
    adapter: RowImportAdapter,
    actorId: string,
    options: ImportOptions | undefined,
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
            options,
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
  options: Prisma.JsonValue;
  createdById: string;
  createdAt: Date;
}): ImportBatchDto {
  return {
    id: b.id,
    entity: b.entity,
    fileName: b.fileName,
    status: b.status,
    options: parseOptions(b.options) ?? null,
    createdById: b.createdById,
    createdAt: b.createdAt.toISOString(),
  };
}

/**
 * Las opciones guardadas del lote, o `undefined` si no tiene (todos los lotes anteriores a
 * D-137). Se parsean con el mismo schema con el que entraron: una columna JSON acepta
 * cualquier forma, y confirmar un lote viejo no puede depender de que alguien la haya
 * escrito bien.
 */
function parseOptions(value: Prisma.JsonValue | null | undefined): ImportOptions | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = importOptionsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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
