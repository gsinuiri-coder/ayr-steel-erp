import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  BusinessLineCode,
  CoilKind,
  CoilStatus,
  ProductionOrderStatus,
  ProductionReportStatus,
  Prisma,
  type InventoryMovement,
} from '@prisma/client';
import {
  Decimal,
  MAX_ORDER_REPORTS,
  MAX_ORDER_STRIPS,
  MAX_SCRAP_RATIO_WITHOUT_REASON,
  productionOrderCode,
  theoreticalKg,
  toDecimal,
  toFixedString,
  Unit,
  type CancelProductionOrderInput,
  type CloseProductionOrderInput,
  type ConsumeStripInput,
  type CreateProductionOrderInput,
  type ProductionOrderDto,
  type ProductionOrderListItemDto,
  type ProductionOrderQuery,
  type ProductionStripOptionDto,
  type ReportPiecesInput,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { CoilsService } from '../coils/coils.service';
import { toPrismaLineCode, toSharedLineCode } from '../common/business-line-code';
import { InventoryService } from '../inventory/inventory.service';
import { liveMovements } from '../inventory/live-movements';
import { PrismaService } from '../prisma/prisma.service';
import { BomsService, toDto as bomToDto } from './boms.service';
import { assertStripsNotAssigned, findLiveStripAssignments } from './production-assignments';
import {
  allocateStripKg,
  closeAdjustmentPen,
  productionCost,
  type StripAllocationRow,
} from './production-math';

const ORDER_RELATIONS = {
  businessLine: { select: { code: true } },
  product: { select: { sku: true, name: true } },
  bom: {
    include: {
      product: { include: { businessLine: { select: { code: true } } } },
      finish: true,
    },
  },
  consumptions: {
    include: {
      coil: {
        select: {
          code: true,
          widthMm: true,
          parentCoilId: true,
          parentCoil: { select: { code: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  },
  // Los reportes de una OP no tienen tope de negocio pero sí de request: una corrida
  // real no pasa de unas pocas decenas, y traerlos todos sin cota dejaría el detalle
  // creciendo sin límite. `MAX_ORDER_REPORTS` corta bastante antes.
  reports: { orderBy: { seq: 'asc' }, take: MAX_ORDER_REPORTS },
} satisfies Prisma.ProductionOrderInclude;

/**
 * Lo mínimo que necesita el listado: agregados de las filas, sin la receta ni el detalle
 * de cada fleje. Con el `include` completo, 500 órdenes cerradas arrastraban miles de
 * filas por request a una pantalla que solo muestra totales.
 */
const LIST_RELATIONS = {
  businessLine: { select: { code: true } },
  product: { select: { sku: true, name: true } },
  consumptions: { select: { assignedKg: true, consumedKg: true, releasedAt: true } },
  reports: { select: { pieces: true, status: true } },
} satisfies Prisma.ProductionOrderInclude;

type OrderForList = Prisma.ProductionOrderGetPayload<{ include: typeof LIST_RELATIONS }>;

/**
 * Producción de drywall (RF-32..35, RF-39; D-055..D-060).
 *
 * Ciclo: crear la OP contra la receta del producto (D-059) → asignarle flejes (no mueve
 * kardex, D-060) → reportar piezas en N eventos, cada uno con su kardex completo (D-058)
 * → cerrar, que saca la merma de proceso por diferencia y costea la corrida (D-057,
 * D-056). Toda escritura de stock pasa por `InventoryService` (regla dura 2) y toda
 * mutación deja auditoría dentro de la misma transacción (RF-95).
 */
@Injectable()
export class ProductionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly coils: CoilsService,
    private readonly boms: BomsService,
  ) {}

  // -------------------------------------------------------------------------
  // RF-34 — crear la orden
  // -------------------------------------------------------------------------

  async create(actor: RequestUser, input: CreateProductionOrderInput): Promise<ProductionOrderDto> {
    const product = await this.prisma.product.findUnique({
      where: { id: input.productId },
      include: { businessLine: { select: { id: true, code: true } } },
    });
    if (!product) throw new NotFoundException('Producto no encontrado');
    if (!product.isActive) throw new BadRequestException('El producto está desactivado');
    // D-048: coberturas exigen una cotización confirmada (RF-31), que es de Fase 5.
    if (product.businessLine.code !== BusinessLineCode.DRYWALL) {
      throw new BadRequestException(
        'Por ahora solo se producen perfiles de Drywall: las coberturas van contra cotización (RF-31) y son de Fase 5',
      );
    }
    const bom = await this.boms.requireActiveBom(product.id);

    const orderId = await this.prisma.$transaction(async (tx) => {
      const order = await tx.productionOrder.create({
        data: {
          businessLineId: product.businessLineId,
          productId: product.id,
          bomId: bom.id,
          status: ProductionOrderStatus.DRAFT,
          targetPieces: input.targetPieces ?? null,
          notes: input.notes ?? null,
          createdById: actor.id,
        },
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'production.create',
        entity: 'production_orders',
        entityId: order.id,
        after: {
          code: productionOrderCode(order.seq),
          productId: product.id,
          bomId: bom.id,
          targetPieces: order.targetPieces,
        },
      });
      return order.id;
    });

    return this.findOne(orderId);
  }

  // -------------------------------------------------------------------------
  // Consumir (asignar) un fleje a la orden
  // -------------------------------------------------------------------------

  /**
   * Pone un fleje a disposición de la OP. **No mueve kardex** (D-060): el fleje sigue en
   * el almacén hasta que un reporte de piezas lo consuma. Desde acá y hasta que la OP se
   * cierre, se anule o lo libere, ese fleje queda bloqueado para cualquier otra operación
   * (merma, partido, anulación, corte, otra OP).
   */
  async consume(
    actor: RequestUser,
    orderId: string,
    input: ConsumeStripInput,
  ): Promise<ProductionOrderDto> {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, orderId);
      this.assertLive(order, 'consumir flejes');

      const bom = await tx.productBom.findUniqueOrThrow({
        where: { id: order.bomId },
        include: { finish: { select: { code: true } } },
      });
      const coil = await this.coils.lockCoil(tx, input.coilId);

      if (coil.kind !== CoilKind.STRIP) {
        throw new BadRequestException(
          `${coil.code} es una bobina, no un fleje: la perfiladora de drywall consume flejes (D-049)`,
        );
      }
      if (coil.status !== CoilStatus.OPEN) {
        throw new BadRequestException(
          `${coil.code} no está disponible (${coil.status}): solo un fleje abierto entra a producción`,
        );
      }
      if (coil.businessLineId !== order.businessLineId) {
        throw new BadRequestException(
          `${coil.code} es de otra línea de negocio que la orden de producción`,
        );
      }
      // RF-32 en su versión de drywall: una corrida no mezcla material. La receta fija
      // acabado, espesor y ancho exactos; con otro fleje el kilo teórico por pieza —y con
      // él la merma y el costo— dejarían de significar nada.
      if (
        coil.finishId !== bom.finishId ||
        !coil.thicknessMm.equals(bom.inputThicknessMm) ||
        !coil.widthMm.equals(bom.inputWidthMm)
      ) {
        throw new BadRequestException(
          `${coil.code} no coincide con la receta del producto: se necesita un fleje de acabado ${bom.finish.code}, ${bom.inputThicknessMm.toFixed(2)} mm de espesor y ${bom.inputWidthMm.toFixed(2)} mm de ancho`,
        );
      }

      const assigned = await findLiveStripAssignments(tx, [coil.id]);
      const taken = assigned[0];
      if (taken) {
        throw new BadRequestException(
          taken.orderId === orderId
            ? `${coil.code} ya está asignado a esta orden`
            : `${coil.code} ya está asignado a la orden de producción ${taken.orderCode}`,
        );
      }

      const liveCount = await tx.productionOrderConsumption.count({
        where: { productionOrderId: orderId, releasedAt: null },
      });
      if (liveCount >= MAX_ORDER_STRIPS) {
        throw new BadRequestException(
          `Una orden admite hasta ${MAX_ORDER_STRIPS} flejes a la vez: cierra esta y abre otra`,
        );
      }

      const balance = await tx.inventoryBalance.findUnique({
        where: { itemType_itemId: { itemType: 'COIL', itemId: coil.id } },
      });
      const availableKg = toDecimal(balance?.qty.toString() ?? '0');
      if (availableKg.lte(0)) {
        throw new BadRequestException(`${coil.code} no tiene kilos disponibles en el kardex`);
      }
      const assignedKg = input.qtyKg ? toDecimal(input.qtyKg) : availableKg;
      if (assignedKg.gt(availableKg)) {
        throw new BadRequestException(
          `${coil.code} tiene ${availableKg.toFixed(3)} kg disponibles y se intentan tomar ${assignedKg.toFixed(3)} kg`,
        );
      }

      const consumption = await tx.productionOrderConsumption.create({
        data: {
          productionOrderId: orderId,
          coilId: coil.id,
          assignedKg: toFixedString(assignedKg, 'KG'),
          createdById: actor.id,
        },
      });
      await tx.productionOrder.update({
        where: { id: orderId },
        data: { status: ProductionOrderStatus.IN_PROGRESS },
      });

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'production.consume',
        entity: 'production_orders',
        entityId: orderId,
        after: {
          consumptionId: consumption.id,
          coilId: coil.id,
          coilCode: coil.code,
          assignedKg: toFixedString(assignedKg, 'KG'),
        },
      });
    });

    return this.findOne(orderId);
  }

  /** Devolver un fleje asignado por error. Solo si todavía no consumió nada. */
  async release(
    actor: RequestUser,
    orderId: string,
    consumptionId: string,
  ): Promise<ProductionOrderDto> {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, orderId);
      this.assertLive(order, 'liberar un fleje');

      const consumption = await tx.productionOrderConsumption.findFirst({
        where: { id: consumptionId, productionOrderId: orderId },
        include: { coil: { select: { code: true } } },
      });
      if (!consumption) throw new NotFoundException('Ese fleje no pertenece a la orden');
      if (consumption.releasedAt) {
        throw new BadRequestException('Ese fleje ya fue liberado de la orden');
      }
      if (toDecimal(consumption.consumedKg.toString()).gt(0)) {
        throw new BadRequestException(
          `${consumption.coil.code} ya alimentó piezas reportadas (${consumption.consumedKg.toFixed(3)} kg): revierte esos reportes antes de liberarlo`,
        );
      }

      await tx.productionOrderConsumption.update({
        where: { id: consumption.id },
        data: { releasedAt: new Date() },
      });
      await this.recomputeStatus(tx, orderId);

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'production.release',
        entity: 'production_orders',
        entityId: orderId,
        after: { consumptionId, coilCode: consumption.coil.code },
      });
    });

    return this.findOne(orderId);
  }

  // -------------------------------------------------------------------------
  // D-058 — reportar piezas (parcial, N veces)
  // -------------------------------------------------------------------------

  /**
   * Registra piezas buenas y su kardex: salida de los flejes por los kilos teóricos que
   * esas piezas consumen (`piezas × kgPerPiece`, D-047) y entrada de las piezas al
   * producto terminado valorizada **exactamente** por lo que salió de los flejes, así el
   * valor no se crea ni se destruye entre las dos puntas del movimiento.
   */
  async report(
    actor: RequestUser,
    orderId: string,
    input: ReportPiecesInput,
  ): Promise<ProductionOrderDto> {
    await this.prisma.$transaction(
      async (tx) => {
        const order = await this.lockOrder(tx, orderId);
        if (order.status !== ProductionOrderStatus.IN_PROGRESS) {
          throw new BadRequestException(
            order.status === ProductionOrderStatus.DRAFT
              ? 'La orden todavía no tiene ningún fleje: consume material antes de reportar piezas'
              : `La orden está ${order.status === ProductionOrderStatus.CLOSED ? 'cerrada' : 'anulada'}: no admite reportes`,
          );
        }

        const liveReports = await tx.productionReport.count({
          where: { productionOrderId: orderId, status: ProductionReportStatus.ACTIVE },
        });
        if (liveReports >= MAX_ORDER_REPORTS) {
          throw new BadRequestException(
            `La orden ya tiene ${MAX_ORDER_REPORTS} reportes vigentes: ciérrala y abre otra`,
          );
        }

        const bom = await tx.productBom.findUniqueOrThrow({ where: { id: order.bomId } });
        const neededKg = theoreticalKg(input.pieces, bom.kgPerPiece.toFixed(3));

        const rows = await tx.productionOrderConsumption.findMany({
          where: { productionOrderId: orderId, releasedAt: null },
          include: { coil: { select: { code: true } } },
          orderBy: { createdAt: 'asc' },
        });
        const consumedByRow = new Map(
          rows.map((r) => [r.id, toDecimal(r.consumedKg.toString())] as const),
        );
        const allocationRows: StripAllocationRow[] = rows.map((r) => ({
          consumptionId: r.id,
          coilId: r.coilId,
          coilCode: r.coil.code,
          remainingKg: toDecimal(r.assignedKg.toString()).minus(
            consumedByRow.get(r.id) ?? new Decimal(0),
          ),
        }));
        const allocations = allocateStripKg(allocationRows, neededKg);

        const report = await tx.productionReport.create({
          data: {
            productionOrderId: orderId,
            pieces: input.pieces,
            theoreticalKg: toFixedString(neededKg, 'KG'),
            materialCostPen: '0',
            unitCostPen: '0',
            notes: input.notes ?? null,
            createdById: actor.id,
          },
        });

        let materialCostPen = new Decimal(0);
        for (const allocation of allocations) {
          await this.coils.lockCoil(tx, allocation.coilId);
          const out = await this.inventory.record(tx, {
            businessLineId: order.businessLineId,
            itemType: 'COIL',
            itemId: allocation.coilId,
            type: 'OUT',
            qty: toFixedString(allocation.kg, 'KG'),
            unit: Unit.KGM,
            refType: 'PRODUCTION',
            refId: report.id,
            notes: `Consumo de ${productionOrderCode(order.seq)}: ${input.pieces} piezas`,
            actorId: actor.id,
          });
          if (!out) {
            throw new BadRequestException('La línea de negocio de la orden no lleva inventario');
          }
          materialCostPen = materialCostPen.plus(toDecimal(out.totalCost.toString()));

          const alreadyConsumed = consumedByRow.get(allocation.consumptionId) ?? new Decimal(0);
          await tx.productionOrderConsumption.update({
            where: { id: allocation.consumptionId },
            data: { consumedKg: toFixedString(alreadyConsumed.plus(allocation.kg), 'KG') },
          });
        }

        // D-055: el producto terminado entra en PIEZAS. El costo unitario es el material
        // que acaba de salir de los flejes dividido entre las piezas de este reporte; el
        // residuo de redondeo de esa división lo reconcilia el ajuste del cierre.
        const unitCostPen = materialCostPen.div(input.pieces);
        const entry = await this.inventory.record(tx, {
          businessLineId: order.businessLineId,
          itemType: 'PRODUCT',
          itemId: order.productId,
          type: 'IN',
          qty: String(input.pieces),
          unit: Unit.NIU,
          unitCost: toFixedString(unitCostPen, 'MONEY'),
          refType: 'PRODUCTION',
          refId: report.id,
          notes: `${productionOrderCode(order.seq)}: ${input.pieces} piezas producidas`,
          actorId: actor.id,
        });
        if (!entry) {
          throw new BadRequestException('La línea de negocio de la orden no lleva inventario');
        }

        await tx.productionReport.update({
          where: { id: report.id },
          data: {
            materialCostPen: toFixedString(materialCostPen, 'MONEY'),
            unitCostPen: toFixedString(unitCostPen, 'MONEY'),
          },
        });

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'production.report',
          entity: 'production_orders',
          entityId: orderId,
          after: {
            reportId: report.id,
            pieces: input.pieces,
            theoreticalKg: toFixedString(neededKg, 'KG'),
            materialCostPen: toFixedString(materialCostPen, 'MONEY'),
            strips: allocations.map((a) => `${a.coilCode}: ${a.kg.toFixed(3)} kg`),
          },
        });
      },
      { timeout: 30_000 },
    );

    return this.findOne(orderId);
  }

  // -------------------------------------------------------------------------
  // D-060 — revertir un reporte de piezas (simétrico a RF-16 y a Fase 3b)
  // -------------------------------------------------------------------------

  /**
   * Deshace un reporte entero: saca las piezas del producto terminado y devuelve los
   * kilos a los flejes de la orden. Mismo criterio "todo o nada" que RF-16 y que
   * `CuttingService.reverse()`: si las piezas ya se movieron (una venta, otra producción,
   * una merma), falla completa en vez de dejar el kardex a mitad de camino.
   *
   * Solo se revierte el **último** reporte vivo de la orden: los reportes se apilan sobre
   * los mismos flejes, así que deshacer uno del medio dejaría los kilos consumidos de las
   * filas de asignación contando una historia que no ocurrió.
   */
  async reverseReport(
    actor: RequestUser,
    orderId: string,
    reportId: string,
    reason: string,
  ): Promise<ProductionOrderDto> {
    await this.prisma.$transaction(
      async (tx) => {
        const order = await this.lockOrder(tx, orderId);
        if (order.status !== ProductionOrderStatus.IN_PROGRESS) {
          throw new BadRequestException(
            order.status === ProductionOrderStatus.CLOSED
              ? 'La orden está cerrada: reábrela primero para poder corregir sus reportes'
              : `La orden está ${order.status === ProductionOrderStatus.CANCELLED ? 'anulada' : 'en borrador'}: no tiene reportes que revertir`,
          );
        }

        const report = await tx.productionReport.findFirst({
          where: { id: reportId, productionOrderId: orderId },
        });
        if (!report) throw new NotFoundException('Ese reporte no pertenece a la orden');
        if (report.status !== ProductionReportStatus.ACTIVE) {
          throw new BadRequestException('Ese reporte ya fue revertido');
        }

        // Por `seq`, no por `createdAt`: en Postgres `now()` es el instante en que empezó
        // la transacción, así que dos reportes concurrentes pueden empatar en fecha y
        // "el último" dejaría de estar definido justo cuando importa.
        const later = await tx.productionReport.findFirst({
          where: {
            productionOrderId: orderId,
            status: ProductionReportStatus.ACTIVE,
            seq: { gt: report.seq },
          },
          orderBy: { seq: 'asc' },
        });
        if (later) {
          throw new BadRequestException(
            `Hay reportes posteriores vigentes (${later.pieces} piezas del ${later.createdAt.toISOString().slice(0, 10)}): revierte el último primero`,
          );
        }

        const all = await tx.inventoryMovement.findMany({
          where: { refType: 'PRODUCTION', refId: reportId },
          orderBy: { id: 'asc' },
          include: { reversals: { select: { id: true } } },
        });
        const movements = liveMovements(all);
        const entry = movements.find((m) => m.itemType === 'PRODUCT' && m.type === 'IN');
        if (!entry) {
          throw new BadRequestException('Ese reporte no tiene un ingreso de piezas que revertir');
        }
        const stripOuts = movements.filter((m) => m.itemType === 'COIL' && m.type === 'OUT');

        // Las piezas son fungibles: el saldo del producto lo comparten todas las OP, así
        // que "movimientos posteriores" a secas sería demasiado estricto — otro reporte
        // del mismo perfil es inofensivo. Lo que sí bloquea es que después hayan **salido**
        // piezas (una venta, una merma: pudieron ser justo las de este reporte) o que haya
        // entrado un **ajuste de costo** (el cierre de otra OP, D-056): ese ajuste se
        // repartió sobre un saldo que incluía estas piezas, y sacarlas ahora dejaría a las
        // que quedan cargando un promedio que nunca les correspondió.
        const productAfter = await tx.inventoryMovement.findMany({
          where: { itemType: 'PRODUCT', itemId: order.productId, id: { gt: entry.id } },
          orderBy: { id: 'asc' },
          include: { reversals: { select: { id: true } } },
        });
        const blocking = liveMovements(productAfter).find((m) => m.type !== 'IN');
        if (blocking) {
          throw new BadRequestException(
            `Las piezas de este reporte ya se movieron (${blocking.type} ${blocking.refType}): anula ese movimiento antes de revertir el reporte`,
          );
        }

        // Primero salen las piezas y después vuelven los kilos: al revés, los flejes
        // recuperarían material que las piezas todavía están representando.
        await this.inventory.reverse(tx, entry.id, actor.id, reason);

        const rows = await tx.productionOrderConsumption.findMany({
          where: { productionOrderId: orderId },
          orderBy: [{ releasedAt: 'asc' }, { createdAt: 'asc' }],
        });
        for (const movement of stripOuts) {
          await this.coils.lockCoil(tx, movement.itemId);
          await this.inventory.reverse(tx, movement.id, actor.id, reason);
          // Una bobina solo puede tener una asignación viva a la vez (el guardrail lo
          // impide), así que el fleje identifica sin ambigüedad la fila a descontar.
          const row = rows.find((r) => r.coilId === movement.itemId && r.releasedAt === null);
          if (!row) {
            throw new BadRequestException(
              'El fleje de este reporte ya no está asignado a la orden: no se puede revertir',
            );
          }
          await tx.productionOrderConsumption.update({
            where: { id: row.id },
            data: {
              consumedKg: toFixedString(
                toDecimal(row.consumedKg.toString()).minus(toDecimal(movement.qty.toString())),
                'KG',
              ),
            },
          });
        }

        await tx.productionReport.update({
          where: { id: reportId },
          data: {
            status: ProductionReportStatus.REVERTED,
            revertedById: actor.id,
            revertedAt: new Date(),
          },
        });
        await this.recomputeStatus(tx, orderId);

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'production.report-reverse',
          entity: 'production_orders',
          entityId: orderId,
          before: { reportId, pieces: report.pieces },
          after: { reportId, status: ProductionReportStatus.REVERTED, reason },
        });
      },
      { timeout: 30_000 },
    );

    return this.findOne(orderId);
  }

  // -------------------------------------------------------------------------
  // D-057 / D-056 — cerrar: merma por diferencia y costeo
  // -------------------------------------------------------------------------

  /**
   * Cierra la corrida. Lo que quedó asignado y no llegó a ser pieza buena sale como
   * **merma de proceso** (`OUT refType=SCRAP`, D-040), y todo el material que salió —el
   * que quedó en piezas y el de la merma— se reparte entre las piezas buenas con un
   * `ADJUST` sobre el producto terminado (D-043 usa el mismo mecanismo para el landed
   * cost). Así el kardex cierra exacto: lo que salió de los flejes es lo que entró a las
   * piezas.
   */
  async close(
    actor: RequestUser,
    orderId: string,
    input: CloseProductionOrderInput,
  ): Promise<ProductionOrderDto> {
    await this.prisma.$transaction(
      async (tx) => {
        const order = await this.lockOrder(tx, orderId);
        if (order.status !== ProductionOrderStatus.IN_PROGRESS) {
          throw new BadRequestException(
            order.status === ProductionOrderStatus.DRAFT
              ? 'La orden no tiene material ni piezas: anúlala en vez de cerrarla'
              : `La orden ya está ${order.status === ProductionOrderStatus.CLOSED ? 'cerrada' : 'anulada'}`,
          );
        }

        const reports = await tx.productionReport.findMany({
          where: { productionOrderId: orderId, status: ProductionReportStatus.ACTIVE },
        });
        if (reports.length === 0) {
          throw new BadRequestException(
            'La orden no tiene piezas reportadas: anúlala para liberar los flejes en vez de cerrarla',
          );
        }

        const rows = await tx.productionOrderConsumption.findMany({
          where: { productionOrderId: orderId, releasedAt: null },
          include: { coil: { select: { code: true } } },
          orderBy: { createdAt: 'asc' },
        });

        // La merma que va a salir se conoce antes de emitirla: si es una fracción grande
        // del material asignado, el cierre deja de ser "lo que sobró de la corrida" y pasa
        // a ser una baja de inventario, que como cualquier merma exige motivo (RF-17,
        // D-040) para quedar auditable (RF-95).
        const assignedKg = rows.reduce(
          (acc, r) => acc.plus(toDecimal(r.assignedKg.toString())),
          new Decimal(0),
        );
        const plannedScrapKg = rows.reduce(
          (acc, r) =>
            acc.plus(
              Decimal.max(
                toDecimal(r.assignedKg.toString()).minus(toDecimal(r.consumedKg.toString())),
                new Decimal(0),
              ),
            ),
          new Decimal(0),
        );
        const scrapRatio = assignedKg.lte(0) ? new Decimal(0) : plannedScrapKg.div(assignedKg);
        if (!input.reason && scrapRatio.gt(MAX_SCRAP_RATIO_WITHOUT_REASON)) {
          throw new BadRequestException(
            `El cierre deja ${plannedScrapKg.toFixed(3)} kg de merma sobre ${assignedKg.toFixed(3)} kg asignados (${scrapRatio.times(100).toFixed(1)} %): explica el motivo para cerrar con esa merma`,
          );
        }

        let scrapKg = new Decimal(0);
        let scrapCostPen = new Decimal(0);
        const scrapped: string[] = [];
        // Un solo instante para el cierre y para la liberación de sus flejes: es lo que
        // le permite a `reopen` distinguir los flejes que soltó el cierre de los que el
        // operario había liberado a mano antes, que no deben volver a la orden.
        const closedAt = new Date();
        for (const row of rows) {
          const remaining = toDecimal(row.assignedKg.toString()).minus(
            toDecimal(row.consumedKg.toString()),
          );
          if (remaining.gt(0)) {
            await this.coils.lockCoil(tx, row.coilId);
            const out = await this.inventory.record(tx, {
              businessLineId: order.businessLineId,
              itemType: 'COIL',
              itemId: row.coilId,
              type: 'OUT',
              qty: toFixedString(remaining, 'KG'),
              unit: Unit.KGM,
              refType: 'SCRAP',
              refId: orderId,
              notes: input.reason
                ? `Merma de proceso al cerrar ${productionOrderCode(order.seq)}: ${input.reason}`
                : `Merma de proceso al cerrar ${productionOrderCode(order.seq)}`,
              actorId: actor.id,
            });
            if (!out) {
              throw new BadRequestException('La línea de negocio de la orden no lleva inventario');
            }
            scrapKg = scrapKg.plus(remaining);
            scrapCostPen = scrapCostPen.plus(toDecimal(out.totalCost.toString()));
            scrapped.push(`${row.coil.code}: ${remaining.toFixed(3)} kg`);
          }
          await tx.productionOrderConsumption.update({
            where: { id: row.id },
            data: { consumedKg: row.assignedKg, releasedAt: closedAt },
          });
        }

        const pieces = reports.reduce((acc, r) => acc + r.pieces, 0);
        const reportsCostPen = reports.reduce(
          (acc, r) => acc.plus(toDecimal(r.materialCostPen.toString())),
          new Decimal(0),
        );
        const cost = productionCost({
          reportsCostPen,
          scrapCostPen,
          pieces,
        });

        const adjustPen = closeAdjustmentPen(
          cost.totalCostPen,
          reports.map((r) => ({ pieces: r.pieces, unitCostPen: r.unitCostPen.toFixed(4) })),
        );
        let adjusted: InventoryMovement | null = null;
        if (!adjustPen.isZero()) {
          adjusted = await this.inventory.adjustCost(tx, {
            businessLineId: order.businessLineId,
            itemType: 'PRODUCT',
            itemId: order.productId,
            unit: Unit.NIU,
            amountPen: toFixedString(adjustPen, 'MONEY'),
            refType: 'PRODUCTION',
            refId: orderId,
            notes: `Cierre de ${productionOrderCode(order.seq)}: merma de proceso ${scrapKg.toFixed(3)} kg imputada a ${pieces} piezas`,
            actorId: actor.id,
          });
        }

        await tx.productionOrder.update({
          where: { id: orderId },
          data: {
            status: ProductionOrderStatus.CLOSED,
            scrapKg: toFixedString(scrapKg, 'KG'),
            materialCostPen: toFixedString(cost.materialCostPen, 'MONEY'),
            overheadCostPen: toFixedString(cost.overheadCostPen, 'MONEY'),
            totalCostPen: toFixedString(cost.totalCostPen, 'MONEY'),
            unitCostPen: toFixedString(cost.unitCostPen, 'MONEY'),
            notes: input.notes ?? order.notes,
            closedById: actor.id,
            closedAt,
          },
        });

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'production.close',
          entity: 'production_orders',
          entityId: orderId,
          before: { status: order.status },
          after: {
            status: ProductionOrderStatus.CLOSED,
            pieces,
            scrapKg: toFixedString(scrapKg, 'KG'),
            // El ratio queda en la auditoría para poder alertar sobre corridas con merma
            // anómala sin tener que recalcularlo desde el kardex (RF-95).
            scrapRatioPct: scrapRatio.times(100).toFixed(2),
            scrapReason: input.reason ?? null,
            scrapped,
            materialCostPen: toFixedString(cost.materialCostPen, 'MONEY'),
            unitCostPen: toFixedString(cost.unitCostPen, 'MONEY'),
            // `null` cuando el producto ya no tenía saldo: el costo no tiene dónde
            // imputarse y reescribir el pasado no es opción (mismo criterio que D-043).
            costAdjusted: adjusted !== null,
          },
        });
      },
      { timeout: 60_000 },
    );

    return this.findOne(orderId);
  }

  // -------------------------------------------------------------------------
  // D-060 — reabrir una orden cerrada (reversa del cierre)
  // -------------------------------------------------------------------------

  /**
   * Deshace el cierre: revierte el ajuste de costo del producto terminado y la merma de
   * proceso, y devuelve los flejes a la orden, que vuelve a `IN_PROGRESS`. Desde ahí se
   * pueden revertir los reportes y, si hace falta, anularla.
   *
   * Sin esto una OP cerrada sería irreversible y el hueco de la reversa volvería a
   * quedar para una fase siguiente, que es justo lo que Fase 3 → 3b enseñó a no hacer.
   * Guardrails con el mismo criterio conservador de D-052: si las piezas ya se movieron
   * o si algún fleje se movió después del cierre, falla completa en vez de dejar el
   * kardex a mitad de camino.
   */
  async reopen(actor: RequestUser, orderId: string, reason: string): Promise<ProductionOrderDto> {
    await this.prisma.$transaction(
      async (tx) => {
        const order = await this.lockOrder(tx, orderId);
        if (order.status !== ProductionOrderStatus.CLOSED) {
          throw new BadRequestException(
            order.status === ProductionOrderStatus.CANCELLED
              ? 'La orden está anulada: no hay cierre que deshacer'
              : 'La orden todavía no está cerrada',
          );
        }

        const own = await tx.inventoryMovement.findMany({
          where: {
            refId: orderId,
            refType: { in: ['PRODUCTION', 'SCRAP'] },
          },
          orderBy: { id: 'asc' },
          include: { reversals: { select: { id: true } } },
        });
        const movements = liveMovements(own);
        const adjust = movements.find((m) => m.itemType === 'PRODUCT' && m.type === 'ADJUST');
        const scrapOuts = movements.filter((m) => m.itemType === 'COIL' && m.type === 'OUT');

        // El ajuste de costo se repartió sobre el saldo de piezas del momento del cierre:
        // si después salieron piezas o entró otro ajuste (el cierre de otra OP del mismo
        // perfil), revertirlo dejaría el promedio contando algo que ya no es cierto.
        if (adjust) {
          const after = await tx.inventoryMovement.findMany({
            where: { itemType: 'PRODUCT', itemId: order.productId, id: { gt: adjust.id } },
            orderBy: { id: 'asc' },
            include: { reversals: { select: { id: true } } },
          });
          const blocking = liveMovements(after).find((m) => m.type !== 'IN');
          if (blocking) {
            throw new BadRequestException(
              `Las piezas de esta orden ya se movieron (${blocking.type} ${blocking.refType}): anula ese movimiento antes de reabrirla`,
            );
          }
        }

        // Solo vuelven a la orden los flejes que soltó el **cierre** (su `releasedAt` es
        // el mismo instante que el `closedAt` de la orden): los que el operario liberó a
        // mano antes ya no son suyos y no tienen por qué volver.
        const rows = await tx.productionOrderConsumption.findMany({
          where: { productionOrderId: orderId, releasedAt: order.closedAt },
          include: { coil: { select: { code: true, status: true } } },
          orderBy: { createdAt: 'asc' },
        });
        // Cerrar libera los flejes: entre el cierre y la reapertura pudieron irse a otra
        // orden (D-060) o moverse en el kardex, y en cualquiera de los dos casos volver a
        // tomarlos acá inventariaría kilos que ya no están donde esta orden cree.
        await assertStripsNotAssigned(
          tx,
          rows.map((r) => r.coilId),
          'reabrir la orden',
        );
        const lastOwnByCoil = new Map<string, bigint>();
        for (const movement of own) {
          const current = lastOwnByCoil.get(movement.itemId);
          if (movement.itemType === 'COIL' && (current === undefined || movement.id > current)) {
            lastOwnByCoil.set(movement.itemId, movement.id);
          }
        }
        for (const row of rows) {
          await this.coils.lockCoil(tx, row.coilId);
          // Mismo requisito que `consume`: la orden vuelve a quedarse con el fleje, y
          // `report` no revalida su estado. Un fleje que se cerró (RF-19) o se anuló
          // (RF-21) mientras la OP estaba cerrada no puede volver a producción.
          if (row.coil.status !== CoilStatus.OPEN) {
            throw new BadRequestException(
              `El fleje ${row.coil.code} ya no está disponible (${row.coil.status}): no se puede reabrir la orden`,
            );
          }
          // Los flejes que se consumieron enteros no dejaron merma, así que no hay
          // movimiento propio del cierre contra el cual medir "posterior": ahí la
          // referencia es el `closedAt` de la orden. Saltarlos —como hacía la primera
          // versión— dejaba volver a la orden un fleje que se partió o se mermó entre
          // medio.
          const lastOwn = lastOwnByCoil.get(row.coilId);
          const after = await tx.inventoryMovement.findMany({
            where: {
              itemType: 'COIL',
              itemId: row.coilId,
              ...(lastOwn === undefined
                ? { at: { gt: order.closedAt ?? new Date(0) } }
                : { id: { gt: lastOwn } }),
            },
            orderBy: { id: 'asc' },
            include: { reversals: { select: { id: true } } },
          });
          const blocking = liveMovements(after)[0];
          if (blocking) {
            throw new BadRequestException(
              `El fleje ${row.coil.code} ya tiene movimientos posteriores al cierre (${blocking.refType}): anúlalos antes de reabrir la orden`,
            );
          }
        }

        // Primero el costo y después el material: al revés, el ajuste se prorratearía
        // sobre un saldo que la merma devuelta todavía no terminó de acomodar.
        if (adjust) await this.inventory.reverse(tx, adjust.id, actor.id, reason);
        const returnedByCoil = new Map<string, Decimal>();
        for (const movement of scrapOuts) {
          await this.coils.lockCoil(tx, movement.itemId);
          await this.inventory.reverse(tx, movement.id, actor.id, reason);
          returnedByCoil.set(
            movement.itemId,
            (returnedByCoil.get(movement.itemId) ?? new Decimal(0)).plus(
              toDecimal(movement.qty.toString()),
            ),
          );
        }

        for (const row of rows) {
          const returned = returnedByCoil.get(row.coilId) ?? new Decimal(0);
          await tx.productionOrderConsumption.update({
            where: { id: row.id },
            data: {
              releasedAt: null,
              consumedKg: toFixedString(toDecimal(row.consumedKg.toString()).minus(returned), 'KG'),
            },
          });
        }

        await tx.productionOrder.update({
          where: { id: orderId },
          data: {
            status: ProductionOrderStatus.IN_PROGRESS,
            scrapKg: null,
            materialCostPen: null,
            overheadCostPen: null,
            totalCostPen: null,
            unitCostPen: null,
            closedById: null,
            closedAt: null,
          },
        });

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'production.reopen',
          entity: 'production_orders',
          entityId: orderId,
          before: { status: ProductionOrderStatus.CLOSED },
          after: {
            status: ProductionOrderStatus.IN_PROGRESS,
            reason,
            revertedScrapMovements: scrapOuts.length,
            revertedCostAdjustment: adjust !== undefined,
          },
        });
      },
      { timeout: 60_000 },
    );

    return this.findOne(orderId);
  }

  // -------------------------------------------------------------------------
  // Anular la orden
  // -------------------------------------------------------------------------

  /**
   * Anula la OP y libera los flejes que tomó. Solo con **cero reportes vivos**: si ya
   * produjo piezas, hay que revertir esos reportes primero — anular con producción viva
   * dejaría en el kardex piezas sin la orden que las explique.
   *
   * Como asignar no mueve kardex (D-060), anular tampoco tiene nada que revertir: los
   * flejes vuelven a estar disponibles tal como estaban. Mismo comportamiento que
   * `CuttingService.cancel` sobre un envío `SENT` (D-050).
   */
  async cancel(
    actor: RequestUser,
    orderId: string,
    input: CancelProductionOrderInput,
  ): Promise<ProductionOrderDto> {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, orderId);
      this.assertLive(order, 'anularla');

      const live = await tx.productionReport.findMany({
        where: { productionOrderId: orderId, status: ProductionReportStatus.ACTIVE },
        select: { pieces: true },
      });
      if (live.length > 0) {
        const pieces = live.reduce((acc, r) => acc + r.pieces, 0);
        throw new BadRequestException(
          `La orden tiene ${live.length} reporte(s) vigente(s) con ${pieces} piezas: revierte esos reportes antes de anularla`,
        );
      }

      const released = await tx.productionOrderConsumption.updateMany({
        where: { productionOrderId: orderId, releasedAt: null },
        data: { releasedAt: new Date() },
      });
      await tx.productionOrder.update({
        where: { id: orderId },
        data: {
          status: ProductionOrderStatus.CANCELLED,
          cancelledById: actor.id,
          cancelledAt: new Date(),
        },
      });

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'production.cancel',
        entity: 'production_orders',
        entityId: orderId,
        before: { status: order.status },
        after: {
          status: ProductionOrderStatus.CANCELLED,
          reason: input.reason,
          releasedStrips: released.count,
        },
      });
    });

    return this.findOne(orderId);
  }

  // -------------------------------------------------------------------------
  // Consultas
  // -------------------------------------------------------------------------

  async findAll(query: ProductionOrderQuery): Promise<ProductionOrderListItemDto[]> {
    const orders = await this.prisma.productionOrder.findMany({
      where: {
        status: query.status,
        productId: query.productId,
        businessLine: query.businessLine
          ? { code: toPrismaLineCode(query.businessLine) }
          : undefined,
      },
      include: LIST_RELATIONS,
      orderBy: { seq: 'desc' },
      take: 500,
    });
    const actors = await this.resolveActorNames(orders.map((o) => o.createdById));
    return orders.map((order) => this.toListItem(order, actors));
  }

  async findOne(id: string): Promise<ProductionOrderDto> {
    const order = await this.prisma.productionOrder.findUnique({
      where: { id },
      include: ORDER_RELATIONS,
    });
    if (!order) throw new NotFoundException('Orden de producción no encontrada');

    const balances = await this.prisma.inventoryBalance.findMany({
      where: { itemType: 'COIL', itemId: { in: order.consumptions.map((c) => c.coilId) } },
      select: { itemId: true, qty: true },
    });
    const availableKg = new Map(balances.map((b) => [b.itemId, b.qty.toFixed(3)]));
    const actors = await this.resolveActorNames([
      order.createdById,
      ...order.reports.map((r) => r.createdById),
    ]);

    return {
      ...this.toListItem(order, actors),
      bom: bomToDto(order.bom),
      consumptions: order.consumptions.map((c) => ({
        id: c.id,
        coilId: c.coilId,
        coilCode: c.coil.code,
        widthMm: c.coil.widthMm.toFixed(2),
        assignedKg: c.assignedKg.toFixed(3),
        consumedKg: c.consumedKg.toFixed(3),
        remainingKg: toFixedString(
          toDecimal(c.assignedKg.toString()).minus(toDecimal(c.consumedKg.toString())),
          'KG',
        ),
        coilAvailableKg: availableKg.get(c.coilId) ?? '0.000',
        parentCoilId: c.coil.parentCoilId,
        parentCoilCode: c.coil.parentCoil?.code ?? null,
        releasedAt: c.releasedAt ? c.releasedAt.toISOString() : null,
        createdAt: c.createdAt.toISOString(),
      })),
      reports: order.reports.map((r) => ({
        id: r.id,
        pieces: r.pieces,
        theoreticalKg: r.theoreticalKg.toFixed(3),
        materialCostPen: r.materialCostPen.toFixed(4),
        unitCostPen: r.unitCostPen.toFixed(4),
        status: r.status,
        notes: r.notes,
        createdAt: r.createdAt.toISOString(),
        createdByName: actors.get(r.createdById) ?? null,
        revertedAt: r.revertedAt ? r.revertedAt.toISOString() : null,
      })),
    };
  }

  /**
   * Flejes que `/planta` puede ofrecer para una OP: los que coinciden con la receta, con
   * saldo, abiertos y que ninguna otra orden tiene tomados (D-060).
   */
  async stripOptions(productId: string): Promise<ProductionStripOptionDto[]> {
    const bom = await this.boms.requireActiveBom(productId);
    const coils = await this.prisma.coil.findMany({
      where: {
        kind: CoilKind.STRIP,
        status: CoilStatus.OPEN,
        businessLineId: bom.product.businessLineId,
        finishId: bom.finishId,
        thicknessMm: bom.inputThicknessMm,
        widthMm: bom.inputWidthMm,
      },
      select: {
        id: true,
        code: true,
        widthMm: true,
        thicknessMm: true,
        finish: { select: { code: true } },
        parentCoil: { select: { code: true } },
      },
      orderBy: { code: 'asc' },
      take: 500,
    });
    if (coils.length === 0) return [];

    const [balances, assignments] = await Promise.all([
      this.prisma.inventoryBalance.findMany({
        where: { itemType: 'COIL', itemId: { in: coils.map((c) => c.id) } },
        select: { itemId: true, qty: true },
      }),
      findLiveStripAssignments(
        this.prisma,
        coils.map((c) => c.id),
      ),
    ]);
    const qtyById = new Map(balances.map((b) => [b.itemId, toDecimal(b.qty.toString())]));
    const taken = new Set(assignments.map((a) => a.coilId));
    const kgPerPiece = toDecimal(bom.kgPerPiece.toFixed(3));

    return coils
      .filter((c) => !taken.has(c.id) && (qtyById.get(c.id) ?? new Decimal(0)).gt(0))
      .map((c) => {
        const available = qtyById.get(c.id) ?? new Decimal(0);
        return {
          coilId: c.id,
          code: c.code,
          widthMm: c.widthMm.toFixed(2),
          thicknessMm: c.thicknessMm.toFixed(2),
          finishCode: c.finish.code,
          availableKg: available.toFixed(3),
          parentCoilCode: c.parentCoil?.code ?? null,
          estimatedPieces: kgPerPiece.lte(0) ? 0 : available.div(kgPerPiece).floor().toNumber(),
        };
      });
  }

  // -------------------------------------------------------------------------
  // Utilidades comunes
  // -------------------------------------------------------------------------

  private async lockOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<{
    id: string;
    seq: number;
    status: ProductionOrderStatus;
    businessLineId: string;
    productId: string;
    bomId: string;
    notes: string | null;
    closedAt: Date | null;
  }> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "production_orders" WHERE "id" = ${orderId}::uuid FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundException('Orden de producción no encontrada');
    return tx.productionOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        id: true,
        seq: true,
        status: true,
        businessLineId: true,
        productId: true,
        bomId: true,
        notes: true,
        closedAt: true,
      },
    });
  }

  private assertLive(order: { status: ProductionOrderStatus }, action: string): void {
    if (
      order.status === ProductionOrderStatus.CLOSED ||
      order.status === ProductionOrderStatus.CANCELLED
    ) {
      throw new BadRequestException(
        `La orden está ${order.status === ProductionOrderStatus.CLOSED ? 'cerrada' : 'anulada'}: no se puede ${action}`,
      );
    }
  }

  /** `DRAFT` cuando la orden se quedó sin flejes tomados ni piezas vigentes. */
  private async recomputeStatus(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
    const [strips, reports] = await Promise.all([
      tx.productionOrderConsumption.count({
        where: { productionOrderId: orderId, releasedAt: null },
      }),
      tx.productionReport.count({
        where: { productionOrderId: orderId, status: ProductionReportStatus.ACTIVE },
      }),
    ]);
    await tx.productionOrder.update({
      where: { id: orderId },
      data: {
        status:
          strips === 0 && reports === 0
            ? ProductionOrderStatus.DRAFT
            : ProductionOrderStatus.IN_PROGRESS,
      },
    });
  }

  private toListItem(order: OrderForList, actors: Map<string, string>): ProductionOrderListItemDto {
    const live = order.consumptions.filter((c) => c.releasedAt === null);
    const activeReports = order.reports.filter((r) => r.status === ProductionReportStatus.ACTIVE);
    const assignedKg = live.reduce(
      (acc, c) => acc.plus(toDecimal(c.assignedKg.toString())),
      new Decimal(0),
    );
    const consumedKg = order.consumptions.reduce(
      (acc, c) => acc.plus(toDecimal(c.consumedKg.toString())),
      new Decimal(0),
    );

    return {
      id: order.id,
      code: productionOrderCode(order.seq),
      businessLine: toSharedLineCode(order.businessLine.code),
      productId: order.productId,
      productSku: order.product.sku,
      productName: order.product.name,
      status: order.status,
      targetPieces: order.targetPieces,
      reservationId: order.reservationId,
      notes: order.notes,
      piecesReported: activeReports.reduce((acc, r) => acc + r.pieces, 0),
      assignedKg: toFixedString(assignedKg, 'KG'),
      consumedKg: toFixedString(consumedKg, 'KG'),
      scrapKg: order.scrapKg ? order.scrapKg.toFixed(3) : null,
      materialCostPen: order.materialCostPen ? order.materialCostPen.toFixed(4) : null,
      overheadCostPen: order.overheadCostPen ? order.overheadCostPen.toFixed(4) : null,
      totalCostPen: order.totalCostPen ? order.totalCostPen.toFixed(4) : null,
      unitCostPen: order.unitCostPen ? order.unitCostPen.toFixed(4) : null,
      stripCount: live.length,
      createdAt: order.createdAt.toISOString(),
      createdByName: actors.get(order.createdById) ?? null,
      closedAt: order.closedAt ? order.closedAt.toISOString() : null,
      cancelledAt: order.cancelledAt ? order.cancelledAt.toISOString() : null,
    };
  }

  private async resolveActorNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }
}
