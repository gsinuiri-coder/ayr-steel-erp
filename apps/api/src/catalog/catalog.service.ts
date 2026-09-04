import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type BusinessLineCode, type Color, type Product } from '@prisma/client';
import type { CreateProductInput, ProductDto, UpdateProductInput } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { ColorsService } from '../colors/colors.service';
import { toSharedLineCode } from '../common/business-line-code';
import { PrismaService } from '../prisma/prisma.service';

/** Catálogo de productos por línea (RF-50). Mutaciones solo ADMINISTRADOR. */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly colors: ColorsService,
  ) {}

  async findAll(businessLineId?: string): Promise<ProductDto[]> {
    const products = await this.prisma.product.findMany({
      where: businessLineId ? { businessLineId } : undefined,
      include: PRODUCT_RELATIONS,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return products.map(toDto);
  }

  async findOne(id: string): Promise<ProductDto> {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: PRODUCT_RELATIONS,
    });
    if (!product) throw new NotFoundException('Producto no encontrado');
    return toDto(product);
  }

  async create(actor: RequestUser, input: CreateProductInput): Promise<ProductDto> {
    const line = await this.prisma.businessLine.findUnique({ where: { id: input.businessLineId } });
    if (!line) throw new BadRequestException('Línea de negocio inválida');
    const colorId = await this.colors.resolveActive(input.colorId);

    try {
      const product = await this.prisma.$transaction(async (tx) => {
        const created = await tx.product.create({
          data: {
            businessLineId: input.businessLineId,
            sku: input.sku,
            name: input.name,
            unit: input.unit,
            source: input.source,
            listPricePen: input.listPricePen,
            colorId,
          },
          include: PRODUCT_RELATIONS,
        });
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'catalog.create',
          entity: 'products',
          entityId: created.id,
          after: auditView(created),
        });
        return created;
      });
      return toDto(product);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Ya existe un producto con ese SKU en esta línea');
      }
      throw err;
    }
  }

  async update(actor: RequestUser, id: string, input: UpdateProductInput): Promise<ProductDto> {
    const before = await this.prisma.product.findUnique({
      where: { id },
      include: PRODUCT_RELATIONS,
    });
    if (!before) throw new NotFoundException('Producto no encontrado');

    // D-055/D-059: la receta valida al crearse que el producto sea fabricado y se mida en
    // piezas. Dejar cambiar esas dos cosas después esquivaría la validación y la orden de
    // producción quedaría metiendo piezas a un producto que dice medirse en kilos.
    const changesUnit = input.unit !== undefined && input.unit !== before.unit;
    const changesSource = input.source !== undefined && input.source !== before.source;
    if (changesUnit || changesSource) {
      const bom = await this.prisma.productBom.findUnique({
        where: { productId: id },
        select: { id: true },
      });
      if (bom) {
        throw new BadRequestException(
          'El producto tiene una receta de fabricación: desactiva la receta antes de cambiarle la unidad o el origen',
        );
      }
    }

    const data: Prisma.ProductUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.unit !== undefined) data.unit = input.unit;
    if (input.source !== undefined) data.source = input.source;
    // D-068: `null` es un valor legítimo (quitar el precio de lista), así que no se puede
    // usar el truco de `?? undefined` que sirve para el resto de campos.
    if (input.listPricePen !== undefined) data.listPricePen = input.listPricePen;
    // D-085: cambiar el color de un producto con receta viva movería el filtro de bobina
    // (D-086) por debajo de las órdenes en curso, que montaron el rollo contra el color
    // anterior. Mismo criterio que la unidad y el origen, unas líneas más arriba.
    if (input.colorId !== undefined) {
      const changesColor = input.colorId !== before.colorId;
      if (changesColor) {
        await this.assertNoLiveRoofingOrders(id);
        const resolved = await this.colors.resolveActive(input.colorId);
        data.color = resolved === null ? { disconnect: true } : { connect: { id: resolved } };
      }
    }
    if (input.isActive !== undefined) data.isActive = input.isActive;

    const after = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({
        where: { id },
        data,
        include: PRODUCT_RELATIONS,
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'catalog.update',
        entity: 'products',
        entityId: id,
        before: auditView(before),
        after: auditView(updated),
      });
      return updated;
    });
    return toDto(after);
  }

  /** Órdenes de coberturas vivas de este producto: las que el cambio de color rompería. */
  private async assertNoLiveRoofingOrders(productId: string): Promise<void> {
    const live = await this.prisma.productionOrder.count({
      where: { productId, status: { in: ['DRAFT', 'IN_PROGRESS'] } },
    });
    if (live > 0) {
      throw new BadRequestException(
        `El producto tiene ${live} orden(es) de producción en curso: ciérralas o anúlalas antes de cambiarle el color`,
      );
    }
  }
}

const PRODUCT_RELATIONS = {
  businessLine: { select: { code: true } },
  color: true,
} satisfies Prisma.ProductInclude;

type WithLineCode = Product & {
  businessLine: { code: BusinessLineCode };
  color: Color | null;
};

function toDto(p: WithLineCode): ProductDto {
  return {
    id: p.id,
    businessLineId: p.businessLineId,
    businessLineCode: toSharedLineCode(p.businessLine.code),
    sku: p.sku,
    name: p.name,
    unit: p.unit,
    listPricePen: p.listPricePen === null ? null : p.listPricePen.toFixed(4),
    colorId: p.colorId,
    colorCode: p.color?.code ?? null,
    colorName: p.color?.name ?? null,
    colorHex: p.color?.hexColor ?? null,
    isActive: p.isActive,
    source: p.source,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function auditView(p: Product): Prisma.InputJsonObject {
  return {
    businessLineId: p.businessLineId,
    sku: p.sku,
    name: p.name,
    unit: p.unit,
    source: p.source,
    listPricePen: p.listPricePen === null ? null : p.listPricePen.toFixed(4),
    colorId: p.colorId,
    isActive: p.isActive,
  };
}
