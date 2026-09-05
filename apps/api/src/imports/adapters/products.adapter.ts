import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { BUSINESS_LINES, ImportEntity, PRODUCT_SOURCES, createProductSchema } from '@ayr/shared';
import { toPrismaLineCode } from '../../common/business-line-code';
import { PrismaService } from '../../prisma/prisma.service';
import {
  getField,
  type ImportColumn,
  type RowImportAdapter,
  type RowValidation,
} from './import-adapter.interface';

const COLUMNS = {
  businessLineCode: { key: 'businessLineCode', header: 'Línea', required: true },
  sku: { key: 'sku', header: 'SKU', required: true },
  name: { key: 'name', header: 'Nombre', required: true },
  unit: { key: 'unit', header: 'Unidad', required: true },
  source: { key: 'source', header: 'Origen (MANUFACTURED/PURCHASED)', required: true },
} satisfies Record<string, ImportColumn>;

/** Adaptador de importación de catálogo (RF-52). Resuelve el código de línea a su id. */
@Injectable()
export class ProductsImportAdapter implements RowImportAdapter {
  entity = ImportEntity.PRODUCTS;
  columns = Object.values(COLUMNS);

  constructor(private readonly prisma: PrismaService) {}

  async validateRow(raw: Record<string, unknown>): Promise<RowValidation> {
    const businessLineCode = getField(raw, COLUMNS.businessLineCode).toLowerCase();
    const sku = getField(raw, COLUMNS.sku).toUpperCase();
    const name = getField(raw, COLUMNS.name);
    const unit = getField(raw, COLUMNS.unit);
    const source = getField(raw, COLUMNS.source).toUpperCase();

    const errors: string[] = [];
    let businessLineId: string | undefined;
    if (!businessLineCode) {
      errors.push('La línea de negocio es obligatoria');
    } else if (!BUSINESS_LINES.includes(businessLineCode as (typeof BUSINESS_LINES)[number])) {
      errors.push(`Línea de negocio desconocida: "${businessLineCode}"`);
    } else {
      const line = await this.prisma.businessLine.findUnique({
        where: { code: toPrismaLineCode(businessLineCode as (typeof BUSINESS_LINES)[number]) },
      });
      if (!line) errors.push(`Línea de negocio desconocida: "${businessLineCode}"`);
      else businessLineId = line.id;
    }
    if (!PRODUCT_SOURCES.includes(source as (typeof PRODUCT_SOURCES)[number])) {
      errors.push('El origen debe ser MANUFACTURED o PURCHASED');
    }

    const parsed = createProductSchema.safeParse({
      businessLineId: businessLineId ?? '00000000-0000-0000-0000-000000000000',
      sku,
      name,
      unit,
      source,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'businessLineId') continue; // ya cubierto arriba con mensaje propio
        errors.push(issue.message);
      }
    }

    if (businessLineId && sku) {
      const dup = await this.prisma.product.findFirst({ where: { businessLineId, sku } });
      if (dup) errors.push(`Ya existe el SKU "${sku}" en esa línea`);
    }

    return {
      data: { businessLineCode, businessLineId, sku, name, unit, source },
      errors,
    };
  }

  dedupeKey(data: Record<string, unknown>): string | undefined {
    const businessLineId = data.businessLineId as string | undefined;
    const sku = data.sku as string | undefined;
    return businessLineId && sku ? `${businessLineId}:${sku}` : undefined;
  }

  async createEntity(tx: Prisma.TransactionClient, data: Record<string, unknown>): Promise<string> {
    const created = await tx.product.create({
      data: {
        businessLineId: data.businessLineId as string,
        sku: data.sku as string,
        name: data.name as string,
        unit: data.unit as string,
        source: data.source as Prisma.ProductCreateInput['source'],
      },
    });
    return created.id;
  }
}
