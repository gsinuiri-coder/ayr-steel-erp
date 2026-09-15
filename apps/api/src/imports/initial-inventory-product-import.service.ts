import { BadRequestException, Injectable } from '@nestjs/common';
import { BusinessLineCode, Currency } from '@prisma/client';
import { CURRENCIES, decimalStringSchema, MAX_VALUE, toDecimal, toFixedString } from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { OperationDateService } from '../common/operation-date.service';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  getField,
  parseCalendarDate,
  parseSpreadsheet,
  type ImportColumn,
} from './parse-spreadsheet';
import type { RunInput } from './initial-inventory-import.service';

/**
 * F8-S6a2: extensión de D-206 (carga de inventario inicial) a productos por unidades —
 * cobertura UPVC y reventa, las dos líneas donde D-091 ya modela el producto como
 * compra-venta pura. Misma excepción a D-150, mismas cuatro condiciones que la carga de
 * bobinas: hereda invariantes (`InventoryService.record`, no SQL directo), es de arranque
 * (sin controller, nunca actualiza un producto con historial), no es una compra (a
 * diferencia de la bobina, `InventoryMovement` no tiene proveedor — el `refType: 'IMPORT'`
 * ya deja el rastro sin necesitar el proveedor `isSystem` de la carga de bobinas), y el
 * alcance no se generaliza a otro importador de productos.
 *
 * **Solo líneas compra-reventa.** El producto terminado propio (Drywall, Metallic Roofing)
 * no entra por acá: lo decide `businessLine.code` (UPVC = `ROOFING`, Reventa = `TRADING`) más
 * `source === PURCHASED`, nunca el SKU ni su texto — la misma lección de D-131 aplicada a una
 * pregunta nueva: esto no es "¿tiene largo?" ni "¿es a medida?", es "¿este producto se compra
 * o se fabrica?", y la responde `ProductSource` (el mismo campo que ya usa
 * `BomsService` para lo contrario, RF-59).
 */
@Injectable()
export class InitialInventoryProductImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
    private readonly operationDateService: OperationDateService,
  ) {}

  async run(actor: RequestUser, input: RunInput): Promise<ProductInitialInventoryReport> {
    const raw = parseSpreadsheet(input.buffer);
    if (raw.length === 0) throw new BadRequestException('El archivo no tiene ninguna fila');
    assertColumns(raw[0] ?? {});

    // D-124: una sola fecha de operación para todo el lote, igual que la carga de bobinas.
    const operationDate = this.operationDateService.resolve(actor, input.operationDate);

    const skuCodes = [...new Set(raw.map((r) => field(r, 'sku').toUpperCase()))].filter(
      (v) => v !== '',
    );
    const products = skuCodes.length
      ? await this.prisma.product.findMany({
          where: { OR: skuCodes.map((code) => ({ sku: { equals: code, mode: 'insensitive' } })) },
          select: {
            id: true,
            sku: true,
            unit: true,
            isActive: true,
            source: true,
            businessLineId: true,
            businessLine: { select: { code: true } },
          },
        })
      : [];
    const byUpperSku = new Map<string, typeof products>();
    for (const p of products) {
      const key = p.sku.toUpperCase();
      byUpperSku.set(key, [...(byUpperSku.get(key) ?? []), p]);
    }

    const productIds = products.map((p) => p.id);
    const existingMovements = productIds.length
      ? await this.prisma.inventoryMovement.findMany({
          where: { itemType: 'PRODUCT', itemId: { in: productIds } },
          select: { itemId: true },
          distinct: ['itemId'],
        })
      : [];
    const hasKardex = new Set(existingMovements.map((m) => m.itemId));

    const rows = raw.map((r, i) => parseRow(r, i + 1, byUpperSku, hasKardex));
    const ok = rows.every((r) => r.errors.length === 0);

    if (!ok || !input.execute) {
      return {
        totalRows: rows.length,
        ok,
        executed: false,
        rows: rows.map((r) => toRowSummary(r)),
      };
    }

    const batchId = input.batchId;
    const created = await this.prisma.$transaction(
      async (tx) => {
        const rowsCreated: { rowNumber: number; sku: string }[] = [];
        for (const row of rows) {
          // `ok` ya confirmó que todas las filas tienen `parsed`; el chequeo es para el tipo.
          if (!row.parsed) continue;
          // `record` devuelve `null` para una línea `NOOP` (§2.2) sin escribir nada — hoy
          // inalcanzable (ROOFING/TRADING nacen `STOCK` y no hay ruta que las cambie), pero a
          // diferencia de `CoilsService.create` (nunca null) esta fila llama a `record` directo,
          // así que se respeta el contrato en vez de asumir que siempre escribió.
          const movement = await this.inventory.record(tx, {
            businessLineId: row.parsed.businessLineId,
            itemType: 'PRODUCT',
            itemId: row.parsed.productId,
            type: 'IN',
            qty: row.parsed.units,
            unit: row.parsed.unit,
            // D-042: el kardex se lleva siempre en soles, igual que la recepción de una
            // compra de producto terminado (`PurchasesService.receive`, caso FINISHED_GOOD).
            unitCost: toFixedString(
              toDecimal(row.parsed.unitCostPerUnit).times(row.parsed.exchangeRate),
              'MONEY',
            ),
            refType: 'IMPORT',
            refId: batchId,
            actorId: actor.id,
            operationDate,
            notes: row.parsed.notes,
          });
          if (movement) rowsCreated.push({ rowNumber: row.rowNumber, sku: row.parsed.sku });
        }
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'imports.initial-inventory-products',
          entity: 'products',
          entityId: null,
          after: { batchId, fileName: input.fileName, count: rowsCreated.length },
        });
        return rowsCreated;
      },
      // Una carga inicial real puede traer cientos de líneas; el timeout de una compra
      // (30 s) alcanza para unas pocas decenas de altas secuenciales.
      { timeout: 300_000, maxWait: 20_000 },
    );

    const createdByRow = new Set(created.map((c) => c.rowNumber));
    return {
      totalRows: rows.length,
      ok: true,
      executed: true,
      rows: rows.map((r) => toRowSummary(r, createdByRow.has(r.rowNumber))),
    };
  }
}

