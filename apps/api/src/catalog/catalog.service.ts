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

  /**
   * D-122: el acabado del producto, comprobado contra el maestro. Mismo criterio que el
   * color (D-085): un id inexistente da un 404 claro y uno **desactivado** se rechaza, para
   * que el catálogo no sea la puerta trasera por la que entra un acabado dado de baja al
   * filtro de bobina y al kilo teórico.
   */
  private async resolveActiveFinish(finishId: string | null | undefined): Promise<string | null> {
    if (finishId === null || finishId === undefined || finishId === '') return null;
    const finish = await this.prisma.finish.findUnique({
      where: { id: finishId },
      select: { id: true, isActive: true },
    });
    if (!finish) throw new NotFoundException('Acabado no encontrado');
    if (!finish.isActive) throw new BadRequestException('El acabado está desactivado');
    return finish.id;
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
    const finishId = await this.resolveActiveFinish(input.finishId);
    const roofingKind = input.roofingKind ?? null;
    assertStructuredFields(line.code, { ...input, roofingKind, finishId });

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
            finishId,
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
      input.finishId !== undefined ||
      input.unit !== undefined;
    if (touchesStructured) {
      assertStructuredFields(before.businessLine.code, {
        roofingKind,
        unit: input.unit ?? before.unit,
        finishId: input.finishId !== undefined ? input.finishId : before.finishId,
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
    // D-122: el acabado del producto es lo que fija la densidad con la que se convierten
    // metros en kilos. Cambiarlo con una OP de coberturas viva reescribiría el kilo teórico
    // a mitad de corrida — el mismo motivo por el que el color está bloqueado arriba.
    if (input.finishId !== undefined && input.finishId !== before.finishId) {
      await this.assertNoLiveRoofingOrders(id);
      const resolved = await this.resolveActiveFinish(input.finishId);
      data.finish = resolved === null ? { disconnect: true } : { connect: { id: resolved } };
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
    finishId: string | null;
  },
): void {
  if (lineCode === BusinessLineCode.METALLIC_ROOFING) {
    if (fields.thicknessMm === null) {
      throw new BadRequestException('El espesor del SKU es obligatorio en Metallic Roofing');
    }
    // D-122: la densidad con la que se convierten metros en kilos sale del acabado del
    // **producto**. Hasta D-122 salía de la receta, y por eso una cobertura no se podía
    // cotizar sin tener una; ahora la receta no existe y el dato tiene que estar acá.
    if (fields.finishId === null) {
      throw new BadRequestException(
        'El acabado del SKU es obligatorio en Metallic Roofing: de él sale la densidad con la que se calculan los kilos',
      );
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
  // D-122: la densidad sale del acabado **del producto** y el largo fijo, del propio SKU.
  // Hasta acá los dos venían de la receta, y eso obligaba a una cobertura a tener una.
  finish: { select: { id: true, code: true, name: true, densityFactor: true } },
} satisfies Prisma.ProductInclude;

type WithLineCode = Product & {
  businessLine: { code: BusinessLineCode };
  color: Color | null;
  finish: {
    id: string;
    code: string;
    name: string;
    densityFactor: Prisma.Decimal;
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
  if (p.thicknessMm === null || p.widthMm === null || p.finish === null) return null;
  const geometry = {
    widthMm: p.widthMm.toFixed(2),
    thicknessMm: p.thicknessMm.toFixed(2),
    densityFactor: p.finish.densityFactor.toFixed(4),
  };
  if (p.unit === Unit.MTR) return kgPerMeter(geometry).toFixed(3);
  if (p.lengthMm !== null) {
    return theoreticalKgPerPiece({
      ...geometry,
      pieceLengthMm: p.lengthMm.toFixed(2),
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
    finishId: p.finishId,
    finishCode: p.finish?.code ?? null,
    finishName: p.finish?.name ?? null,
    densityFactor: p.finish?.densityFactor.toFixed(4) ?? null,
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
    finishId: p.finishId,
    thicknessMm: p.thicknessMm === null ? null : p.thicknessMm.toFixed(2),
    widthMm: p.widthMm === null ? null : p.widthMm.toFixed(2),
    lengthMm: p.lengthMm === null ? null : p.lengthMm.toFixed(2),
    pieceWeightKg: p.pieceWeightKg === null ? null : p.pieceWeightKg.toFixed(3),
    isActive: p.isActive,
  };
}
