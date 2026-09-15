import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Currency, FinishKind } from '@prisma/client';
import {
  CURRENCIES,
  decimalStringSchema,
  finishKindHasColor,
  MAX_VALUE,
  toDecimal,
  toFixedString,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { CoilsService } from '../coils/coils.service';
import { OperationDateService } from '../common/operation-date.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  getField,
  parseCalendarDate,
  parseSpreadsheet,
  type ImportColumn,
} from './parse-spreadsheet';

/**
 * Carga de inventario inicial (D-206) — excepción **única** a D-150, y solo para esto.
 *
 * D-150 eliminó todo importador directo de bobinas porque cada uno copiaba las invariantes del
 * alta real en vez de heredarlas. Esta herramienta no las copia: cada fila termina en
 * `CoilsService.create`, la misma que usa la recepción de una compra — código RF-13, `typeKey`,
 * producto de `trading`, color derivado del acabado por el trigger de D-203 y el movimiento de
 * apertura de kardex, todo con el mismo código. Lo único que no pasa por ahí es de dónde sale
 * el proveedor (el sistema, D-206, porque esto no es una compra) y qué `refType` lleva el
 * movimiento (`IMPORT`, que existía sin emisor desde D-030 y esta es la primera vez que alguien
 * lo usa).
 *
 * Sin controller: no hay ruta HTTP que la exponga. El único llamador es el CLI de
 * `prisma/import-initial-inventory-cli.ts`, que corre por fuera del servidor — nadie llega acá
 * navegando la aplicación (D-206, condición 2: es de arranque, no un camino de ingreso más).
 *
 * Validación completa **antes** de escribir nada: `run` primero resuelve cada fila contra el
 * catálogo (acabado, color, duplicados) sin abrir transacción, y solo si **todas** pasan y el
 * llamador pidió `execute` abre una única transacción para crear las bobinas. No hace falta el
 * `SAVEPOINT` por fila del importador de cotizaciones (D-152): ahí una fila depende de una
 * decisión de otra (mismo documento); acá cada fila es una bobina independiente, así que
 * resolver todo antes de escribir ya deja ver todos los errores de una sola pasada.
 */