// ---------------------------------------------------------------------------
// Contrato de salida
// ---------------------------------------------------------------------------

export interface ProductInitialInventoryRowSummary {
  rowNumber: number;
  sku: string;
  ok: boolean;
  errors: string[];
  created?: boolean;
}

export interface ProductInitialInventoryReport {
  totalRows: number;
  ok: boolean;
  executed: boolean;
  rows: ProductInitialInventoryRowSummary[];
}

// ---------------------------------------------------------------------------
// Columnas del archivo
// ---------------------------------------------------------------------------

const COLUMN_DEFS = {
  sku: 'SKU PRODUCTO',
  units: 'UNIDADES',
  unitCostPerUnit: 'COSTO UNITARIO (SIN IGV)',
  currency: 'MONEDA',
  exchangeRate: 'TIPO DE CAMBIO',
  referenceInvoice: 'FACTURA DE REFERENCIA',
  referenceDate: 'FECHA DE REFERENCIA',
} as const;

type ColumnKey = keyof typeof COLUMN_DEFS;

const REQUIRED_COLUMNS: readonly string[] = [
  COLUMN_DEFS.sku,
  COLUMN_DEFS.units,
  COLUMN_DEFS.unitCostPerUnit,
  COLUMN_DEFS.currency,
];

const COLUMNS: Record<ColumnKey, ImportColumn> = Object.fromEntries(
  Object.entries(COLUMN_DEFS).map(([key, header]) => [
    key,
    { key, header, required: REQUIRED_COLUMNS.includes(header) },
  ]),
) as Record<ColumnKey, ImportColumn>;

function field(raw: Record<string, unknown>, key: ColumnKey): string {
  return getField(raw, COLUMNS[key]);
}

function assertColumns(first: Record<string, unknown>): void {
  const missing = REQUIRED_COLUMNS.filter(
    (header) => getField(first, { key: header, header, required: true }) === '',
  );
  if (missing.length > 0) {
    throw new BadRequestException(
      `El archivo no tiene ${missing.length === 1 ? 'la columna' : 'las columnas'} ${missing.join(', ')}.`,
    );
  }
}

/** Líneas de negocio compra-reventa a las que alcanza esta herramienta (D-206, extensión). */
const ALLOWED_LINE_CODES: readonly BusinessLineCode[] = [
  BusinessLineCode.ROOFING,
  BusinessLineCode.TRADING,
];

// ---------------------------------------------------------------------------
// Fila a fila
// ---------------------------------------------------------------------------

interface ProductRow {
  id: string;
  sku: string;
  unit: string;
  isActive: boolean;
  source: 'MANUFACTURED' | 'PURCHASED';
  businessLineId: string;
  businessLine: { code: BusinessLineCode };
}

interface ParsedRow {
  sku: string;
  productId: string;
  businessLineId: string;
  unit: string;
  units: string;
  unitCostPerUnit: string;
  currency: Currency;
  exchangeRate: string;
  notes: string;
}

interface RowResult {
  rowNumber: number;
  sku: string;
  errors: string[];
  parsed?: ParsedRow;
}

function toRowSummary(row: RowResult, created?: boolean): ProductInitialInventoryRowSummary {
  return {
    rowNumber: row.rowNumber,
    sku: row.sku,
    ok: row.errors.length === 0,
    errors: row.errors,
    ...(created ? { created } : {}),
  };
}

function decimalField(
  raw: Record<string, unknown>,
  key: ColumnKey,
  scale: 'KG' | 'MONEY' | 'RATE',
  max: number,
  errors: string[],
): string | null {
  const value = field(raw, key);
  const result = decimalStringSchema(scale, { positive: true, max }).safeParse(value);
  if (!result.success) {
    errors.push(`${COLUMN_DEFS[key]}: ${result.error.issues[0]?.message ?? 'valor inválido'}`);
    return null;
  }
  return result.data;
}

