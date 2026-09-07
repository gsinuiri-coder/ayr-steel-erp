import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BusinessLineCode, Prisma, type Color, type Product } from '@prisma/client';
import {
  kgPerMeter,
  ROOFING_KIND_UNIT,
  RoofingProductKind,
  theoreticalKgPerPiece,
  Unit,
  type CreateProductInput,
  type ProductDto,
  type UpdateProductInput,
} from '@ayr/shared';
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
    const roofingKind = input.roofingKind ?? null;
    assertStructuredFields(line.code, { ...input, roofingKind });

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
            thicknessMm: input.thicknessMm,
            widthMm: input.widthMm,
            lengthMm: input.lengthMm,
            pieceWeightKg: input.pieceWeightKg,
            roofingKind,
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
    // D-127: corregir el subtipo **obliga** a mover la unidad (son el mismo hecho), y toda
    // cobertura a medida tiene receta activa. Sin esta excepción, el campo que D-127 promete
    // "visible y corregible" no se podía corregir en ningún producto real: el guardrail pedía
    // desactivar una receta que el propio subtipo necesita viva.
    const changesRoofingKind =
      input.roofingKind !== undefined && input.roofingKind !== before.roofingKind;
    if ((changesUnit && !changesRoofingKind) || changesSource) {
      const bom = await this.prisma.productBom.findFirst({
        // Solo una receta **activa** bloquea: una desactivada no la monta ninguna orden, y
        // pedir que se desactive algo ya desactivado era un mensaje sin salida.
        where: { productId: id, isActive: true },
        select: { id: true },
      });
      if (bom) {
        throw new BadRequestException(
          'El producto tiene una receta de fabricación: desactiva la receta antes de cambiarle la unidad o el origen',
        );
      }
    }

    // D-118: solo se revalida cuando el propio pedido toca uno de los campos
    // estructurados — un `isActive` suelto no debería exigir completar el catálogo
    // histórico que nació antes de esta fase.
    // D-127: el subtipo y la unidad entran a la misma revalidación. Cambiar de PLANCHA a
    // A MEDIDA cambia qué campos son obligatorios (el largo deja de serlo) y cambia la rama
    // de la confirmación, así que no puede pasar sin volver a comprobar la forma entera.
    const roofingKind =
      input.roofingKind !== undefined ? (input.roofingKind ?? null) : before.roofingKind;
    const touchesStructured =
      input.thicknessMm !== undefined ||
      input.widthMm !== undefined ||
      input.lengthMm !== undefined ||
      input.pieceWeightKg !== undefined ||
      input.roofingKind !== undefined ||
      input.unit !== undefined;
    if (touchesStructured) {
      assertStructuredFields(before.businessLine.code, {
        roofingKind,
        unit: input.unit ?? before.unit,
        thicknessMm:
          input.thicknessMm !== undefined
            ? input.thicknessMm
            : decimalOrNull(before.thicknessMm, 'MM'),
        widthMm: input.widthMm !== undefined ? input.widthMm : decimalOrNull(before.widthMm, 'MM'),
        lengthMm:
          input.lengthMm !== undefined ? input.lengthMm : decimalOrNull(before.lengthMm, 'MM'),
        pieceWeightKg:
          input.pieceWeightKg !== undefined
            ? input.pieceWeightKg
            : decimalOrNull(before.pieceWeightKg, 'KG'),
      });
    }

    const data: Prisma.ProductUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.unit !== undefined) data.unit = input.unit;
    if (input.source !== undefined) data.source = input.source;
    // D-068: `null` es un valor legítimo (quitar el precio de lista), así que no se puede
    // usar el truco de `?? undefined` que sirve para el resto de campos.
    if (input.listPricePen !== undefined) data.listPricePen = input.listPricePen;
    if (input.thicknessMm !== undefined) data.thicknessMm = input.thicknessMm;
    if (input.widthMm !== undefined) data.widthMm = input.widthMm;
    if (input.lengthMm !== undefined) data.lengthMm = input.lengthMm;
    if (input.pieceWeightKg !== undefined) data.pieceWeightKg = input.pieceWeightKg;
    if (input.roofingKind !== undefined) data.roofingKind = input.roofingKind;
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

/**
 * D-118 (Fase 7e, B): Metallic Roofing exige espesor y ancho estructurados (SKU); Drywall
 * exige ancho, largo y peso de la pieza terminada. El resto del catálogo no los usa —igual
 * que el color (D-085), no se restringe si vienen, solo si faltan donde hacen falta.
 */