@Injectable()
export class InitialInventoryImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coils: CoilsService,
    private readonly audit: AuditService,
    private readonly operationDateService: OperationDateService,
  ) {}

  async run(actor: RequestUser, input: RunInput): Promise<InitialInventoryReport> {
    const sheet = parseSpreadsheet(input.buffer);
    if (sheet.length === 0) throw new BadRequestException('El archivo no tiene ninguna fila');
    const fromExport = isCoilExport(sheet[0] ?? {});
    const normalized = fromExport ? sheet.map(fromCoilExportRow) : sheet;
    assertColumns(normalized[0] ?? {});

    // V-4: en el formato del export, una bobina cerrada o sin kilos no es stock que abrir. Se
    // reporta como omitida (con su número de fila original) y no bloquea el resto del archivo.
    const skippedByRow = new Map<number, string>();
    const raw: Record<string, unknown>[] = [];
    const rowNumbers: number[] = [];
    normalized.forEach((r, i) => {
      const reason = fromExport ? coilExportSkipReason(r) : null;
      if (reason) skippedByRow.set(i + 1, reason);
      else {
        raw.push(r);
        rowNumbers.push(i + 1);
      }
    });
    const skippedSummaries = [...skippedByRow].map(([rowNumber, reason]) => ({
      rowNumber,
      externalCode: field(normalized[rowNumber - 1] ?? {}, 'externalCode'),
      ok: true,
      errors: [],
      skipped: reason,
    }));
    const withSkipped = (summaries: InitialInventoryRowSummary[]): InitialInventoryRowSummary[] =>
      [...summaries, ...skippedSummaries].sort((a, b) => a.rowNumber - b.rowNumber);

    // D-124: la misma validación que cualquier otra fecha de operación — no futura, no
    // anterior al piso de carga histórica. Una sola vez para todo el lote: las 500 bobinas
    // de una carga real nacen el mismo día de negocio.
    const operationDate = this.operationDateService.resolve(actor, input.operationDate);

    const supplier = await this.resolveSystemSupplier();

    const finishCodes = [...new Set(raw.map((r) => field(r, 'finishCode').toUpperCase()))].filter(
      (v) => v !== '',
    );
    const externalCodes = [...new Set(raw.map((r) => field(r, 'externalCode')))].filter(
      (v) => v !== '',
    );
    const [finishes, existing] = await Promise.all([
      this.prisma.finish.findMany({
        where: { code: { in: finishCodes } },
        select: {
          id: true,
          code: true,
          kind: true,
          isActive: true,
          businessLineId: true,
          color: { select: { name: true } },
        },
      }),
      externalCodes.length
        ? this.prisma.coil.findMany({
            where: { externalCode: { in: externalCodes } },
            select: { externalCode: true },
          })
        : Promise.resolve([]),
    ]);
    const byFinishCode = new Map(finishes.map((f) => [f.code.toUpperCase(), f]));
    const alreadyInBase = new Set(
      existing.map((c) => c.externalCode).filter((c): c is string => c !== null),
    );

    const seenInFile = new Set<string>();
    const rows = raw.map((r, i) =>
      parseRow(r, rowNumbers[i] ?? i + 1, byFinishCode, alreadyInBase, seenInFile, fromExport),
    );
    const ok = rows.every((r) => r.errors.length === 0);

    if (!ok || !input.execute) {
      return {
        totalRows: rows.length + skippedSummaries.length,
        ok,
        executed: false,
        rows: withSkipped(rows.map((r) => toRowSummary(r))),
      };
    }

    const batchId = input.batchId;
    const created = await this.prisma.$transaction(
      async (tx) => {
        const rowsCreated: { rowNumber: number; externalCode: string; coilCode: string }[] = [];
        for (const row of rows) {
          // `ok` ya confirmó que todas las filas tienen `parsed`; el chequeo es para el tipo.
          if (!row.parsed) continue;
          const coil = await this.coils.create(tx, {
            businessLineId: row.parsed.businessLineId,
            supplierId: supplier.id,
            finishId: row.parsed.finishId,
            weightKg: row.parsed.weightKg,
            widthMm: row.parsed.widthMm,
            thicknessMm: row.parsed.thicknessMm,
            currency: row.parsed.currency,
            exchangeRate: row.parsed.exchangeRate,
            unitCostPerKg: row.parsed.unitCostPerKg,
            refType: 'IMPORT',
            refId: batchId,
            actorId: actor.id,
            operationDate,
            notes: row.parsed.notes,
            externalCode: row.parsed.externalCode,
          });
          rowsCreated.push({
            rowNumber: row.rowNumber,
            externalCode: row.parsed.externalCode,
            coilCode: coil.code,
          });
        }
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'imports.initial-inventory',
          entity: 'coils',
          entityId: null,
          after: { batchId, fileName: input.fileName, count: rowsCreated.length },
        });
        return rowsCreated;
      },
      // Una carga inicial real puede traer cientos de bobinas; el timeout de una compra
      // (30 s) alcanza para unas pocas decenas de altas secuenciales.
      { timeout: 300_000, maxWait: 20_000 },
    );

    const coilCodeByRow = new Map(created.map((c) => [c.rowNumber, c.coilCode]));
    return {
      totalRows: rows.length + skippedSummaries.length,
      ok: true,
      executed: true,
      rows: withSkipped(rows.map((r) => toRowSummary(r, coilCodeByRow.get(r.rowNumber)))),
    };
  }

  /**
   * D-206: el proveedor «Saldo inicial de inventario» (`isSystem`), sembrado por
   * `prisma/seed.ts` y por la migración `20260915100000`. Si no aparece, la base no tiene el
   * seed de esta versión — se dice así en vez de un `NotFoundException` genérico.
   */
  private async resolveSystemSupplier(): Promise<{ id: string }> {
    const supplier = await this.prisma.supplier.findFirst({
      where: { isSystem: true, name: 'Saldo inicial de inventario' },
      select: { id: true },
    });
    if (!supplier) {
      throw new NotFoundException(
        'No existe el proveedor «Saldo inicial de inventario»: corre `pnpm db:seed` (o ' +
          '`pnpm db:migrate`/`pnpm db:deploy` si la migración D-206 todavía no se aplicó) antes ' +
          'de importar.',
      );
    }
    return supplier;
  }
}