function parseRow(
  raw: Record<string, unknown>,
  rowNumber: number,
  byUpperSku: ReadonlyMap<string, ProductRow[]>,
  hasKardex: ReadonlySet<string>,
): RowResult {
  const errors: string[] = [];
  const skuRaw = field(raw, 'sku');

  let product: ProductRow | null = null;
  if (skuRaw === '') {
    errors.push(`${COLUMN_DEFS.sku}: es obligatoria.`);
  } else {
    const matches = byUpperSku.get(skuRaw.toUpperCase()) ?? [];
    if (matches.length === 0) {
      errors.push(
        `${COLUMN_DEFS.sku} "${skuRaw}": no existe en el catálogo. Créalo primero — esta ` +
          'herramienta no crea productos.',
      );
    } else if (matches.length > 1) {
      errors.push(
        `${COLUMN_DEFS.sku} "${skuRaw}": el código coincide con más de un producto (en ` +
          'distintas líneas de negocio). Usa un SKU sin ambigüedad.',
      );
    } else {
      const [match] = matches;
      product = match ?? null;
      if (product) {
        if (!product.isActive) {
          errors.push(`${COLUMN_DEFS.sku} "${product.sku}": el producto está desactivado.`);
        } else if (!ALLOWED_LINE_CODES.includes(product.businessLine.code)) {
          errors.push(
            `${COLUMN_DEFS.sku} "${product.sku}": no es de una línea compra-reventa (UPVC o ` +
              'Reventa) — fuera de alcance de esta herramienta.',
          );
        } else if (product.source !== 'PURCHASED') {
          errors.push(
            `${COLUMN_DEFS.sku} "${product.sku}": es un producto fabricado (source ` +
              'MANUFACTURED), no de compra-reventa — fuera de alcance de esta herramienta.',
          );
        } else if (hasKardex.has(product.id)) {
          errors.push(
            `${COLUMN_DEFS.sku} "${product.sku}": ya tiene movimientos de kardex — esta ` +
              'herramienta es solo de arranque y nunca actualiza stock existente.',
          );
        }
      }
    }
  }

  const units = decimalField(raw, 'units', 'KG', MAX_VALUE.KG, errors);
  const unitCostPerUnit = decimalField(raw, 'unitCostPerUnit', 'MONEY', MAX_VALUE.MONEY, errors);

  const currencyRaw = field(raw, 'currency').toUpperCase();
  const currency = (CURRENCIES as readonly string[]).includes(currencyRaw)
    ? (currencyRaw as Currency)
    : null;
  if (currency === null) {
    errors.push(
      `${COLUMN_DEFS.currency} "${field(raw, 'currency')}": tiene que ser ${CURRENCIES.join(' o ')}.`,
    );
  }

  let exchangeRate: string | null = null;
  const exchangeRateRaw = field(raw, 'exchangeRate');
  if (currency === Currency.USD) {
    exchangeRate = decimalField(raw, 'exchangeRate', 'RATE', MAX_VALUE.RATE, errors);
  } else if (currency === Currency.PEN) {
    // D-038/D-042: en soles el tipo de cambio siempre es 1, comparado por valor (no por
    // texto: "1.00"/"1.0000" son el mismo tipo de cambio que "1").
    if (exchangeRateRaw === '') {
      exchangeRate = toFixedString('1', 'RATE');
    } else {
      const parsedRate = decimalStringSchema('RATE', {
        positive: true,
        max: MAX_VALUE.RATE,
      }).safeParse(exchangeRateRaw);
      if (!parsedRate.success || !toDecimal(parsedRate.data).eq(1)) {
        errors.push(
          `${COLUMN_DEFS.exchangeRate}: la fila está en soles y trae "${exchangeRateRaw}" — en ` +
            'soles el tipo de cambio siempre es 1; deja la columna vacía.',
        );
      } else {
        exchangeRate = toFixedString('1', 'RATE');
      }
    }
  }

  const referenceInvoice = field(raw, 'referenceInvoice').slice(0, 80);
  const referenceDateRaw = field(raw, 'referenceDate');
  let referenceDateText = 'fecha de carga';
  if (referenceDateRaw !== '') {
    const parsed = parseCalendarDate(referenceDateRaw);
    if (parsed === null) {
      errors.push(
        `${COLUMN_DEFS.referenceDate} "${referenceDateRaw}": no se pudo leer (usa AAAA-MM-DD o DD/MM/AAAA).`,
      );
    } else {
      referenceDateText = parsed;
    }
  }

  if (
    errors.length > 0 ||
    !product ||
    units === null ||
    unitCostPerUnit === null ||
    currency === null ||
    exchangeRate === null
  ) {
    return { rowNumber, sku: skuRaw, errors };
  }

  const notes = [
    'Saldo inicial de inventario',
    referenceInvoice ? `factura ref: ${referenceInvoice}` : 'sin factura de referencia',
    `fecha ref: ${referenceDateText}`,
  ].join(' · ');

  return {
    rowNumber,
    sku: skuRaw,
    errors: [],
    parsed: {
      sku: product.sku,
      productId: product.id,
      businessLineId: product.businessLineId,
      unit: product.unit,
      units,
      unitCostPerUnit,
      currency,
      exchangeRate,
      notes,
    },
  };
}
