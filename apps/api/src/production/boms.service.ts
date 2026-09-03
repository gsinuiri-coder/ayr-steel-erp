import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  BusinessLineCode,
  ProductSource,
  ProductionOrderStatus,
  type Finish,
  type Prisma,
  type Product,
  type ProductBom,
} from '@prisma/client';
import {
  productionOrderCode,
  theoreticalKgPerPiece,
  toFixedString,
  Unit,
  type ProductBomDto,
  type UpsertProductBomInput,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { toSharedLineCode } from '../common/business-line-code';
import { PrismaService } from '../prisma/prisma.service';

type BomWithRelations = ProductBom & {
  product: Product & { businessLine: { code: BusinessLineCode } };
  finish: Finish;
};

const BOM_RELATIONS = {
  product: { include: { businessLine: { select: { code: true } } } },
  finish: true,
} satisfies Prisma.ProductBomInclude;

/**
 * Receta de fabricación en el maestro de productos (D-059). Una por producto: qué fleje
 * consume (acabado + espesor + ancho, que es como RF-42 agrupa el stock de flejes) y
 * cuántos kilos teóricos se lleva cada pieza (D-047).
 *
 * En Fase 4 solo admite productos de la línea **drywall**: coberturas exigen cotización
 * (RF-31) y son de Fase 5 (D-048); dejar cargar su receta ahora sería construir la mitad
 * de un módulo que todavía no puede producir nada.
 */
@Injectable()
export class BomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll(productId?: string): Promise<ProductBomDto[]> {
    const boms = await this.prisma.productBom.findMany({
      where: { productId },
      include: BOM_RELATIONS,
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });
    return boms.map(toDto);
  }

  async findByProduct(productId: string): Promise<ProductBomDto> {
    const bom = await this.prisma.productBom.findUnique({
      where: { productId },
      include: BOM_RELATIONS,
    });
    if (!bom) throw new NotFoundException('El producto no tiene receta de fabricación (D-059)');
    return toDto(bom);
  }

  /** Alta o edición de la receta de un producto. Una sola receta viva por producto. */
  async upsert(
    actor: RequestUser,
    productId: string,
    input: UpsertProductBomInput,
  ): Promise<ProductBomDto> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: { businessLine: { select: { code: true } } },
    });
    if (!product) throw new NotFoundException('Producto no encontrado');
    if (product.businessLine.code !== BusinessLineCode.DRYWALL) {
      throw new BadRequestException(
        'Por ahora solo los productos de la línea Drywall tienen receta de fabricación: coberturas van contra cotización (RF-31) y son de Fase 5',
      );
    }
    if (!product.isActive) {
      throw new BadRequestException('El producto está desactivado: actívalo antes de darle receta');
    }
    if (product.source !== ProductSource.MANUFACTURED) {
      throw new BadRequestException(
        'La receta es de un producto fabricado: cambia el origen del producto a Fabricado',
      );
    }
    // D-055: el producto terminado se lleva en piezas, no en kilos. Con otra unidad el
    // kardex mezclaría escalas en el mismo saldo y `kgPerPiece` no significaría nada.
    if (product.unit !== Unit.NIU) {
      throw new BadRequestException(
        `El producto se debe medir en unidades (${Unit.NIU}): las piezas son la unidad primaria del producto terminado (D-055)`,
      );
    }

    const finish = await this.prisma.finish.findUnique({ where: { id: input.finishId } });
    if (!finish) throw new NotFoundException('Acabado no encontrado');
    if (!finish.isActive) throw new BadRequestException('El acabado está desactivado');

    const suggested = theoreticalKgPerPiece({
      widthMm: input.inputWidthMm,
      thicknessMm: input.inputThicknessMm,
      pieceLengthMm: input.pieceLengthMm,
      densityFactor: finish.densityFactor.toFixed(4),
    });
    if (input.kgPerPiece === undefined && suggested.lte(0)) {
      throw new BadRequestException(
        'La geometría de la pieza no llega a un kilo redondeable: revisa ancho, espesor y largo, o escribe el kilo por pieza a mano',
      );
    }
    const kgPerPiece = input.kgPerPiece ?? toFixedString(suggested, 'KG');

    const data = {
      finishId: input.finishId,
      inputThicknessMm: toFixedString(input.inputThicknessMm, 'MM'),
      inputWidthMm: toFixedString(input.inputWidthMm, 'MM'),
      pieceLengthMm: toFixedString(input.pieceLengthMm, 'MM'),
      kgPerPiece: toFixedString(kgPerPiece, 'KG'),
      isActive: input.isActive ?? true,
    };

    const saved = await this.prisma.$transaction(async (tx) => {
      // La receta se bloquea y se comprueba **dentro** de la transacción: leer las OP
      // vivas antes dejaba una ventana en la que una orden se creaba entre el chequeo y
      // el `UPDATE`, y terminaba corriendo con un `kgPerPiece` distinto del que validó.
      await tx.$queryRaw`
        SELECT "id" FROM "product_boms" WHERE "product_id" = ${productId}::uuid FOR UPDATE
      `;
      const existing = await tx.productBom.findUnique({
        where: { productId },
        include: BOM_RELATIONS,
      });
      // Cambiar la receta con una OP viva reescribiría el kilo teórico a mitad de una
      // corrida: los reportes anteriores habrían consumido con un número y los siguientes
      // con otro, y la merma del cierre saldría de una cuenta que nunca existió.
      if (existing) await this.assertNoLiveOrders(tx, existing.id);

      const bom = await tx.productBom.upsert({
        where: { productId },
        create: { productId, ...data, createdById: actor.id },
        update: data,
        include: BOM_RELATIONS,
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: existing ? 'production.bom.update' : 'production.bom.create',
        entity: 'product_boms',
        entityId: bom.id,
        before: existing ? auditView(existing) : undefined,
        after: auditView(bom),
      });
      return bom;
    });
    return toDto(saved);
  }

  /**
   * Receta que una OP puede usar, ya validada. La devuelve el servicio de producción
   * antes de crear la orden o de aceptar un fleje.
   */
  async requireActiveBom(productId: string): Promise<BomWithRelations> {
    const bom = await this.prisma.productBom.findUnique({
      where: { productId },
      include: BOM_RELATIONS,
    });
    if (!bom) {
      throw new BadRequestException(
        'El producto no tiene receta de fabricación: cárgala en el maestro antes de producirlo (D-059)',
      );
    }
    if (!bom.isActive) {
      throw new BadRequestException('La receta del producto está desactivada');
    }
    return bom;
  }

  private async assertNoLiveOrders(tx: Prisma.TransactionClient, bomId: string): Promise<void> {
    const live = await tx.productionOrder.findMany({
      where: {
        bomId,
        status: { in: [ProductionOrderStatus.DRAFT, ProductionOrderStatus.IN_PROGRESS] },
      },
      select: { seq: true },
      take: 5,
    });
    if (live.length > 0) {
      throw new BadRequestException(
        `La receta la están usando órdenes de producción en curso (${live.map((o) => productionOrderCode(o.seq)).join(', ')}): ciérralas o anúlalas antes de cambiarla`,
      );
    }
  }
}