// ---------------------------------------------------------------------------
// Contrato de entrada/salida
// ---------------------------------------------------------------------------

export interface RunInput {
  fileName: string;
  buffer: Buffer;
  /** `false` (por defecto en el CLI) valida y reporta sin escribir nada. */
  execute: boolean;
  /** D-124: día de negocio de TODAS las bobinas de esta corrida. Por defecto hoy. */
  operationDate?: string;
  /** Comparte `refId` entre todos los movimientos de esta corrida (trazabilidad del lote). */
  batchId: string;
}

export interface InitialInventoryRowSummary {
  rowNumber: number;
  externalCode: string;
  ok: boolean;
  errors: string[];
  /** Solo cuando `executed: true` y la fila entró. */
  coilCode?: string;
  /** Formato del export: la fila no se carga (bobina cerrada o sin kilos) y dice por qué. */
  skipped?: string;
}

export interface InitialInventoryReport {
  totalRows: number;
  /** Todas las filas pasaron su validación. Con `executed: false` es un dry-run limpio. */
  ok: boolean;
  /** Se escribió de verdad (implica `ok: true`). */
  executed: boolean;
  rows: InitialInventoryRowSummary[];
}

// ---------------------------------------------------------------------------
// Columnas del archivo
// ---------------------------------------------------------------------------

const COLUMN_DEFS = {
  externalCode: 'CÓDIGO BOBINA',
  finishCode: 'ACABADO',
  color: 'COLOR',
  thicknessMm: 'ESPESOR (MM)',
  widthMm: 'ANCHO (MM)',
  weightKg: 'KILOS INICIALES',
  unitCostPerKg: 'COSTO UNITARIO (S/KG SIN IGV)',
  currency: 'MONEDA',
  exchangeRate: 'TIPO DE CAMBIO',
  referenceInvoice: 'FACTURA DE REFERENCIA',
  referenceDate: 'FECHA DE REFERENCIA',
} as const;

type ColumnKey = keyof typeof COLUMN_DEFS;

const REQUIRED_COLUMNS: readonly string[] = [
  COLUMN_DEFS.externalCode,
  COLUMN_DEFS.finishCode,
  COLUMN_DEFS.thicknessMm,
  COLUMN_DEFS.widthMm,
  COLUMN_DEFS.weightKg,
  COLUMN_DEFS.unitCostPerKg,
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

// ---------------------------------------------------------------------------
// Formato del export de bobinas (`pnpm export:coils`, ventana V-4)
// ---------------------------------------------------------------------------
//
// La recarga de V-4 sube el export de las bobinas que `production` tenía antes de la limpia
// (D-208), no la plantilla. Se traduce a las columnas de la plantilla y el resto del camino es
// el mismo. Mapeo confirmado por el dueño: los kilos de apertura son `KILOS INICIALES` (la
// plantilla ya lee esa columna); `CÓDIGO SISTEMA` pasa a ser el código de origen; el
// comprobante de compra, la factura de referencia.

const EXPORT_COLUMNS = {
  systemCode: 'CÓDIGO SISTEMA',
  invoice: 'COMPROBANTE',
  invoiceDate: 'FECHA DE COMPROBANTE',
  status: 'ESTADO',
  currentKg: 'KILOS ACTUALES',
} as const;

function exportField(raw: Record<string, unknown>, header: string): string {
  return getField(raw, { key: header, header, required: false });
}

export function isCoilExport(first: Record<string, unknown>): boolean {
  return (
    exportField(first, EXPORT_COLUMNS.systemCode) !== '' && field(first, 'externalCode') === ''
  );
}

export function fromCoilExportRow(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    ...raw,
    [COLUMN_DEFS.externalCode]: exportField(raw, EXPORT_COLUMNS.systemCode),
    [COLUMN_DEFS.referenceInvoice]: exportField(raw, EXPORT_COLUMNS.invoice),
    [COLUMN_DEFS.referenceDate]: exportField(raw, EXPORT_COLUMNS.invoiceDate),
  };
}