function assertStructuredFields(
  lineCode: BusinessLineCode,
  fields: {
    thicknessMm: string | null;
    widthMm: string | null;
    lengthMm: string | null;
    pieceWeightKg: string | null;
    roofingKind: RoofingProductKind | null;
    unit: string | null;
  },
): void {
  if (lineCode === BusinessLineCode.METALLIC_ROOFING) {
    if (fields.thicknessMm === null) {
      throw new BadRequestException('El espesor del SKU es obligatorio en Metallic Roofing');
    }
    if (fields.widthMm === null) {
      throw new BadRequestException('El ancho del SKU es obligatorio en Metallic Roofing');
    }
    // D-127: el subtipo es obligatorio y explícito. Deducirlo de la unidad es exactamente lo
    // que dejó una cotización a medida pidiendo stock de producto terminado al confirmarse.
    if (fields.roofingKind === null) {
      throw new BadRequestException(
        'Indica el subtipo de la cobertura: plancha de catálogo o a medida',
      );
    }
    // Subtipo y unidad son el mismo hecho dicho dos veces, y todo el resto del sistema
    // (ventas, producción, despacho) ya lee la unidad. Que difieran reabriría la ambigüedad
    // por el otro lado; el mismo CHECK está en la base.
    // Lo que importa —y lo que el CHECK de la base sostiene— es que **a medida** se mida en
    // metros lineales: de ahí salen los subítems de largo y el cálculo de kilos teóricos. Una
    // plancha se mide en lo que la empresa venda (unidades, casi siempre), y exigirle `NIU`
    // acá dejaría sin poder editarse a cualquier producto legado con otra unidad.
    const expectedUnit = ROOFING_KIND_UNIT[fields.roofingKind];
    const unitOk =
      fields.roofingKind === RoofingProductKind.A_MEDIDA
        ? fields.unit === expectedUnit
        : fields.unit !== 'MTR';
    if (!unitOk) {
      throw new BadRequestException(
        fields.roofingKind === RoofingProductKind.A_MEDIDA
          ? 'Una cobertura a medida se mide en metros lineales (MTR)'
          : 'Una plancha de catálogo no se mide en metros lineales: eso es una cobertura a medida',
      );
    }
    // El largo solo lo lleva la plancha: es su largo fijo. Una cobertura a medida no tiene
    // largo propio — lo traen los subítems de cada línea de venta (D-083).
    if (fields.roofingKind === RoofingProductKind.PLANCHA && fields.lengthMm === null) {
      throw new BadRequestException('El largo de la plancha es obligatorio');
    }
    if (fields.roofingKind === RoofingProductKind.A_MEDIDA && fields.lengthMm !== null) {
      throw new BadRequestException(
        'Una cobertura a medida no lleva largo fijo: el largo va en los subítems de cada línea',
      );
    }
  } else if (fields.roofingKind !== null) {
    throw new BadRequestException('El subtipo de cobertura solo aplica a Metallic Roofing');
  }
  if (lineCode === BusinessLineCode.DRYWALL) {
    if (fields.widthMm === null) {
      throw new BadRequestException('El ancho de la pieza terminada es obligatorio en Drywall');
    }
    if (fields.lengthMm === null) {
      throw new BadRequestException('El largo de la pieza terminada es obligatorio en Drywall');
    }
    if (fields.pieceWeightKg === null) {
      throw new BadRequestException('El peso de la pieza terminada es obligatorio en Drywall');
    }
  }
}

function decimalOrNull(value: Prisma.Decimal | null, scale: 'MM' | 'KG'): string | null {
  if (value === null) return null;
  return scale === 'MM' ? value.toFixed(2) : value.toFixed(3);
}

const PRODUCT_RELATIONS = {
  businessLine: { select: { code: true } },
  color: true,
  // D-118: la densidad del acabado y el largo fijo de la receta son lo que
  // `theoreticalKgPerUnit` necesita para derivar kg/ml o kg/plancha de una cobertura.
  // `isActive` decide si esa receta todavía cuenta (hallazgo de `revisor`, Fase 7e).
  bom: {
    select: { isActive: true, pieceLengthMm: true, finish: { select: { densityFactor: true } } },
  },
} satisfies Prisma.ProductInclude;

type WithLineCode = Product & {
  businessLine: { code: BusinessLineCode };
  color: Color | null;
  bom: {
    isActive: boolean;
    pieceLengthMm: Prisma.Decimal | null;
    finish: { densityFactor: Prisma.Decimal };
  } | null;
};

/**
 * D-118: kg teórico por unidad de venta de una cobertura, derivado de espesor × ancho ×
 * densidad del acabado (RF-25). `null` si falta el espesor, el ancho o la receta activa
 * (sin receta viva no hay acabado del que sacar la densidad — una receta desactivada no
 * cuenta, mismo criterio que `resolveSalesLines`/`duplicate` usan para "tiene receta").
 * Drywall nunca lo calcula — declara el peso directo (`pieceWeightKg`) porque su sección
 * no es un prisma simple.
 */
function theoreticalKgPerUnit(p: WithLineCode): string | null {
  if (p.thicknessMm === null || p.widthMm === null || !p.bom?.isActive) return null;
  const geometry = {
    widthMm: p.widthMm.toFixed(2),
    thicknessMm: p.thicknessMm.toFixed(2),
    densityFactor: p.bom.finish.densityFactor.toFixed(4),
  };
  if (p.unit === Unit.MTR) return kgPerMeter(geometry).toFixed(3);
  if (p.bom.pieceLengthMm !== null) {
    return theoreticalKgPerPiece({
      ...geometry,
      pieceLengthMm: p.bom.pieceLengthMm.toFixed(2),
    }).toFixed(3);
  }
  return null;
}

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
    thicknessMm: p.thicknessMm === null ? null : p.thicknessMm.toFixed(2),
    widthMm: p.widthMm === null ? null : p.widthMm.toFixed(2),
    lengthMm: p.lengthMm === null ? null : p.lengthMm.toFixed(2),
    pieceWeightKg: p.pieceWeightKg === null ? null : p.pieceWeightKg.toFixed(3),
    roofingKind: p.roofingKind,
    theoreticalKgPerUnit: theoreticalKgPerUnit(p),
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
    thicknessMm: p.thicknessMm === null ? null : p.thicknessMm.toFixed(2),
    widthMm: p.widthMm === null ? null : p.widthMm.toFixed(2),
    lengthMm: p.lengthMm === null ? null : p.lengthMm.toFixed(2),
    pieceWeightKg: p.pieceWeightKg === null ? null : p.pieceWeightKg.toFixed(3),
    isActive: p.isActive,
  };
}
