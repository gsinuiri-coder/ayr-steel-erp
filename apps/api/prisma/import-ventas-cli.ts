/**
 * CLI de importación de ventas (D-142, enmienda operativa a D-138/D-140/D-141).
 *
 * Usa el **mismo servicio** que el botón «Importar ventas (Excel)» de `/comprobantes`
 * (`ImportsService` + `SalesHistoryImportAdapter`, D-138/D-141) a través de un contexto de
 * aplicación de Nest standalone (`NestFactory.createApplicationContext`) — nunca SQL directo
 * para crear una entidad de negocio. Lo único que este script toca por su cuenta son:
 *
 *   1. Metadatos del propio lote (`import_rows` para excluir un documento con
 *      `decisiones.eliminar` — es un dato del andamiaje de importación, no del dominio).
 *   2. El estampado de `import_batch_id` **después** de que el servicio ya creó cada fila
 *      (una actualización de metadato sobre una entidad que el servicio, no este script,
 *      acaba de crear — nunca decide nada de negocio).
 *
 * Dry-run por defecto (solo lectura, sube el archivo y valida — nunca confirma). `--execute`
 * aplica el archivo de decisiones y confirma de verdad.
 *
 * Uso:
 *   pnpm exec tsx prisma/import-ventas-cli.ts --file <ruta.xlsx> [--out <reporte.json>]
 *   pnpm exec tsx prisma/import-ventas-cli.ts --file <ruta.xlsx> --decisions <decisiones.json> --execute
 *
 * Entorno: mismo patrón que el resto del repo — `DATABASE_URL`/`DIRECT_URL` ya en el proceso
 * (los pone el wrapper `scripts/import-ventas.mjs`, nunca por argv). `ADMIN_EMAIL` decide el
 * actor que audita cada creación (mismo criterio que `prisma/seed.ts`).
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { BusinessLineCode, PrismaClient, ProductSource, Role, type Prisma } from '@prisma/client';
import {
  businessToday,
  fiscalDocumentNumber,
  ImportEntity,
  ImportFulfillment,
  ImportRowStatus,
  toDecimal,
  type ImportRowDto,
} from '@ayr/shared';
import { z } from 'zod';
import { AppModule } from '../src/app.module';
import type { RequestUser } from '../src/auth/auth.types';
import { CatalogService } from '../src/catalog/catalog.service';
import { ImportsService, type UploadedFile } from '../src/imports/imports.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RoofingProductionService } from '../src/production/roofing-production.service';

const MAX_PIECES_PER_OP = 10_000; // MAX_PIECE_QTY (packages/shared/src/schemas/roofing.ts)

// ---------------------------------------------------------------------------
// Argumentos: solo rutas y flags, nunca una credencial (regla dura 5)
// ---------------------------------------------------------------------------

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

const decisionsPath = argValue('--decisions');
const outPath = argValue('--out');
const execute = process.argv.includes('--execute');

// ---------------------------------------------------------------------------
// El archivo de decisiones del dueño
// ---------------------------------------------------------------------------

const skuDecisionSchema = z.union([
  z.object({
    accion: z.literal('crear'),
    linea: z.nativeEnum(BusinessLineCode),
    unidad: z.string().trim().min(1).max(20),
    /** Opcional: si no viene, se usa el nombre del archivo. */
    nombre: z.string().trim().min(2).max(160).optional(),
  }),
  z.object({ accion: z.literal('mapear'), skuExistente: z.string().trim().min(1).max(40) }),
]);

const decisionsSchema = z.object({
  skus: z.record(z.string(), skuDecisionSchema).default({}),
  /** Unidades del archivo que `normalizeUnit` no reconoce, mapeadas al código del catálogo. */
  unidades: z.record(z.string(), z.string().trim().min(1).max(20)).default({}),
  /** Documentos (`F001-00000123`) que el dueño marca como pedido vivo, pendiente de entrega. */
  pendientes: z.array(z.string()).default([]),
  /** Documentos que se excluyen enteros de la importación (no entran ni como entregados). */
  eliminar: z.array(z.string()).default([]),
});
type Decisions = z.infer<typeof decisionsSchema>;