/** Por defecto se omiten las cerradas y las que ya no tienen kilos (dueño, V-4). */
export function coilExportSkipReason(raw: Record<string, unknown>): string | null {
  const status = exportField(raw, EXPORT_COLUMNS.status).toUpperCase();
  if (status === 'CLOSED') return 'bobina cerrada';
  const currentKg = exportField(raw, EXPORT_COLUMNS.currentKg);
  if (currentKg !== '' && !toDecimal(currentKg).gt(0)) return 'sin kilos actuales';
  return null;
}

/** Largo real de la columna en la base (`coils.external_code VARCHAR(40)`, D-206). */
const MAX_EXTERNAL_CODE_LENGTH = 40;

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

// ---------------------------------------------------------------------------
// Fila a fila
// ---------------------------------------------------------------------------

interface FinishRow {
  id: string;
  code: string;
  kind: FinishKind | null;
  isActive: boolean;
  businessLineId: string | null;
  color: { name: string } | null;
}

interface ParsedRow {
  externalCode: string;
  finishId: string;
  businessLineId: string;
  thicknessMm: string;
  widthMm: string;
  weightKg: string;
  unitCostPerKg: string;
  currency: Currency;
  exchangeRate: string;
  notes: string;
}

interface RowResult {
  rowNumber: number;
  externalCode: string;
  errors: string[];
  parsed?: ParsedRow;
}

function toRowSummary(row: RowResult, coilCode?: string): InitialInventoryRowSummary {
  return {
    rowNumber: row.rowNumber,
    externalCode: row.externalCode,
    ok: row.errors.length === 0,
    errors: row.errors,
    ...(coilCode ? { coilCode } : {}),
  };
}

