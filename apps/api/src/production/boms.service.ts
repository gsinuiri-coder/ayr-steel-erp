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
    // D-122: la receta es **solo** de drywall. Una cobertura no la necesita: su acabado,
    // su espesor, su ancho, su largo y su color viven en el SKU, que es de donde salen la
    // densidad (RF-25) y el filtro de bobina (D-086). Mientras existieron las dos fuentes,
    // la que mandaba era la que menos se edita.
    if (kind !== ProductBomKind.DRYWALL) {
      throw new BadRequestException(
        'Una cobertura no lleva receta desde D-122: su acabado, su geometría y su color son del propio producto. Completalos en el catálogo.',
      );
    }
    if (product.businessLine.code !== BusinessLineCode.DRYWALL) {
      throw new BadRequestException('Una receta de drywall es de un producto de la línea Drywall');
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
    // D-055: un perfil de drywall se cuenta por pieza, así que su unidad es `NIU`.
    if (product.unit !== Unit.NIU) {
      throw new BadRequestException(
        `El producto se debe medir en unidades (${Unit.NIU}): la pieza es la unidad del producto terminado (D-055)`,
      );
    }

    const finish = await this.prisma.finish.findUnique({ where: { id: input.finishId } });
    if (!finish) throw new NotFoundException('Acabado no encontrado');
    if (!finish.isActive) throw new BadRequestException('El acabado está desactivado');

    // D-122/D-139: la receta ya no guarda ni el largo de la pieza ni sus kilos. Los dos
    // viven en el SKU (`products.length_mm`, `products.piece_weight_kg`), que es donde
    // D-118 ya había puesto el resto de la geometría. Lo que queda acá es el vínculo
    // fleje → perfil: qué acabado, qué espesor y qué ancho de fleje consume.
    const { inputWidthMm } = input;
    if (inputWidthMm === undefined) {
      throw new BadRequestException('Una receta de drywall necesita el ancho del fleje');
    }
    if (product.pieceWeightKg === null || product.pieceWeightKg.lte(0)) {
      throw new BadRequestException(
        `${product.sku} no tiene peso por pieza en el catálogo: cárgalo antes de darle receta (es lo que dice cuántos kilos consume cada pieza, D-139)`,
      );
    }

    const data = {
      kind,
      finishId: input.finishId,
      inputThicknessMm: toFixedString(input.inputThicknessMm, 'MM'),
      inputWidthMm: toFixedString(inputWidthMm, 'MM'),
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
    // D-139: los kilos que consume cada pieza son el peso de la pieza terminada, y viven en
    // el SKU. El DTO los sigue exponiendo acá porque la pantalla de la receta es donde se
    // miran, pero la fuente es una sola.
    kgPerPiece: bom.product.pieceWeightKg?.toFixed(3) ?? null,
    pieceLengthMm: bom.product.lengthMm?.toFixed(2) ?? null,
    isActive: bom.isActive,
    createdAt: bom.createdAt.toISOString(),
    updatedAt: bom.updatedAt.toISOString(),
  };
}
