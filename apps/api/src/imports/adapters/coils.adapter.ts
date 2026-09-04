import { Injectable } from '@nestjs/common';
import { InventoryStrategy, type Prisma } from '@prisma/client';
import {
  BUSINESS_LINES,
  CURRENCIES,
  Currency,
  decimalStringSchema,
  ImportEntity,
  type BusinessLine,
} from '@ayr/shared';
import { CoilsService } from '../../coils/coils.service';
import { toPrismaLineCode } from '../../common/business-line-code';
import { PrismaService } from '../../prisma/prisma.service';
import {
  getField,
  type ImportAdapter,
  type ImportColumn,
  type RowValidation,
} from './import-adapter.interface';

const COLUMNS = {
  businessLineCode: { key: 'businessLineCode', header: 'Línea', required: true },
  supplierCode: { key: 'supplierCode', header: 'Proveedor (código)', required: true },
  finishCode: { key: 'finishCode', header: 'Acabado', required: true },
  /**
   * D-085: código del maestro de colores. Opcional — las galvanizadas no llevan color, y
   * una planilla histórica anterior a Fase 6 no tiene la columna.
   */
  colorCode: { key: 'colorCode', header: 'Color (código)', required: false },
  weightKg: { key: 'weightKg', header: 'Peso (kg)', required: true },
  widthMm: { key: 'widthMm', header: 'Ancho (mm)', required: true },
  thicknessMm: { key: 'thicknessMm', header: 'Espesor (mm)', required: true },
  currency: { key: 'currency', header: 'Moneda (PEN/USD)', required: true },
  unitCostPerKg: { key: 'unitCostPerKg', header: 'Costo por kg sin IGV', required: true },
  exchangeRate: { key: 'exchangeRate', header: 'Tipo de cambio', required: false },
} satisfies Record<string, ImportColumn>;

const kgSchema = decimalStringSchema('KG', { positive: true });
const mmSchema = decimalStringSchema('MM', { positive: true });
const moneySchema = decimalStringSchema('MONEY', { positive: true });
const rateSchema = decimalStringSchema('RATE', { positive: true });

/**
 * Alta masiva de bobinas desde planilla (RF-12). Es la carga histórica: la bobina
 * entra sin compra asociada, con `refType = IMPORT` en el kardex. El alta normal de
 * una bobina nueva es una compra de tipo COIL (RF-10/RF-11).
 */
@Injectable()
export class CoilsImportAdapter implements ImportAdapter {
  entity = ImportEntity.COILS;
  columns = Object.values(COLUMNS);

  constructor(
    private readonly prisma: PrismaService,
    private readonly coils: CoilsService,
  ) {}

