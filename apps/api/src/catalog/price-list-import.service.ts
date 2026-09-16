import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  money,
  saleValueFromPrice,
  toDecimal,
  type ConfirmPriceListImportInput,
  type PriceListImportPreviewDto,
  type PriceListImportResultDto,
  type PriceListImportRowDto,
  type PriceListImportRowStatus,
  type PriceListRevertResultDto,
  type RevertPriceListImportInput,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { claimIdempotencyKey } from '../common/idempotency';
import { getField, parseSpreadsheet, type ImportColumn } from '../imports/parse-spreadsheet';
import { PrismaService } from '../prisma/prisma.service';
import { computePriceFloors, type PriceFloorCandidate } from '../sales/price-floor';
import {
  priceListValueChanged,
  recordPriceListChanges,
  type RecordPriceListChangeInput,
} from './price-list-changes';

/**
 * Carga masiva del precio de lista (D-217/M1c): preview de solo lectura + confirmar
 * todo-o-nada + revertir un lote. Mismo criterio que el importador de cotizaciones (D-152):
 * **sin estado entre preview y confirmar** — la previsualización no guarda nada, y lo que el
 * navegador manda a confirmar es exactamente lo que el usuario revisó.
 */

const COLUMNS = {
  sku: { key: 'sku', header: 'SKU', required: true },
  priceWithIgvPen: { key: 'priceWithIgvPen', header: 'PRECIO CON IGV', required: true },
} satisfies Record<string, ImportColumn>;

/** Tolerancia del plan de corte (D-086): solo la usa el costo de `RAW_MATERIAL`, que un
 *  candidato de catálogo (`PRODUCT`) nunca toma. No hay un valor "correcto" que pasar acá. */
const UNUSED_TOLERANCE_MM = '0.02';