function decimalField(
  raw: Record<string, unknown>,
  key: ColumnKey,
  scale: 'MM' | 'KG' | 'MONEY' | 'RATE',
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
  byFinishCode: ReadonlyMap<string, FinishRow>,
  alreadyInBase: ReadonlySet<string>,
  seenInFile: Set<string>,
  fromExport = false,
): RowResult {
  const errors: string[] = [];
  const externalCode = field(raw, 'externalCode');

  if (externalCode === '') {
    errors.push(`${COLUMN_DEFS.externalCode}: es obligatoria.`);
  } else if (externalCode.length > MAX_EXTERNAL_CODE_LENGTH) {
    errors.push(
      `${COLUMN_DEFS.externalCode} "${externalCode}": no puede tener más de ` +
        `${String(MAX_EXTERNAL_CODE_LENGTH)} caracteres (tiene ${String(externalCode.length)}).`,
    );
  } else if (alreadyInBase.has(externalCode)) {
    errors.push(
      `${COLUMN_DEFS.externalCode} "${externalCode}": ya existe una bobina con este código — ` +
        'esta herramienta es solo de arranque y nunca actualiza una bobina existente.',
    );
  } else if (seenInFile.has(externalCode)) {
    errors.push(`${COLUMN_DEFS.externalCode} "${externalCode}": está repetido en el archivo.`);
  } else {
    seenInFile.add(externalCode);
  }

  const finishCodeRaw = field(raw, 'finishCode');
  const finish = byFinishCode.get(finishCodeRaw.toUpperCase());
  if (finishCodeRaw === '') {
    errors.push(`${COLUMN_DEFS.finishCode}: es obligatoria.`);
  } else if (!finish) {
    errors.push(
      `${COLUMN_DEFS.finishCode} "${finishCodeRaw}": no existe en el catálogo. Créalo en ` +
        'Acabados antes de importar — esta herramienta no crea acabados.',
    );
  } else if (!finish.isActive) {
    errors.push(`${COLUMN_DEFS.finishCode} "${finish.code}": está desactivado.`);
  } else if (finish.kind === null || finish.businessLineId === null) {
    errors.push(
      `${COLUMN_DEFS.finishCode} "${finish.code}": no tiene tipo ni línea (D-203). Complétalo ` +
        'en Acabados antes de importar.',
    );
  }

  // En el export, el COLOR es el que la bobina tenía antes de que el dueño completara el tipo
  // del acabado (paso 5 de V-4): si el acabado quedó sin color, esa columna ya no dice nada.
  const colorRaw =
    fromExport && finish?.kind && !finishKindHasColor(finish.kind) ? '' : field(raw, 'color');
  if (finish?.kind) {
    const needsColor = finishKindHasColor(finish.kind);
    if (needsColor && colorRaw === '') {
      errors.push(
        `${COLUMN_DEFS.color}: el acabado ${finish.code} es prepintado y lleva color — la ` +
          'fila lo dejó vacío.',
      );
    } else if (!needsColor && colorRaw !== '') {
      errors.push(`${COLUMN_DEFS.color}: el acabado ${finish.code} no lleva color.`);
    } else if (needsColor && colorRaw !== '' && finish.color) {
      if (finish.color.name.trim().toLowerCase() !== colorRaw.trim().toLowerCase()) {
        errors.push(
          `${COLUMN_DEFS.color} "${colorRaw}" no coincide con el del acabado ${finish.code} ` +
            `("${finish.color.name}"). El color de la bobina sale del acabado (D-203): si el ` +
            'rollo es de otro color, el acabado de la fila está mal.',
        );
      }
    }
  }

  const thicknessMm = decimalField(raw, 'thicknessMm', 'MM', MAX_VALUE.THICKNESS_MM, errors);
  const widthMm = decimalField(raw, 'widthMm', 'MM', MAX_VALUE.WIDTH_MM, errors);
  const weightKg = decimalField(raw, 'weightKg', 'KG', MAX_VALUE.KG, errors);
  const unitCostPerKg = decimalField(raw, 'unitCostPerKg', 'MONEY', MAX_VALUE.MONEY, errors);

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
    // D-038/D-042: en soles el tipo de cambio siempre es 1. Un valor distinto en el archivo es
    // casi seguro un descuido de quien lo llenó (arrastró la columna de otra fila en dólares).
    // Se compara el VALOR, no el texto: "1.00"/"1.0000" son el mismo tipo de cambio que "1" y
    // no tienen por qué rechazarse (Excel arrastra formato de otra celda con frecuencia).
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
    !finish ||
    thicknessMm === null ||
    widthMm === null ||
    weightKg === null ||
    unitCostPerKg === null ||
    currency === null ||
    exchangeRate === null ||
    finish.businessLineId === null
  ) {
    return { rowNumber, externalCode, errors };
  }

  const notes = [
    'Saldo inicial de inventario',
    referenceInvoice ? `factura ref: ${referenceInvoice}` : 'sin factura de referencia',
    `fecha ref: ${referenceDateText}`,
    `código origen: ${externalCode}`,
  ].join(' · ');

  return {
    rowNumber,
    externalCode,
    errors: [],
    parsed: {
      externalCode,
      finishId: finish.id,
      businessLineId: finish.businessLineId,
      thicknessMm,
      widthMm,
      weightKg,
      unitCostPerKg,
      currency,
      exchangeRate,
      notes,
    },
  };
}
