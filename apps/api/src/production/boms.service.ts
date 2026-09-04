import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  BusinessLineCode,
  ProductBomKind,
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
 * Receta de fabricación en el maestro de productos (D-059, D-087). Una por producto, de dos
 * clases:
 *
 * - **DRYWALL** (Fase 4): qué fleje consume —acabado + espesor + ancho, que es como RF-42
 *   agrupa el stock de flejes— y cuántos kilos teóricos se lleva cada pieza (D-047).
 * - **ROOFING** (Fase 6): solo acabado y espesor de entrada. El ancho lo pone la bobina que
 *   se monte y el kilo sale de su geometría por el largo reportado, así que fijarlos en el
 *   maestro solo dejaría fuera rollos válidos. El `pieceLengthMm` es lo que separa los dos
 *   productos de D-083: **con** largo es una plancha de catálogo (`NIU`, stock general),
 *   **sin** largo es una cobertura a medida (`MTR`, el largo lo trae el pedido).
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
    const kind = input.kind;
    const expectedLine =
      kind === ProductBomKind.DRYWALL
        ? BusinessLineCode.DRYWALL
        : BusinessLineCode.METALLIC_ROOFING;
    if (product.businessLine.code !== expectedLine) {
      throw new BadRequestException(
        kind === ProductBomKind.DRYWALL
          ? 'Una receta de drywall es de un producto de la línea Drywall'
          : 'Una receta de cobertura es de un producto de la línea Metallic Roofing',
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
    // D-055 y D-083: la unidad del producto **es** lo que separa los tres casos, y por eso
    // se valida acá y no se deduce después. Un perfil y una plancha de catálogo se cuentan
    // por pieza; una cobertura a medida se lleva en metros porque dos planchas de largo
    // distinto no pueden compartir un promedio ponderado.
    const expectedUnit =
      kind === ProductBomKind.DRYWALL || input.pieceLengthMm !== undefined ? Unit.NIU : Unit.MTR;
    if (product.unit !== expectedUnit) {
      throw new BadRequestException(
        expectedUnit === Unit.NIU
          ? `El producto se debe medir en unidades (${Unit.NIU}): con largo fijo, la pieza es la unidad del producto terminado (D-055, D-083)`
          : `Una cobertura a medida se mide en metros lineales (${Unit.MTR}): el largo lo pone el pedido, así que la pieza no es una unidad comparable (D-083)`,
      );
    }

    const finish = await this.prisma.finish.findUnique({ where: { id: input.finishId } });
    if (!finish) throw new NotFoundException('Acabado no encontrado');
    if (!finish.isActive) throw new BadRequestException('El acabado está desactivado');

    // El kilo por pieza solo existe en drywall: el schema ya rechaza mandarlo en una
    // receta de cobertura, donde sale de la bobina montada por el largo reportado (D-047).
    let kgPerPiece: string | null = null;
    if (kind === ProductBomKind.DRYWALL) {
      // El schema ya los exige; el chequeo se repite acá porque es lo que estrecha el tipo,
      // y porque un servicio no debería depender de que su llamador haya validado — es la
      // misma red que `drywallShape` pone del lado de la orden.
      const { inputWidthMm, pieceLengthMm } = input;
      if (inputWidthMm === undefined || pieceLengthMm === undefined) {
        throw new BadRequestException(
          'Una receta de drywall necesita el ancho del fleje y el largo de la pieza',
        );
      }
      const suggested = theoreticalKgPerPiece({
        widthMm: inputWidthMm,
        thicknessMm: input.inputThicknessMm,
        pieceLengthMm,
        densityFactor: finish.densityFactor.toFixed(4),
      });
      if (input.kgPerPiece === undefined && suggested.lte(0)) {
        throw new BadRequestException(
          'La geometría de la pieza no llega a un kilo redondeable: revisa ancho, espesor y largo, o escribe el kilo por pieza a mano',
        );
      }
      kgPerPiece = toFixedString(input.kgPerPiece ?? suggested, 'KG');
    }

    const data = {
      kind,
      finishId: input.finishId,
      inputThicknessMm: toFixedString(input.inputThicknessMm, 'MM'),
      inputWidthMm:
        input.inputWidthMm === undefined ? null : toFixedString(input.inputWidthMm, 'MM'),
      pieceLengthMm:
        input.pieceLengthMm === undefined ? null : toFixedString(input.pieceLengthMm, 'MM'),
      kgPerPiece,
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
    kind: bom.kind,
    inputThicknessMm: bom.inputThicknessMm.toFixed(2),
    inputWidthMm: bom.inputWidthMm?.toFixed(2) ?? null,
    pieceLengthMm: bom.pieceLengthMm?.toFixed(2) ?? null,
    kgPerPiece: bom.kgPerPiece?.toFixed(3) ?? null,
    isActive: bom.isActive,
  };
}

export function toDto(bom: BomWithRelations): ProductBomDto {
  return {
    id: bom.id,
    productId: bom.productId,
    productSku: bom.product.sku,
    productName: bom.product.name,
    productUnit: bom.product.unit,
    businessLine: toSharedLineCode(bom.product.businessLine.code),
    kind: bom.kind,
    finishId: bom.finishId,
    finishCode: bom.finish.code,
    finishName: bom.finish.name,
    densityFactor: bom.finish.densityFactor.toFixed(4),
    inputThicknessMm: bom.inputThicknessMm.toFixed(2),
    inputWidthMm: bom.inputWidthMm?.toFixed(2) ?? null,
    pieceLengthMm: bom.pieceLengthMm?.toFixed(2) ?? null,
    kgPerPiece: bom.kgPerPiece?.toFixed(3) ?? null,
    // Solo tiene sentido donde hay una geometría fija que sugerir: en coberturas la
    // geometría la trae el rollo que todavía no se montó.
    suggestedKgPerPiece:
      bom.inputWidthMm && bom.pieceLengthMm
        ? toFixedString(
            theoreticalKgPerPiece({
              widthMm: bom.inputWidthMm.toFixed(2),
              thicknessMm: bom.inputThicknessMm.toFixed(2),
              pieceLengthMm: bom.pieceLengthMm.toFixed(2),
              densityFactor: bom.finish.densityFactor.toFixed(4),
            }),
            'KG',
          )
        : null,
    isActive: bom.isActive,
    createdAt: bom.createdAt.toISOString(),
    updatedAt: bom.updatedAt.toISOString(),
  };
}