function loadDecisions(path: string): Decisions {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const parsed = decisionsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `El archivo de decisiones no tiene el formato esperado:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Lectura de una fila normalizada (mismas claves que `data`, D-003 en inglés)
// ---------------------------------------------------------------------------

interface RowData {
  documentNumber: string;
  series: string;
  correlative: number | null;
  docType: string | null;
  productCode: string;
  productName: string;
  unit: string;
  sku: string;
  productId: string | null;
  qty: string;
  fulfillment: string;
  madeToMeasure: boolean;
  catalogAvailableQty: string | null;
}

/** Las filas del lote son siempre `Record<string, unknown>` (columna JSON); esto lee un
 * campo que el adaptador siempre guarda como texto, sin arriesgar `"[object Object]"`. */
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function rowData(row: ImportRowDto): RowData {
  const d = row.data;
  return {
    documentNumber: str(d.documentNumber),
    series: str(d.series),
    correlative: typeof d.correlative === 'number' ? d.correlative : null,
    docType: typeof d.docType === 'string' ? d.docType : null,
    productCode: str(d.productCode),
    productName: str(d.productName),
    unit: str(d.unit),
    sku: str(d.sku),
    productId: typeof d.productId === 'string' ? d.productId : null,
    qty: str(d.qty, '0'),
    fulfillment: str(d.fulfillment, ImportFulfillment.DELIVERED),
    madeToMeasure: d.madeToMeasure === true,
    catalogAvailableQty: typeof d.catalogAvailableQty === 'string' ? d.catalogAvailableQty : null,
  };
}

const MISSING_SKU_RE = /^No existe el producto "([^"]+)"/;

// ---------------------------------------------------------------------------
// El reporte de dry-run: gaps que exigen una decisión, y lo que se importaría
// ---------------------------------------------------------------------------

interface DryRunReport {
  totalRows: number;
  totalDocuments: number;
  byDocType: Record<string, number>;
  excludedDocuments: { documentNumber: string; reason: string }[];
  missingSkus: {
    codigo: string;
    nombre: string;
    unidadDetectada: string;
    decision: { accion: 'crear' | 'mapear' | null; linea: BusinessLineCode | null };
  }[];
  unmappedUnits: string[];
  importableDocuments: number;
  invalidDocuments: number;
  catalogDeficits: { productId: string; sku: string; qtyNeeded: string; available: string }[];
}

function buildReport(rows: ImportRowDto[]): DryRunReport {
  const byDoc = new Map<string, ImportRowDto[]>();
  for (const row of rows) {
    const key = rowData(row).documentNumber || `_sin_numero_${row.rowNumber}`;
    const bucket = byDoc.get(key);
    if (bucket) bucket.push(row);
    else byDoc.set(key, [row]);
  }

  const missingSkusByCode = new Map<string, { nombre: string; unidad: string }>();
  const unmappedUnits = new Set<string>();
  const byDocType: Record<string, number> = {};
  const excludedDocuments: DryRunReport['excludedDocuments'] = [];
  let importableDocuments = 0;
  let invalidDocuments = 0;

  for (const [documentNumber, docRows] of byDoc) {
    const head = rowData(docRows[0] ?? ({ data: {} } as ImportRowDto));
    if (head.docType) byDocType[head.docType] = (byDocType[head.docType] ?? 0) + 1;

    const allValid = docRows.every((r) => r.status === ImportRowStatus.VALID);
    if (allValid) importableDocuments += 1;
    else {
      invalidDocuments += 1;
      const firstError = docRows.flatMap((r) => r.errors ?? [])[0] ?? 'motivo no especificado';
      excludedDocuments.push({ documentNumber, reason: firstError });
    }

    for (const row of docRows) {
      const d = rowData(row);
      for (const err of row.errors ?? []) {
        const missing = MISSING_SKU_RE.exec(err);
        if (missing && !missingSkusByCode.has(d.productCode || d.sku)) {
          missingSkusByCode.set(d.productCode || d.sku, { nombre: d.productName, unidad: d.unit });
        }
      }
      const KNOWN_UNITS = new Set(['MTR', 'KGM', 'NIU', 'TNE', 'ZZ']);
      if (d.unit && !KNOWN_UNITS.has(d.unit)) unmappedUnits.add(d.unit);
    }
  }

  const missingSkus = [...missingSkusByCode.entries()].map(([codigo, info]) => ({
    codigo,
    nombre: info.nombre,
    unidadDetectada: info.unidad,
    decision: { accion: null, linea: null },
  }));

  return {
    totalRows: rows.length,
    totalDocuments: byDoc.size,
    byDocType,
    excludedDocuments,
    missingSkus,
    unmappedUnits: [...unmappedUnits],
    importableDocuments,
    invalidDocuments,
    catalogDeficits: [], // se completa más abajo, después de aplicar `pendientes` (necesita decisiones)
  };
}

/**
 * D-142: déficit de catálogo de las líneas que **quedarían pendientes** — la suma de lo
 * pedido contra lo disponible **hoy**, sin tocar nada. Es la base de la OP a stock
 * consolidada: `SIN ligar OP a reserva` (D-140 intacto), así que se puede calcular en
 * dry-run exactamente igual que en `--execute`.
 */
function computeCatalogDeficits(
  rows: ImportRowDto[],
  pendientes: Set<string>,
): { productId: string; qty: Prisma.Decimal; available: Prisma.Decimal }[] {
  const byProduct = new Map<string, { qty: Prisma.Decimal; available: Prisma.Decimal }>();
  for (const row of rows) {
    const d = rowData(row);
    if (!pendientes.has(d.documentNumber)) continue;
    if (d.madeToMeasure || !d.productId || d.catalogAvailableQty === null) continue;
    const bucket = byProduct.get(d.productId) ?? {
      qty: toDecimal('0'),
      available: toDecimal(d.catalogAvailableQty),
    };
    bucket.qty = bucket.qty.plus(toDecimal(d.qty));
    byProduct.set(d.productId, bucket);
  }
  return [...byProduct.entries()]
    .map(([productId, v]) => ({ productId, qty: v.qty, available: v.available }))
    .filter((v) => v.qty.gt(v.available));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const filePath = argValue('--file');
  if (!filePath) {
    throw new Error(
      'Uso: import-ventas-cli.ts --file <ruta.xlsx> [--decisions <json>] [--execute]',
    );
  }

  const prisma = new PrismaClient();

  // GUARDA DE ESQUEMA: contra una rama con la migración de D-142 sin desplegar, abortar con
  // un mensaje claro en vez del error crudo de Postgres a mitad de la subida del archivo.
  try {
    await prisma.$queryRaw`SELECT "import_batch_id" FROM "sales_orders" LIMIT 0`;
  } catch {
    await prisma.$disconnect();
    throw new Error(
      'Esta rama no tiene la migración `20260907190000_fase7finalb_import_batch_id_ventas` ' +
        'aplicada (`import_batch_id`). Corré `pnpm db:migrate` / `pnpm db:deploy` primero.',
    );
  }

  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!adminEmail) throw new Error('Falta ADMIN_EMAIL en el entorno');
  const adminUser = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!adminUser || !adminUser.active || adminUser.role !== Role.ADMINISTRADOR) {
    throw new Error(`${adminEmail} no es un ADMINISTRADOR activo en esta rama`);
  }
  const actor: RequestUser = {
    id: adminUser.id,
    email: adminUser.email,
    name: adminUser.name,
    role: adminUser.role,
    mustChangePassword: adminUser.mustChangePassword,
    sessionId: `cli-import-ventas-${randomUUID()}`,
  };
  await prisma.$disconnect();

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const imports = app.get(ImportsService);
    const catalog = app.get(CatalogService);
    const roofing = app.get(RoofingProductionService);
    const db = app.get(PrismaService);

    const buffer = readFileSync(resolve(filePath));
    const file: UploadedFile = {
      originalname: filePath.split(/[\\/]/).pop() ?? 'ventas.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer,
    };

    console.warn(`Subiendo ${file.originalname}…`);
    let batch = await imports.upload(actor, ImportEntity.SALES_HISTORY, file);
    console.warn(`Lote ${batch.id}: ${batch.rows.length} filas.\n`);

    const decisions = decisionsPath ? loadDecisions(decisionsPath) : null;
    const pendientesSet = new Set(decisions?.pendientes ?? []);

    if (!execute) {
      const report = buildReport(batch.rows);
      report.catalogDeficits = computeCatalogDeficits(batch.rows, pendientesSet).map((d) => ({
        productId: d.productId,
        sku: '',
        qtyNeeded: d.qty.toFixed(3),
        available: d.available.toFixed(3),
      }));
      // Completar el SKU de cada déficit (una consulta de lectura, no cambia nada).
      if (report.catalogDeficits.length > 0) {
        const products = await db.product.findMany({
          where: { id: { in: report.catalogDeficits.map((d) => d.productId) } },
          select: { id: true, sku: true },
        });
        const skuById = new Map(products.map((p) => [p.id, p.sku]));
        for (const d of report.catalogDeficits) d.sku = skuById.get(d.productId) ?? d.productId;
      }
      printDryRun(report);
      const out = resolve(outPath ?? decisionScaffoldPath(filePath));
      writeFileSync(out, JSON.stringify(scaffoldDecisions(report), null, 2), 'utf8');
      console.warn(`\nEsqueleto de decisiones escrito en ${out}`);
      return;
    }

    // ---------------------------------------------------------------------
    // --execute
    // ---------------------------------------------------------------------
    if (!decisions) throw new Error('--execute necesita --decisions <archivo.json>');

    const report = buildReport(batch.rows);
    const missingCodes = new Set(report.missingSkus.map((s) => s.codigo));
    const uncoveredSkus = [...missingCodes].filter((c) => !(c in decisions.skus));
    const uncoveredUnits = report.unmappedUnits.filter((u) => !(u in decisions.unidades));
    if (uncoveredSkus.length > 0 || uncoveredUnits.length > 0) {
      console.error('El archivo de decisiones no cubre todos los huecos del dry-run:');
      for (const c of uncoveredSkus) console.error(`  - falta decidir el SKU ${c}`);
      for (const u of uncoveredUnits) console.error(`  - falta mapear la unidad "${u}"`);
      process.exitCode = 1;
      return;
    }

    // 1) SKUs: crear los que hagan falta (catálogo real, con auditoría propia) y armar el
    //    mapa código → sku final.
    //
    // Un SKU que falla al crearse (típicamente Metallic Roofing/Drywall sin espesor/ancho/
    // acabado, que `"crear"` con los datos mínimos del archivo no puede completar) **no
    // aborta la corrida entera** — solo se queda sin entrada en `skuMap`, así que sus filas
    // conservan el error original ("No existe el producto...") de la subida inicial y
    // `confirmGroups` salta el documento que las contiene, exactamente igual que un
    // documento con cualquier otro error de validación. El resto del lote —incluidos otros
    // documentos que comparten ese mismo SKU pero no dependían de otras filas rotas— sigue
    // su curso. Es la misma independencia por documento que ya tiene el resto del importador.
    const skuMap = new Map<string, string>();
    const createdProductIds: string[] = [];
    const failedSkus: string[] = [];
    for (const [code, decision] of Object.entries(decisions.skus)) {
      if (decision.accion === 'mapear') {
        skuMap.set(code, decision.skuExistente.toUpperCase());
        continue;
      }
      const missing = report.missingSkus.find((s) => s.codigo === code);
      const line = await db.businessLine.findUnique({ where: { code: decision.linea } });
      if (!line) throw new Error(`Línea de negocio ${decision.linea} no existe`);
      try {
        const product = await catalog.create(actor, {
          businessLineId: line.id,
          sku: code,
          name: (decision.nombre ?? missing?.nombre ?? code).slice(0, 160),
          unit: decision.unidad,
          source:
            decision.linea === BusinessLineCode.TRADING ||
            decision.linea === BusinessLineCode.ROOFING
              ? ProductSource.PURCHASED
              : ProductSource.MANUFACTURED,
          listPricePen: null,
          colorId: null,
          finishId: null,
          thicknessMm: null,
          widthMm: null,
          lengthMm: null,
          pieceWeightKg: null,
          roofingKind: null,
        });
        createdProductIds.push(product.id);
        skuMap.set(code, product.sku);
      } catch (err) {
        failedSkus.push(code);
        console.error(
          `No se pudo crear el SKU ${code} (línea ${decision.linea}): ` +
            `${err instanceof Error ? err.message : String(err)}\n` +
            'Esa línea probablemente exige campos estructurados (espesor, ancho, acabado): ' +
            'creá el producto a mano en el catálogo y usá "mapear" en vez de "crear". Los ' +
            'documentos que dependen únicamente de este SKU van a quedar excluidos.',
        );
      }
    }
    if (createdProductIds.length > 0) {
      await db.product.updateMany({
        where: { id: { in: createdProductIds } },
        data: { importBatchId: batch.id },
      });
    }

    // 2) Aplicar correcciones de SKU/unidad fila por fila, y el toggle de documento —
    //    siempre por el servicio (`updateRow`/`updateGroup`), nunca tocando `data` a mano.
    for (const row of batch.rows) {
      const d = rowData(row);
      const correctedSku = skuMap.get(d.productCode) ?? skuMap.get(d.sku);
      const correctedUnit = decisions.unidades[d.unit];
      if (correctedSku || correctedUnit) {
        await imports.updateRow(batch.id, row.id, {
          ...row.data,
          ...(correctedSku ? { sku: correctedSku } : {}),
          ...(correctedUnit ? { unit: correctedUnit } : {}),
        });
      }
    }
    // `decisions.pendientes` trae el número tal como lo muestra el reporte de dry-run
    // ("FFA1-1349", el texto crudo de "SERIE - NÚMERO" en el archivo) — pero
    // `ImportsService.updateGroup` compara contra la clave canónica del adaptador
    // (`fiscalDocumentNumber`, con el correlativo relleno a 8 dígitos: "FFA1-00001349").
    // Sin esta traducción, la primera entrada de `pendientes` que no coincidiera al pie de
    // la letra tiraba un 404 sin capturar y abortaba la corrida entera después de ya haber
    // intentado los SKUs — encontrado en producción, sesión 7-final-C.
    const groupKeyByDocumentNumber = new Map(
      batch.rows.map((row) => {
        const d = rowData(row);
        return [d.documentNumber, fiscalDocumentNumber(d.series, d.correlative ?? 0)] as const;
      }),
    );
    const unmatchedPendientes: string[] = [];
    for (const documentNumber of decisions.pendientes) {
      const groupKey = groupKeyByDocumentNumber.get(documentNumber) ?? documentNumber;
      try {
        await imports.updateGroup(batch.id, groupKey, { fulfillment: ImportFulfillment.PENDING });
      } catch (err) {
        unmatchedPendientes.push(documentNumber);
        console.error(
          `No se pudo marcar pendiente "${documentNumber}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (unmatchedPendientes.length > 0) {
      console.error(
        `Documentos de "pendientes" que no coinciden con ninguna fila del lote: ${unmatchedPendientes.join(', ')}`,
      );
    }

    // 3) `eliminar`: excluir el documento entero. Es metadato del propio andamiaje de
    //    importación (`import_rows`), no una entidad de negocio — nunca se llega a confirmar.
    if (decisions.eliminar.length > 0) {
      const refreshed = await imports.findOne(batch.id);
      const excludedIds = refreshed.rows
        .filter((r) => decisions.eliminar.includes(rowData(r).documentNumber))
        .map((r) => r.id);
      if (excludedIds.length > 0) {
        await db.importRow.updateMany({
          where: { id: { in: excludedIds } },
          data: {
            status: ImportRowStatus.INVALID,
            errors: ['Excluido por decisión del dueño (decisiones.eliminar)'],
          },
        });
      }
    }

    // Snapshot de clientes **antes** de confirmar: la única forma honesta de saber después
    // cuáles auto-creó este lote y cuáles ya existían y este lote solo referenció.
    batch = await imports.findOne(batch.id);
    const customerPairs = batch.rows
      .filter((r) => r.status === ImportRowStatus.VALID)
      .flatMap((r) => {
        const docType = r.data.customerDocType;
        const docNumber = r.data.customerDocNumber;
        return typeof docType === 'string' && typeof docNumber === 'string'
          ? [{ docType, docNumber }]
          : [];
      });
    const existingCustomers = await db.customer.findMany({
      where: {
        OR: customerPairs.map((p) => ({ docType: p.docType as never, docNumber: p.docNumber })),
      },
      select: { id: true },
    });
    const existingCustomerIds = new Set(existingCustomers.map((c) => c.id));

    const deficitsBeforeConfirm = computeCatalogDeficits(batch.rows, pendientesSet);

    console.warn(`Confirmando lote ${batch.id}…`);
    const confirmed = await imports.confirm(actor, batch.id);
    const confirmedDocIds = confirmed.rows.flatMap((r) =>
      r.status === ImportRowStatus.CONFIRMED && r.createdEntityId ? [r.createdEntityId] : [],
    );

    // 4) Estampar `import_batch_id` en cascada, desde el documento hacia abajo — todo lo que
    //    cuelga de un documento de este lote es, por construcción (D-141: 1:1), de este lote.
    const orders = await db.salesOrder.findMany({
      where: { fiscalDocuments: { some: { id: { in: confirmedDocIds } } } },
      select: { id: true, customerId: true },
    });
    const orderIds = orders.map((o) => o.id);
    await db.fiscalDocument.updateMany({
      where: { id: { in: confirmedDocIds } },
      data: { importBatchId: batch.id },
    });
    if (orderIds.length > 0) {
      await db.salesOrder.updateMany({
        where: { id: { in: orderIds } },
        data: { importBatchId: batch.id },
      });
      await db.reservation.updateMany({
        where: { salesOrderId: { in: orderIds } },
        data: { importBatchId: batch.id },
      });
      const reservations = await db.reservation.findMany({
        where: { salesOrderId: { in: orderIds } },
        select: { id: true },
      });
      await db.productionOrder.updateMany({
        where: { reservationId: { in: reservations.map((r) => r.id) } },
        data: { importBatchId: batch.id },
      });
    }
    const newCustomerIds = [...new Set(orders.map((o) => o.customerId))].filter(
      (id) => !existingCustomerIds.has(id),
    );
    if (newCustomerIds.length > 0) {
      await db.customer.updateMany({
        where: { id: { in: newCustomerIds } },
        data: { importBatchId: batch.id },
      });
    }

    // 5) OP a stock consolidada por el déficit de catálogo (D-142, enmienda a D-140). Nace
    //    de la demanda declarada `pendientes`, no de una reserva — no desbloquea ningún
    //    pedido de esta corrida, solo adelanta la producción que hace falta para la próxima.
    const stockOrders: string[] = [];
    for (const deficit of deficitsBeforeConfirm) {
      const targetPieces = Math.min(
        Math.ceil(deficit.qty.minus(deficit.available).toNumber()),
        MAX_PIECES_PER_OP,
      );
      if (targetPieces <= 0) continue;
      const product = await db.product.findUnique({ where: { id: deficit.productId } });
      try {
        const order = await roofing.create(actor, {
          productId: deficit.productId,
          targetPieces,
          operationDate: businessToday(),
          notes:
            `Déficit de importación (lote ${batch.id}): ${product?.sku ?? deficit.productId}`.slice(
              0,
              500,
            ),
        });
        await db.productionOrder.update({
          where: { id: order.id },
          data: { importBatchId: batch.id },
        });
        stockOrders.push(order.code);
      } catch (err) {
        console.error(
          `No se pudo crear la OP a stock consolidada para ${product?.sku ?? deficit.productId}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    console.warn('\nListo.');
    console.warn(`  Lote: ${batch.id}`);
    console.warn(`  Documentos confirmados: ${confirmedDocIds.length}`);
    console.warn(`  Pedidos: ${orderIds.length}`);
    console.warn(`  Clientes auto-creados: ${newCustomerIds.length}`);
    console.warn(`  SKUs creados: ${createdProductIds.length}`);
    if (failedSkus.length > 0) {
      console.warn(
        `  SKUs que NO se pudieron crear (documentos que dependen de ellos, excluidos): ${failedSkus.join(', ')}`,
      );
    }
    console.warn(`  OP a stock (déficit consolidado): ${stockOrders.join(', ') || 'ninguna'}`);
    console.warn(
      `  Excluidos: ${confirmed.rows.filter((r) => r.status === ImportRowStatus.INVALID).length} fila(s)`,
    );
    console.warn(`\nReversa: pnpm exec tsx prisma/purge-imported-sales.ts --batch=${batch.id}`);
  } finally {
    await app.close();
  }
}

function decisionScaffoldPath(source: string): string {
  return source.replace(/\.[^.]+$/, '') + '.decisiones.json';
}

/**
 * El esqueleto no es un `Decisions` válido todavía (`linea: null`, a propósito: el dueño la
 * completa) — por eso el tipo de retorno es deliberadamente más laxo que `Decisions`.
 */
function scaffoldDecisions(report: DryRunReport): Record<string, unknown> {
  return {
    _instrucciones:
      'Para cada SKU: completá "linea" (DRYWALL, METALLIC_ROOFING, ROOFING, TRADING o ' +
      'SERVICES) si vas a "crear" el producto. Metallic Roofing y Drywall exigen además ' +
      'espesor/ancho/acabado/largo (o peso de pieza) — el CLI no los adivina del nombre del ' +
      'archivo. Si el SKU es una cobertura o bobina (nombres "COBERTURA…"/"BOBINA…") lo más ' +
      'simple suele ser crearlo primero a mano en el catálogo y acá poner ' +
      '{"accion":"mapear","skuExistente":"<el SKU que le pusiste"}. Completá también ' +
      '"pendientes" (documentos que todavía debés entregar) y, si hace falta, "eliminar".',
    skus: Object.fromEntries(
      report.missingSkus.map((s) => [
        s.codigo,
        { accion: 'crear', linea: null, unidad: s.unidadDetectada, nombre: s.nombre },
      ]),
    ),
    unidades: Object.fromEntries(report.unmappedUnits.map((u) => [u, ''])),
    pendientes: [],
    eliminar: [],
  };
}

function printDryRun(report: DryRunReport): void {
  console.warn(`Documentos: ${report.totalDocuments} (${report.totalRows} filas)`);
  console.warn(`  por tipo: ${JSON.stringify(report.byDocType)}`);
  console.warn(`  importables tal cual: ${report.importableDocuments}`);
  console.warn(`  excluidos: ${report.invalidDocuments}`);
  for (const e of report.excludedDocuments) console.warn(`    - ${e.documentNumber}: ${e.reason}`);
  console.warn(`\nSKUs faltantes: ${report.missingSkus.length}`);
  for (const s of report.missingSkus) {
    console.warn(`  - ${s.codigo} (${s.unidadDetectada}) — ${s.nombre}`);
  }
  console.warn(`\nUnidades sin mapear: ${report.unmappedUnits.join(', ') || 'ninguna'}`);
  if (report.catalogDeficits.length > 0) {
    console.warn('\nDéficit de catálogo si se marcan todos los `pendientes` indicados:');
    for (const d of report.catalogDeficits) {
      console.warn(`  - ${d.sku}: necesita ${d.qtyNeeded}, hay ${d.available}`);
    }
  }
}

main().catch((err: unknown) => {
  // Sin `process.exit()`: en Windows, con stdout/stderr redirigidos (una tubería, un
  // archivo), un `exit()` inmediato puede cortar la escritura del propio error antes de que
  // termine de volcarse — el proceso simplemente desaparecía sin decir por qué. Dejar que
  // Node cierre solo, una vez que el event loop drena, es lo que garantiza que este mensaje
  // se vea siempre.
  console.error(err);
  process.exitCode = 1;
});