  async validateRow(raw: Record<string, unknown>): Promise<RowValidation> {
    const businessLineCode = getField(raw, COLUMNS.businessLineCode).toLowerCase();
    const supplierCode = getField(raw, COLUMNS.supplierCode).toUpperCase();
    const finishCode = getField(raw, COLUMNS.finishCode).toUpperCase();
    const currency = getField(raw, COLUMNS.currency).toUpperCase();
    const errors: string[] = [];

    let businessLineId: string | undefined;
    if (!BUSINESS_LINES.includes(businessLineCode as BusinessLine)) {
      errors.push(`Línea de negocio desconocida: "${businessLineCode}"`);
    } else {
      const line = await this.prisma.businessLine.findUnique({
        where: { code: toPrismaLineCode(businessLineCode as BusinessLine) },
      });
      if (!line) {
        errors.push(`Línea de negocio desconocida: "${businessLineCode}"`);
      } else if (line.inventoryStrategy === InventoryStrategy.NOOP) {
        errors.push(`La línea "${businessLineCode}" no lleva inventario`);
      } else {
        businessLineId = line.id;
      }
    }

    let supplierId: string | undefined;
    if (!supplierCode) {
      errors.push('El código de proveedor es obligatorio');
    } else {
      const supplier = await this.prisma.supplier.findUnique({ where: { code: supplierCode } });
      if (!supplier) errors.push(`No existe un proveedor con código "${supplierCode}"`);
      else if (!supplier.isActive) errors.push(`El proveedor "${supplierCode}" está desactivado`);
      else supplierId = supplier.id;
    }

    let finishId: string | undefined;
    if (!finishCode) {
      errors.push('El acabado es obligatorio');
    } else {
      const finish = await this.prisma.finish.findUnique({ where: { code: finishCode } });
      if (!finish) errors.push(`No existe el acabado "${finishCode}"`);
      else if (!finish.isActive) errors.push(`El acabado "${finishCode}" está desactivado`);
      else finishId = finish.id;
    }

    // D-085: el color es opcional, pero un código que no existe es un error de la fila y
    // no un "sin color" silencioso: importar una bobina prepintada como galvanizada la
    // deja invisible para el filtro de la OP de coberturas sin que nadie se entere.
    const colorCode = getField(raw, COLUMNS.colorCode).toUpperCase();
    let colorId: string | null = null;
    if (colorCode) {
      const color = await this.prisma.color.findUnique({ where: { code: colorCode } });
      if (!color) errors.push(`No existe el color "${colorCode}"`);
      else if (!color.isActive) errors.push(`El color "${colorCode}" está desactivado`);
      else colorId = color.id;
    }

    if (!CURRENCIES.includes(currency as Currency)) {
      errors.push('La moneda debe ser PEN o USD');
    }

    const weightKg = parseField(raw, COLUMNS.weightKg, kgSchema, 'El peso', errors);
    const widthMm = parseField(raw, COLUMNS.widthMm, mmSchema, 'El ancho', errors);
    const thicknessMm = parseField(raw, COLUMNS.thicknessMm, mmSchema, 'El espesor', errors);
    const unitCostPerKg = parseField(
      raw,
      COLUMNS.unitCostPerKg,
      moneySchema,
      'El costo por kg',
      errors,
    );

    const rawRate = getField(raw, COLUMNS.exchangeRate);
    let exchangeRate: string | undefined;
    if (currency === Currency.PEN) {
      exchangeRate = '1.0000';
    } else if (!rawRate) {
      errors.push('Una bobina en dólares necesita su tipo de cambio');
    } else {
      exchangeRate = parseField(raw, COLUMNS.exchangeRate, rateSchema, 'El tipo de cambio', errors);
    }

    return {
      data: {
        businessLineCode,
        businessLineId,
        supplierCode,
        supplierId,
        finishCode,
        finishId,
        colorCode,
        colorId,
        weightKg,
        widthMm,
        thicknessMm,
        currency,
        unitCostPerKg,
        exchangeRate,
      },
      errors,
    };
  }

  /**
   * No hay clave natural: dos bobinas idénticas del mismo proveedor son dos bobinas
   * distintas, cada una con su propio correlativo (RF-13). Por eso no se deduplica.
   */
  dedupeKey(): string | undefined {
    return undefined;
  }

  async createEntity(
    tx: Prisma.TransactionClient,
    data: Record<string, unknown>,
    actorId: string,
  ): Promise<string> {
    const coil = await this.coils.create(tx, {
      businessLineId: data.businessLineId as string,
      supplierId: data.supplierId as string,
      finishId: data.finishId as string,
      colorId: (data.colorId as string | null) ?? null,
      weightKg: data.weightKg as string,
      widthMm: data.widthMm as string,
      thicknessMm: data.thicknessMm as string,
      currency: data.currency as Currency,
      exchangeRate: data.exchangeRate as string,
      unitCostPerKg: data.unitCostPerKg as string,
      refType: 'IMPORT',
      actorId,
    });
    return coil.id;
  }
}

/** Valida un campo decimal de la fila y acumula el error en español si no pasa. */
function parseField(
  raw: Record<string, unknown>,
  column: ImportColumn,
  schema: ReturnType<typeof decimalStringSchema>,
  label: string,
  errors: string[],
): string | undefined {
  const value = getField(raw, column);
  if (!value) {
    if (column.required) errors.push(`${label} es obligatorio`);
    return undefined;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    errors.push(`${label}: ${parsed.error.issues[0]?.message ?? 'valor inválido'}`);
    return undefined;
  }
  // Ya normalizado a la escala del campo y como string (D-003: nunca `number`).
  return parsed.data;
}