/** Vista de la receta que va al `audit_log` (RF-95): solo los campos que la definen. */
function auditView(bom: ProductBom): Prisma.InputJsonObject {
  return {
    productId: bom.productId,
    finishId: bom.finishId,
    inputThicknessMm: bom.inputThicknessMm.toFixed(2),
    inputWidthMm: bom.inputWidthMm.toFixed(2),
    pieceLengthMm: bom.pieceLengthMm.toFixed(2),
    kgPerPiece: bom.kgPerPiece.toFixed(3),
    isActive: bom.isActive,
  };
}

export function toDto(bom: BomWithRelations): ProductBomDto {
  return {
    id: bom.id,
    productId: bom.productId,
    productSku: bom.product.sku,
    productName: bom.product.name,
    businessLine: toSharedLineCode(bom.product.businessLine.code),
    finishId: bom.finishId,
    finishCode: bom.finish.code,
    finishName: bom.finish.name,
    inputThicknessMm: bom.inputThicknessMm.toFixed(2),
    inputWidthMm: bom.inputWidthMm.toFixed(2),
    pieceLengthMm: bom.pieceLengthMm.toFixed(2),
    kgPerPiece: bom.kgPerPiece.toFixed(3),
    suggestedKgPerPiece: toFixedString(
      theoreticalKgPerPiece({
        widthMm: bom.inputWidthMm.toFixed(2),
        thicknessMm: bom.inputThicknessMm.toFixed(2),
        pieceLengthMm: bom.pieceLengthMm.toFixed(2),
        densityFactor: bom.finish.densityFactor.toFixed(4),
      }),
      'KG',
    ),
    isActive: bom.isActive,
    createdAt: bom.createdAt.toISOString(),
    updatedAt: bom.updatedAt.toISOString(),
  };
}