@Injectable()
export class PriceListImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Lee el archivo y arma el diff contra el catálogo. No escribe nada. */
  async preview(buffer: Buffer): Promise<PriceListImportPreviewDto> {
    const raw = parseSpreadsheet(buffer);
    const parsedRows = raw
      .map((r, i) => ({
        rowNumber: i + 2, // la fila 1 es el encabezado
        sku: getField(r, COLUMNS.sku).toUpperCase(),
        priceWithIgvPen: getField(r, COLUMNS.priceWithIgvPen),
      }))
      // Una fila totalmente vacía es el resto de una planilla con más filas de las que
      // tiene datos (Excel lo hace todo el tiempo); no es un error del usuario.
      .filter((r) => r.sku !== '' || r.priceWithIgvPen !== '');
    if (parsedRows.length === 0) {
      throw new BadRequestException('El archivo no tiene filas con datos');
    }

    const skus = [...new Set(parsedRows.map((r) => r.sku).filter((s) => s !== ''))];
    const products =
      skus.length === 0
        ? []
        : await this.prisma.product.findMany({
            where: { sku: { in: skus } },
            select: {
              id: true,
              sku: true,
              name: true,
              unit: true,
              businessLineId: true,
              isActive: true,
              listPricePen: true,
            },
          });
    const bySku = new Map<string, typeof products>();
    for (const p of products) {
      const list = bySku.get(p.sku) ?? [];
      list.push(p);
      bySku.set(p.sku, list);
    }

    const rows: PriceListImportRowDto[] = [];
    const seenSkus = new Map<string, number>();
    const floorCandidates: PriceFloorCandidate[] = [];
    const rowIndexByProductId = new Map<string, number>();

    for (const parsed of parsedRows) {
      const base = {
        rowNumber: parsed.rowNumber,
        sku: parsed.sku,
        priceWithIgvPen: parsed.priceWithIgvPen,
        productId: null,
        productName: null,
        beforeValuePen: null,
        afterValuePen: null,
      };
      if (parsed.sku === '') {
        rows.push({ ...base, status: 'ERROR', message: 'Falta el SKU' });
        continue;
      }
      const firstSeenAt = seenSkus.get(parsed.sku);
      if (firstSeenAt !== undefined) {
        rows.push({
          ...base,
          status: 'ERROR',
          message: `SKU duplicado en el archivo (ya aparece en la fila ${firstSeenAt})`,
        });
        continue;
      }
      seenSkus.set(parsed.sku, parsed.rowNumber);

      const matches = bySku.get(parsed.sku) ?? [];
      if (matches.length === 0) {
        rows.push({ ...base, status: 'ERROR', message: 'El SKU no existe en el catálogo' });
        continue;
      }
      if (matches.length > 1) {
        // D-050: el SKU es único por línea, no global. Un archivo que solo trae el código no
        // puede elegir entre dos productos de líneas distintas por sí mismo.
        rows.push({
          ...base,
          status: 'ERROR',
          message:
            'El SKU existe en más de una línea de negocio: no se puede resolver solo por SKU',
        });
        continue;
      }
      const [product] = matches;
      if (!product) continue; // matches.length === 1 ya lo garantiza; solo para el narrowing
      const withProduct = { ...base, productId: product.id, productName: product.name };
      if (!product.isActive) {
        rows.push({ ...withProduct, status: 'ERROR', message: 'El producto está desactivado' });
        continue;
      }
      if (
        parsed.priceWithIgvPen === '' ||
        !/^\d+(\.\d+)?$/.test(parsed.priceWithIgvPen) ||
        !toDecimal(parsed.priceWithIgvPen).gt(0)
      ) {
        rows.push({
          ...withProduct,
          status: 'ERROR',
          message: 'El precio no es un número válido mayor a cero',
        });
        continue;
      }

      const afterValuePen = money(saleValueFromPrice(parsed.priceWithIgvPen)).toFixed(4);
      const beforeValuePen = product.listPricePen === null ? null : product.listPricePen.toFixed(4);
      const changed = priceListValueChanged(product.listPricePen, afterValuePen);
      const status: PriceListImportRowStatus =
        beforeValuePen === null ? 'NEW' : changed ? 'CHANGED' : 'UNCHANGED';

      const row: PriceListImportRowDto = {
        ...withProduct,
        beforeValuePen,
        afterValuePen,
        status,
        message: null,
      };
      rows.push(row);
      if (status !== 'UNCHANGED') {
        rowIndexByProductId.set(product.id, rows.length - 1);
        floorCandidates.push({
          at: product.id,
          sku: product.sku,
          businessLineId: product.businessLineId,
          basis: { kind: 'UNIT', unitLabel: product.unit },
          unitValuePen: afterValuePen,
          cost: { kind: 'PRODUCT', productId: product.id },
        });
      }
    }

    if (floorCandidates.length > 0) {
      const floors = await this.prisma.$transaction((tx) =>
        computePriceFloors(tx, floorCandidates, UNUSED_TOLERANCE_MM),
      );
      for (const candidate of floorCandidates) {
        const idx = rowIndexByProductId.get(candidate.at);
        if (idx === undefined) continue;
        const row = rows[idx];
        if (!row) continue;
        const floor = floors.get(candidate.at);
        if (floor === undefined) {
          rows[idx] = {
            ...row,
            status: 'WARNING',
            message:
              'Sin costo o sin margen mínimo configurado: no se puede comparar contra el piso',
          };
        } else if (toDecimal(row.afterValuePen ?? '0').lt(toDecimal(floor.minValuePen))) {
          rows[idx] = {
            ...row,
            status: 'WARNING',
            message: `Queda por debajo del piso: mínimo S/ ${floor.minPricePen} por ${floor.priceUnitLabel}`,
          };
        }
      }
    }

    const summary = {
      new: rows.filter((r) => r.status === 'NEW').length,
      changed: rows.filter((r) => r.status === 'CHANGED').length,
      unchanged: rows.filter((r) => r.status === 'UNCHANGED').length,
      warnings: rows.filter((r) => r.status === 'WARNING').length,
      errors: rows.filter((r) => r.status === 'ERROR').length,
    };
    return { rows, summary };
  }

  /**
   * Todo o nada (M1c): confirma exactamente las filas que el navegador revisó. Una fila que
   * dejó de ser un cambio real entre el preview y la confirmación (alguien más lo tocó
   * mientras tanto) se ignora en silencio, no rechaza el lote entero — el resto de la carga
   * sigue siendo válida.
   */
  async confirm(
    actor: RequestUser,
    input: ConfirmPriceListImportInput,
  ): Promise<PriceListImportResultDto> {
    return this.prisma.$transaction(
      async (tx) => {
        const claim = await claimIdempotencyKey(tx, 'pl-import:confirm', input.idempotencyKey);
        if (!claim.claimed) {
          const changed = await tx.productListPriceChange.count({
            where: { batchId: claim.resourceId },
          });
          return { batchId: claim.resourceId, changed };
        }
        const batchId = claim.resourceId;

        const products = await tx.product.findMany({
          where: { id: { in: input.rows.map((r) => r.productId) } },
          select: { id: true, isActive: true, listPricePen: true },
        });
        const productById = new Map(products.map((p) => [p.id, p]));

        const changesToRecord: RecordPriceListChangeInput[] = [];
        for (const row of input.rows) {
          const product = productById.get(row.productId);
          if (!product) throw new NotFoundException(`Producto ${row.productId} no encontrado`);
          if (!product.isActive) {
            throw new BadRequestException(
              `Un producto desactivado no admite precio de lista (${row.productId})`,
            );
          }
          if (!priceListValueChanged(product.listPricePen, row.afterValuePen)) continue;
          await tx.product.update({
            where: { id: row.productId },
            data: { listPricePen: row.afterValuePen },
          });
          changesToRecord.push({
            productId: row.productId,
            beforeValuePen: product.listPricePen,
            afterValuePen: row.afterValuePen,
            changedById: actor.id,
            origin: 'IMPORT',
            batchId,
          });
        }
        await recordPriceListChanges(tx, changesToRecord);
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'catalog.price-list-import.confirm',
          entity: 'products',
          entityId: batchId,
          after: { batchId, rowsSent: input.rows.length, changed: changesToRecord.length },
        });
        return { batchId, changed: changesToRecord.length };
      },
      // Hasta 2000 filas (tope de `parseSpreadsheet`), cada una con su propio UPDATE: es una
      // operación rara de administrador, no un camino caliente — se prioriza que todo o nada
      // quede en una sola transacción sobre la velocidad.
      { timeout: 120_000 },
    );
  }

  /**
   * Deshace un lote entero (M1c). Rechaza si algún producto del lote tuvo un cambio
   * **posterior** — el lote deja de ser "lo último que pasó" con ese SKU, y revertirlo a
   * ciegas pisaría ese cambio más nuevo.
   */
  async revert(
    actor: RequestUser,
    batchId: string,
    input: RevertPriceListImportInput,
  ): Promise<PriceListRevertResultDto> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.productListPriceChange.findMany({
          where: { batchId, origin: 'IMPORT' },
        });
        if (rows.length === 0) throw new NotFoundException('Lote no encontrado');

        const alreadyReverted = await tx.productListPriceChange.findFirst({
          where: { revertsBatchId: batchId },
          select: { id: true },
        });
        if (alreadyReverted) throw new ConflictException('Este lote ya fue revertido');

        // `idempotency_keys.scope` es VARCHAR(60) (D-182): con el UUID del lote atrás, el
        // prefijo tiene que caber en 60 − 36 = 24 caracteres. Verificado con un lote real
        // (P2010 22001 la primera vez que se escribió con el nombre completo del scope).
        const claim = await claimIdempotencyKey(
          tx,
          `pl-import:revert:${batchId}`,
          input.idempotencyKey,
        );
        if (!claim.claimed) {
          const reverted = await tx.productListPriceChange.count({
            where: { revertsBatchId: batchId, batchId: claim.resourceId },
          });
          return { batchId: claim.resourceId, reverted };
        }

        const productIds = [...new Set(rows.map((r) => r.productId))];
        // El cambio más reciente por producto: si no es (exactamente) la fila de este lote,
        // algo más nuevo lo tocó y no se puede revertir a ciegas.
        const latestByProduct = await tx.productListPriceChange.findMany({
          where: { productId: { in: productIds } },
          orderBy: { changedAt: 'desc' },
          distinct: ['productId'],
        });
        const latestIdByProductId = new Map(latestByProduct.map((r) => [r.productId, r.id]));
        const blockedProductIds = rows
          .filter((row) => latestIdByProductId.get(row.productId) !== row.id)
          .map((row) => row.productId);
        if (blockedProductIds.length > 0) {
          const blockedProducts = await tx.product.findMany({
            where: { id: { in: blockedProductIds } },
            select: { sku: true },
          });
          throw new BadRequestException(
            `No se puede revertir: ${blockedProducts.map((p) => p.sku).join(', ')} ` +
              'tuvieron un cambio de precio posterior a este lote',
          );
        }

        const newBatchId = claim.resourceId;
        const changesToRecord: RecordPriceListChangeInput[] = [];
        for (const row of rows) {
          await tx.product.update({
            where: { id: row.productId },
            data: { listPricePen: row.beforeValuePen },
          });
          changesToRecord.push({
            productId: row.productId,
            beforeValuePen: row.afterValuePen,
            afterValuePen: row.beforeValuePen,
            changedById: actor.id,
            origin: 'IMPORT',
            batchId: newBatchId,
            revertsBatchId: batchId,
          });
        }
        await recordPriceListChanges(tx, changesToRecord);
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'catalog.price-list-import.revert',
          entity: 'products',
          entityId: newBatchId,
          after: { revertsBatchId: batchId, reverted: changesToRecord.length },
        });
        return { batchId: newBatchId, reverted: changesToRecord.length };
      },
      { timeout: 120_000 },
    );
  }
}
