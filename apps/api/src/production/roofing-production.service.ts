import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BusinessLineCode,
  CoilKind,
  CoilStatus,
  InventoryItemType,
  ProductionOrderKind,
  ProductionOrderStatus,
  ProductionReportStatus,
  ReservationStatus,
  SalesOrderStatus,
  Prisma,
} from '@prisma/client';
import {
  Decimal,
  describePieces,
  fromDateOnly,
  MAX_ORDER_REPORTS,
  MAX_ORDER_STRIPS,
  MAX_SCRAP_RATIO_WITHOUT_REASON,
  piecesCount,
  piecesFromPlanMeters,
  piecesMeters,
  productionOrderCode,
  remainingPlanPieces,
  roofingPiecesSchema,
  roofingPlanOverrun,
  roofingPlanProgress,
  salesOrderCode,
  thicknessWithinTolerance,
  toDateOnly,
  toDecimal,
  toFixedString,
  Unit,
  type CancelProductionOrderInput,
  type CloseRoofingOrderInput,
  type CreateRoofingOrderInput,
  type CreateRoofingOrdersFromSalesOrderInput,
  type MountRoofingCoilInput,
  type PieceLike,
  type ProductionOrderDto,
  type ReportRoofingBatchInput,
  type ReportRoofingPiecesInput,
  type ReverseMovementInput,
  type RoofingBatchCreateResultDto,
  type RoofingBatchOrderDto,
  type RoofingBatchResultDto,
  type RoofingCoilOptionDto,
  type UpdateRoofingPlanInput,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { CoilsService } from '../coils/coils.service';
import { ENV, type Env } from '../config/env';
import { OperationDateService } from '../common/operation-date.service';
import { roofingCoilWhere, roofingToleranceMm } from './roofing-coil-match';
import { InventoryService } from '../inventory/inventory.service';
import { liveMovements } from '../inventory/live-movements';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoilsNotReserved,
  consumeReservationQty,
  releaseRemainingReservation,
  restoreReservationQty,
} from '../sales/reservation-guard';
import {
  findLineReservation,
  reduceReservation,
  upsertItemReservation,
} from '../sales/reservation-transfer';
import { assertRawMaterialInvariant } from '../sales/raw-material';
import { assertStripsNotAssigned, findLiveStripAssignments } from './production-assignments';
import { allocateStripKg, type StripAllocationRow } from './production-math';
import {
  assertKind,
  assertLive,
  lockOrder,
  recomputeStatus,
  restoreReservationIfIdle,
  type LockedOrder,
} from './production-shared';
import { ProductionService } from './production.service';
import {
  derivePiecesPlan,
  metersFromKg,
  roofingCloseAdjustmentPen,
  roofingCloseScrap,
  roofingCost,
  roofingTheoreticalKg,
  type CoilGeometry,
} from './roofing-math';

/**
 * Producción de coberturas metálicas contra pedido (RF-30..RF-33; D-082..D-091).
 *
 * Ciclo: la OP **nace de la reserva de un pedido** (D-084, y por eso `create` la exige) y
 * copia sus subítems como plan de corte editable → se monta una bobina filtrada por espesor
 * y color (D-086), que es custodia y no mueve kardex (D-060) → se reportan los largos
 * **reales**, y cada reporte emite su kardex completo (salida de la bobina por el kilo
 * teórico de su geometría, entrada del producto en metros o en planchas) → se cierra
 * declarando los kilos que la bobina consumió de verdad, y la diferencia sale como merma de
 * despunte (D-089).
 *
 * Lo que esta rama tiene y drywall no: **la promesa se traslada** (D-088). Cada reporte
 * descuenta de la reserva de bobina los kilos que gastó y abre —o aumenta— una reserva sobre
 * el producto terminado por lo que acaba de fabricar. Las planchas a medida nacen reservadas
 * para el pedido que las encargó, y ninguna otra venta, merma u orden se las puede llevar.
 *
 * Comparte tabla, correlativo, estados y auditoría con `ProductionService` (D-087) y le
 * delega todas las consultas: el listado de `/produccion` y el detalle son los mismos para
 * las dos clases de orden.
 */
@Injectable()
export class RoofingProductionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly coils: CoilsService,
    private readonly production: ProductionService,
    private readonly operationDate: OperationDateService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // -------------------------------------------------------------------------
  // D-084 — la orden nace del pedido, con su plan de corte copiado
  // -------------------------------------------------------------------------

  async create(actor: RequestUser, input: CreateRoofingOrderInput): Promise<ProductionOrderDto> {
    // D-124: fecha en que la corrida arranca. Montar la bobina es custodia, no consumo
    // (D-060), así que crear la OP no mueve kardex y no hay guardrail que aplicar acá.
    const orderOperationDate = this.operationDate.resolve(actor, input.operationDate);
    const orderId = await this.prisma.$transaction(async (tx) => {
      if (input.reservationId === undefined) {
        return this.createToStock(tx, actor, input, orderOperationDate);
      }
      return this.createFromReservationInTx(tx, actor, {
        reservationId: input.reservationId,
        operationDate: orderOperationDate,
        notes: input.notes ?? null,
      });
    });

    return this.production.findOne(orderId);
  }

  /**
   * El cuerpo de `create` cuando la orden nace de una reserva, **dentro de la transacción
   * del llamador** (patrón `*InTx`, D-099).
   *
   * Existe para que la importación de ventas (D-141) cree la OP en la **misma** transacción
   * en la que crea el pedido y su reserva: si abriera la suya, un documento pendiente podría
   * quedar con el pedido y la promesa creados y sin orden en la cola, y nadie se enteraría
   * hasta que planta fuera a buscarla. Es el mismo motivo por el que el mostrador partió
   * `createDirect` en dos (D-099).
   *
   * **No monta ninguna bobina** y no es un olvido: montar es la decisión de planta (D-086),
   * la que elige el rollo físico del agregado que la reserva prometió (D-134). La orden nace
   * `DRAFT` —"en cola"— exactamente igual que la que crea el dueño desde `/planta`.
   */
  async createFromReservationInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    input: { reservationId: string; operationDate: string; notes: string | null },
  ): Promise<string> {
    // Lock antes de mirar: sin él, dos altas concurrentes pasaban las dos el chequeo de
    // "reserva ya tomada" y el material quedaba prometido a dos órdenes.
    await tx.$queryRaw`
        SELECT "id" FROM "reservations" WHERE "id" = ${input.reservationId}::uuid FOR UPDATE
      `;
    const reservation = await tx.reservation.findUnique({
      where: { id: input.reservationId },
      include: {
        salesOrder: { select: { seq: true, status: true } },
        salesOrderItem: {
          include: {
            product: { include: { businessLine: { select: { code: true } } } },
            pieces: { orderBy: { lineNumber: 'asc' } },
          },
        },
      },
    });
    if (!reservation) throw new NotFoundException('Reserva no encontrada');
    if (reservation.status !== ReservationStatus.ACTIVE) {
      throw new BadRequestException(
        reservation.status === ReservationStatus.CONSUMED
          ? 'Esa reserva ya fue consumida'
          : 'Esa reserva está liberada: ya no hay material comprometido que fabricar',
      );
    }
    if (reservation.salesOrder.status === SalesOrderStatus.CANCELLED) {
      throw new BadRequestException('El pedido de esa reserva está anulado');
    }
    // Una OP de coberturas rola materia prima. Si la línea reservó el producto terminado,
    // el material ya existe en el almacén y no hay nada que fabricar: fabricar igual
    // dejaría el pedido prometiendo dos veces el mismo metro.
    //
    // D-134: la reserva que da pie a una OP es la **genérica** (kilos de un agregado), no
    // una bobina concreta. Cuál rollo la cumple lo decide `mountCoil`, que es donde planta
    // toma esa decisión — y es la razón entera del cambio.
    if (reservation.itemType !== InventoryItemType.RAW_MATERIAL) {
      // Esto solo lo alcanza una **plancha de catálogo** (D-127: reserva stock de producto
      // terminado, no materia prima). D-140: una plancha de catálogo **nunca** se fabrica
      // contra el pedido — se vende del saldo que ya hay, y si falta, planta produce a
      // stock por separado (ver `createToStock`) sin que ningún pedido en particular sea
      // el dueño de esa corrida.
      throw new BadRequestException(
        'Esa línea del pedido se atiende con stock de producto terminado, no con producción: ' +
          'una plancha de catálogo se vende del saldo que ya hay y nunca se fabrica contra el ' +
          'pedido (D-140). Si falta stock, producí una orden a stock desde planta; el pedido ' +
          'queda esperando ese saldo.',
      );
    }

    const product = reservation.salesOrderItem.product;
    if (product.businessLine.code !== BusinessLineCode.METALLIC_ROOFING) {
      throw new BadRequestException(
        'La producción de coberturas es de la línea Metallic Roofing (RF-31)',
      );
    }
    if (!product.isActive) throw new BadRequestException('El producto está desactivado');

    // D-122: lo que hace falta para producir una cobertura sale del **producto**: su
    // acabado (y con él la densidad), su espesor, su ancho y su largo. Ya no hay receta.
    const roofing = await this.production.requireRoofingProduct(product.id);

    const taken = await tx.productionOrder.findFirst({
      where: {
        reservationId: input.reservationId,
        status: { in: [ProductionOrderStatus.DRAFT, ProductionOrderStatus.IN_PROGRESS] },
      },
      select: { seq: true },
    });
    if (taken) {
      throw new BadRequestException(
        `La reserva ya está tomada por la orden ${productionOrderCode(taken.seq)}`,
      );
    }

    // D-084: el plan de corte es la copia de lo que el pedido encargó. Una plancha de
    // catálogo no trae subítems (su largo está en el SKU, `products.length_mm` desde
    // D-122), así que el plan se deriva de la cantidad pedida y de ese largo. Misma
    // función que usa la cola de Fase 7 para mostrar los mismos subítems antes de que
    // esta OP exista (D-093).
    const items = derivePiecesPlan(
      reservation.salesOrderItem.pieces.map((p) => ({
        lengthMm: p.lengthMm.toFixed(2),
        qty: p.qty,
      })),
      roofing.lengthMm === null ? null : roofing.lengthMm.toFixed(2),
      reservation.salesOrderItem.qty.toString(),
    );

    const order = await tx.productionOrder.create({
      data: {
        kind: ProductionOrderKind.ROOFING,
        businessLineId: product.businessLineId,
        productId: product.id,
        // D-122: una OP de coberturas ya no nace de una receta.
        bomId: null,
        status: ProductionOrderStatus.DRAFT,
        reservationId: input.reservationId,
        notes: input.notes,
        createdById: actor.id,
        operationDate: toDateOnly(input.operationDate),
        items: { create: items },
      },
    });

    await this.audit.write(tx, {
      actorId: actor.id,
      action: 'production.roofing.create',
      entity: 'production_orders',
      entityId: order.id,
      after: {
        code: productionOrderCode(order.seq),
        kind: ProductionOrderKind.ROOFING,
        productId: product.id,
        reservationId: input.reservationId,
        salesOrder: salesOrderCode(reservation.salesOrder.seq),
        plan: describePieces(items),
      },
    });
    return order.id;
  }

  /**
   * D-140: producir una plancha de catálogo **a stock**, sin pedido detrás. Es la mitad de
   * `create` que no pasa por una reserva: la cotización de esta línea reserva producto
   * terminado (D-127), nunca materia prima, así que nunca hay una reserva genérica de la que
   * nacer. `report` y `close` ya tratan `reservationId` como opcional (D-048/D-093 del lado
   * de drywall, heredado acá); lo único que cambia es de dónde sale el plan de corte.
   */
  private async createToStock(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    input: CreateRoofingOrderInput,
    orderOperationDate: string,
  ): Promise<string> {
    if (input.productId === undefined || input.targetPieces === undefined) {
      throw new BadRequestException(
        'Se necesita un producto de catálogo y una cantidad objetivo para producir a stock',
      );
    }
    const product = await tx.product.findUnique({
      where: { id: input.productId },
      include: { businessLine: { select: { code: true } } },
    });
    if (!product) throw new NotFoundException('Producto no encontrado');
    if (product.businessLine.code !== BusinessLineCode.METALLIC_ROOFING) {
      throw new BadRequestException(
        'La producción de coberturas es de la línea Metallic Roofing (RF-31)',
      );
    }
    if (!product.isActive) throw new BadRequestException('El producto está desactivado');

    const roofing = await this.production.requireRoofingProduct(product.id);
    if (roofing.lengthMm === null) {
      throw new BadRequestException(
        `${roofing.sku} es una cobertura a medida: no tiene largo fijo para producir a stock. ` +
          'Solo se fabrica contra el pedido que reserva el material (RF-31, D-134).',
      );
    }

    // D-084/D-140: mismo plan de una sola línea que ya arma la cola cuando no hay subítems
    // de pedido: el largo del SKU repetido tantas veces como la meta pide.
    const items = derivePiecesPlan([], roofing.lengthMm.toFixed(2), input.targetPieces.toString());

    const order = await tx.productionOrder.create({
      data: {
        kind: ProductionOrderKind.ROOFING,
        businessLineId: product.businessLineId,
        productId: product.id,
        bomId: null,
        status: ProductionOrderStatus.DRAFT,
        reservationId: null,
        // La meta se guarda, no solo se valida: es lo único que dice **por qué** existe esta
        // orden cuando no hay pedido detrás, y es la mitad viva del `CHECK` de D-145. Sin
        // ella `/planta` y `/produccion` mostraban «Meta: —» en la única clase de orden que
        // la tiene por definición (drywall la persiste desde D-048; ver
        // `ProductionService.create`).
        targetPieces: input.targetPieces,
        notes: input.notes ?? null,
        createdById: actor.id,
        operationDate: toDateOnly(orderOperationDate),
        items: { create: items },
      },
    });

    await this.audit.write(tx, {
      actorId: actor.id,
      action: 'production.roofing.create',
      entity: 'production_orders',
      entityId: order.id,
      after: {
        code: productionOrderCode(order.seq),
        kind: ProductionOrderKind.ROOFING,
        productId: product.id,
        reservationId: null,
        targetPieces: input.targetPieces,
        plan: describePieces(items),
      },
    });
    return order.id;
  }

  /**
   * Ajustar el plan de corte (D-084). El techo real se mide en obra: planta corrige los
   * largos antes y durante la corrida. Es una intención — lo que mueve kardex son los largos
   * reportados, así que cambiar el plan no toca ni el kardex ni la reserva.
   */
  async updatePlan(
    actor: RequestUser,
    orderId: string,
    input: UpdateRoofingPlanInput,
  ): Promise<ProductionOrderDto> {
    await this.prisma.$transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      assertKind(order, ProductionOrderKind.ROOFING);
      assertLive(order, 'cambiar el plan de corte');

      const before = await tx.productionOrderItem.findMany({
        where: { productionOrderId: orderId },
        orderBy: { lineNumber: 'asc' },
      });
      await tx.productionOrderItem.deleteMany({ where: { productionOrderId: orderId } });
      await tx.productionOrderItem.createMany({
        data: input.items.map((p, i) => ({
          productionOrderId: orderId,
          lineNumber: i + 1,
          lengthMm: toFixedString(p.lengthMm, 'MM'),
          qty: p.qty,
        })),
      });

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'production.roofing.plan',
        entity: 'production_orders',
        entityId: orderId,
        before: { plan: describePieces(before.map(toPieceLike)) },
        after: {
          plan: describePieces(
            input.items.map((p) => ({ lengthMm: toFixedString(p.lengthMm, 'MM'), qty: p.qty })),
          ),
        },
      });
    });

    return this.production.findOne(orderId);
  }

  // -------------------------------------------------------------------------
  // D-086 — montar la bobina (custodia, sin kardex)
  // -------------------------------------------------------------------------

  async mountCoil(
    actor: RequestUser,
    orderId: string,
    input: MountRoofingCoilInput,
  ): Promise<ProductionOrderDto> {
    // El presupuesto por defecto de Prisma son 5 s, y montar una bobina ya no entra:
    // además del lock y las lecturas de siempre, D-134 agregó la comprobación del agregado,
    // que recorre las bobinas compatibles. Contra Neon —con latencia de red real— se pasaba
    // del límite de forma **intermitente**, y el síntoma era un 500 (`P2028`, "transaction
    // already closed") en el paso más normal de la corrida. Es el mismo tratamiento que ya
    // tienen la anulación de compra y la confirmación de un pedido.
    await this.prisma.$transaction(
      async (tx) => {
        const order = await lockOrder(tx, orderId);
        assertKind(order, ProductionOrderKind.ROOFING);
        assertLive(order, 'montar una bobina');

        const [product, color] = await Promise.all([
          this.production.requireRoofingProduct(order.productId),
          tx.product
            .findUniqueOrThrow({
              where: { id: order.productId },
              select: { color: { select: { name: true } } },
            })
            .then((row) => row.color),
        ]);
        const coil = await this.coils.lockCoil(tx, input.coilId);

        if (coil.kind !== CoilKind.COIL) {
          throw new BadRequestException(
            `${coil.code} es un fleje, no una bobina: la roladora de coberturas consume bobina (D-049)`,
          );
        }
        if (coil.status !== CoilStatus.OPEN) {
          throw new BadRequestException(
            `${coil.code} no está disponible (${coil.status}): solo una bobina abierta entra a producción`,
          );
        }
        if (coil.businessLineId !== order.businessLineId) {
          throw new BadRequestException(
            `${coil.code} es de otra línea de negocio que la orden de producción`,
          );
        }
        // D-086/D-122: espesor dentro de tolerancia contra el espesor **del SKU** (el rollo
        // nunca trae el espesor nominal exacto). Hasta D-122 se comparaba contra el de la
        // receta, que era el mismo dato en otro lugar.
        if (
          !thicknessWithinTolerance(
            coil.thicknessMm.toFixed(2),
            product.thicknessMm.toFixed(2),
            this.thicknessToleranceMm(),
          )
        ) {
          throw new BadRequestException(
            `${coil.code} tiene ${coil.thicknessMm.toFixed(2)} mm de espesor y ${product.sku} necesita ${product.thicknessMm.toFixed(2)} mm (tolerancia ±${this.thicknessToleranceMm()} mm)`,
          );
        }
        // D-085: **igualdad estricta**, null incluido. Con null tratado como comodín, un
        // producto galvanizado aceptaría cualquier rollo prepintado del almacén, que es
        // justo el error que no se puede deshacer una vez rolado.
        if (coil.colorId !== product.colorId) {
          const need = color?.name ?? 'sin color';
          throw new BadRequestException(
            `${coil.code} no coincide en color con ${product.sku}, que necesita ${need}`,
          );
        }

        // D-066: una bobina reservada por un pedido solo la puede montar la OP que nace de ese
        // mismo pedido. Sin la excepción, la reserva se bloquearía a sí misma.
        await assertCoilsNotReserved(
          tx,
          [coil.id],
          'montarla en esta orden',
          order.reservationId ? [order.reservationId] : [],
        );

        const [taken] = await findLiveStripAssignments(tx, [coil.id]);
        if (taken) {
          throw new BadRequestException(
            taken.orderId === orderId
              ? `${coil.code} ya está montada en esta orden`
              : `${coil.code} ya está montada en la orden de producción ${taken.orderCode}`,
          );
        }

        const liveCount = await tx.productionOrderConsumption.count({
          where: { productionOrderId: orderId, releasedAt: null },
        });
        if (liveCount >= MAX_ORDER_STRIPS) {
          throw new BadRequestException(
            `Una orden admite hasta ${MAX_ORDER_STRIPS} bobinas a la vez: ciérrala y abre otra`,
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

        // D-134: montar saca la bobina del disponible del agregado sin mover un gramo de
        // kardex (D-060), así que es exactamente la clase de operación que la invariante por
        // ítem no ve. La reserva de **este** pedido queda exceptuada: es la que esta OP viene
        // a cumplir, y contarla la bloquearía a sí misma. Cualquier otra promesa genérica que
        // quede sin material corta el montaje acá, antes de que nadie role nada.
        await assertRawMaterialInvariant(tx, [coil.id], this.thicknessToleranceMm(), {
          exceptReservationIds: order.reservationId ? [order.reservationId] : [],
        });

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'production.roofing.mount',
          entity: 'production_orders',
          entityId: orderId,
          after: {
            consumptionId: consumption.id,
            coilId: coil.id,
            coilCode: coil.code,
            assignedKg: toFixedString(assignedKg, 'KG'),
          },
        });
      },
      { timeout: 30_000, maxWait: 10_000 },
    );

    return this.production.findOne(orderId);
  }

  /** Bajar una bobina montada por error. Solo si todavía no roló nada. */
  async releaseCoil(
    actor: RequestUser,
    orderId: string,
    consumptionId: string,
  ): Promise<ProductionOrderDto> {
    await this.prisma.$transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      assertKind(order, ProductionOrderKind.ROOFING);
      assertLive(order, 'bajar una bobina');

      const consumption = await tx.productionOrderConsumption.findFirst({
        where: { id: consumptionId, productionOrderId: orderId },
        include: { coil: { select: { code: true } } },
      });
      if (!consumption) throw new NotFoundException('Esa bobina no pertenece a la orden');
      if (consumption.releasedAt) {
        throw new BadRequestException('Esa bobina ya fue bajada de la orden');
      }
      if (toDecimal(consumption.consumedKg.toString()).gt(0)) {
        throw new BadRequestException(
          `${consumption.coil.code} ya alimentó planchas reportadas (${consumption.consumedKg.toFixed(3)} kg): revierte esos reportes antes de bajarla`,
        );
      }

      await tx.productionOrderConsumption.update({
        where: { id: consumption.id },
        data: { releasedAt: new Date() },
      });
      await recomputeStatus(tx, orderId);

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'production.roofing.release',
        entity: 'production_orders',
        entityId: orderId,
        after: { consumptionId, coilCode: consumption.coil.code },
      });
    });

    return this.production.findOne(orderId);
  }

  // -------------------------------------------------------------------------
  // D-083 / D-088 — reportar largos reales
  // -------------------------------------------------------------------------

  /**
   * Registra las planchas que salieron y su kardex: salida de la bobina por los kilos
   * teóricos que esos largos consumen (D-047, con la geometría **de esa bobina**) y entrada
   * del producto terminado valorizada exactamente por lo que salió, así el valor no se crea
   * ni se destruye entre las dos puntas.
   *
   * Y traslada la promesa (D-088): descuenta de la reserva de bobina los kilos gastados y
   * abre —o aumenta— la reserva sobre el producto por lo que acaba de entrar.
   */
  async report(
    actor: RequestUser,
    orderId: string,
    input: ReportRoofingPiecesInput,
  ): Promise<ProductionOrderDto> {
    const operationDate = this.operationDate.resolve(actor, input.operationDate);
    await this.prisma.$transaction(
      async (tx) => {
        await this.reportInTx(tx, actor, orderId, input, operationDate);
      },
      { timeout: 30_000 },
    );

    return this.production.findOne(orderId);
  }

  /**
   * El cuerpo de `report`, **dentro de la transacción del llamador** (patrón `*InTx`,
   * D-099).
   *
   * Existe para que la tanda (D-147) escriba sus N filas en **una** transacción todo o nada
   * sin una segunda copia de esta lógica: con dos, el tope del plan (D-146) y el traslado de
   * la promesa (D-088) vivirían en dos lugares y divergirían — que es exactamente cómo
   * llegó desplegado D-145.
   */
  private async reportInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    orderId: string,
    input: ReportRoofingPiecesInput,
    operationDate: string,
  ): Promise<void> {
    const order = await lockOrder(tx, orderId);
    assertKind(order, ProductionOrderKind.ROOFING);
    if (order.status !== ProductionOrderStatus.IN_PROGRESS) {
      throw new BadRequestException(
        order.status === ProductionOrderStatus.DRAFT
          ? 'La orden todavía no tiene bobina montada: monta el material antes de reportar'
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

    const product = await tx.product.findUniqueOrThrow({
      where: { id: order.productId },
      select: { sku: true, unit: true, lengthMm: true },
    });

    // D-083: una plancha de catálogo tiene el largo en su SKU. Reportar otro largo la
    // convertiría en un producto distinto metido en el mismo saldo.
    if (product.lengthMm !== null) {
      const fixed = product.lengthMm.toFixed(2);
      const off = input.pieces.find((p) => toFixedString(p.lengthMm, 'MM') !== fixed);
      if (off) {
        throw new BadRequestException(
          `${product.sku} es una plancha de catálogo de ${toDecimal(fixed).div(1000).toFixed(2)} m: no admite un largo de ${toDecimal(off.lengthMm).div(1000).toFixed(2)} m`,
        );
      }
    }

    const rows = await tx.productionOrderConsumption.findMany({
      where: { productionOrderId: orderId, releasedAt: null },
      include: {
        coil: {
          select: {
            code: true,
            widthMm: true,
            thicknessMm: true,
            finish: { select: { densityFactor: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length === 0) {
      throw new BadRequestException('La orden no tiene ninguna bobina montada');
    }
    const row =
      input.coilId === undefined
        ? rows.length === 1
          ? rows[0]
          : undefined
        : rows.find((r) => r.coilId === input.coilId);
    if (!row) {
      throw new BadRequestException(
        input.coilId === undefined
          ? 'La orden tiene varias bobinas montadas: indica de cuál salieron estas planchas'
          : 'Esa bobina no está montada en la orden',
      );
    }

    const geometry: CoilGeometry = {
      widthMm: row.coil.widthMm.toFixed(2),
      thicknessMm: row.coil.thicknessMm.toFixed(2),
      densityFactor: row.coil.finish.densityFactor.toFixed(4),
    };
    const pieces = input.pieces.map((p, i) => ({
      lineNumber: i + 1,
      lengthMm: toFixedString(p.lengthMm, 'MM'),
      qty: p.qty,
    }));
    const neededKg = roofingTheoreticalKg(geometry, pieces);

    // -----------------------------------------------------------------------
    // D-146 — el plan de corte es un tope duro, no una intención
    // -----------------------------------------------------------------------
    //
    // Hasta acá la única cota de un reporte era el **material montado**: una orden de 100 ML
    // con un rollo entero encima podía reportar 300 ML sin que nada se quejara, y esos metros
    // de más nacían reservados a nombre del pedido (D-088) o entraban como stock que nadie
    // encargó. El plan dejó de ser solo una intención para esto: cambiar lo que hay que
    // producir es `updatePlan`, no reportar de más.
    const planRows = await tx.productionOrderItem.findMany({
      where: { productionOrderId: orderId },
      orderBy: { lineNumber: 'asc' },
      select: { lengthMm: true, qty: true },
    });
    const liveReportRows = await tx.productionReport.findMany({
      where: { productionOrderId: orderId, status: ProductionReportStatus.ACTIVE },
      select: {
        consumedKg: true,
        piecesDetail: { select: { lengthMm: true, qty: true } },
      },
    });
    const planPieces = planRows.map(toPieceLike);
    const reportedPieces = liveReportRows.flatMap((r) => r.piecesDetail.map(toPieceLike));
    const progress = roofingPlanProgress(planPieces, piecesMeters(reportedPieces));
    const newMeters = piecesMeters(pieces);
    const overrun = roofingPlanOverrun(progress, newMeters);
    if (overrun.gt(0)) {
      throw new BadRequestException(
        `${productionOrderCode(order.seq)} tiene un plan de ${progress.planMeters.toFixed(3)} m y ` +
          `${progress.reportedMeters.toFixed(3)} m ya reportados: ` +
          (progress.remainingMeters.isZero()
            ? 'el plan ya está cubierto y este reporte no entra. '
            : `quedan ${progress.remainingMeters.toFixed(3)} m y este reporte suma ${newMeters.toFixed(3)} m. `) +
          'Si de verdad hay que producir más, ajusta primero el plan de corte (RF-31).',
      );
    }

    // D-146, segunda mitad: los kilos que planta declara para este reporte. **No es un
    // consumo** —el kardex sale por `neededKg`, y el consumo real se reconcilia al cerrar
    // (D-089)—, así que lo único que hace falta es que el acumulado declarado no supere lo
    // que el plan entero puede pesar con la geometría del rollo montado. Ese techo deja
    // margen para el despunte real de cada reporte sin admitir una cifra imposible.
    const declaredKg = input.consumedKg === undefined ? null : toDecimal(input.consumedKg);
    if (declaredKg !== null && progress.hasPlan) {
      const alreadyDeclaredKg = liveReportRows.reduce(
        (acc, r) =>
          acc.plus(r.consumedKg === null ? new Decimal(0) : toDecimal(r.consumedKg.toString())),
        new Decimal(0),
      );
      const planKg = roofingTheoreticalKg(geometry, planPieces);
      if (alreadyDeclaredKg.plus(declaredKg).gt(planKg)) {
        throw new BadRequestException(
          `El plan de ${productionOrderCode(order.seq)} pesa ${planKg.toFixed(3)} kg teóricos con ` +
            `${row.coil.code} montada y ya hay ${alreadyDeclaredKg.toFixed(3)} kg declarados: ` +
            `no se pueden declarar ${declaredKg.toFixed(3)} kg más.`,
        );
      }
    }

    // Un solo rollo por reporte, así que el reparto es trivial — pero pasa por el mismo
    // `allocateStripKg` que drywall para heredar su mensaje cuando el material no
    // alcanza, en vez de escribir una segunda versión del mismo chequeo.
    const allocationRows: StripAllocationRow[] = [
      {
        consumptionId: row.id,
        coilId: row.coilId,
        coilCode: row.coil.code,
        remainingKg: toDecimal(row.assignedKg.toString()).minus(
          toDecimal(row.consumedKg.toString()),
        ),
      },
    ];
    const allocations = allocateStripKg(allocationRows, neededKg);

    const madeToMeasure = product.unit === Unit.MTR;
    const outputQty = madeToMeasure ? piecesMeters(pieces) : new Decimal(piecesCount(pieces));
    const outputUnit = madeToMeasure ? Unit.MTR : Unit.NIU;

    // D-088, primera mitad: la reserva de bobina se descuenta **antes** de la salida de
    // kardex. Si fuera al revés, la propia reserva bloquearía contra la invariante justo
    // la salida que viene a cumplirla. El pedido pasa a "en producción".
    let salesOrderItemId: string | null = null;
    let salesOrderId: string | null = null;
    if (order.reservationId) {
      const reservation = await tx.reservation.findUniqueOrThrow({
        where: { id: order.reservationId },
        select: { salesOrderId: true, salesOrderItemId: true, itemId: true },
      });
      salesOrderId = reservation.salesOrderId;
      salesOrderItemId = reservation.salesOrderItemId;
      // Pedido primero, reserva después: `SalesOrdersService.cancel` toma esos dos
      // recursos en ese mismo orden, y con el orden invertido anular un pedido y
      // reportar producción a la vez se trababan en un deadlock.
      await tx.$queryRaw`
        SELECT "id" FROM "sales_orders" WHERE "id" = ${reservation.salesOrderId}::uuid FOR UPDATE
      `;
      // **Siempre se descuenta** (D-134). Antes había que preguntar si el rollo que se
      // roló era el que el pedido había reservado, porque la promesa nombraba una bobina
      // concreta y nada obligaba a montar esa: descontar la promesa de un rollo del que
      // no salió un gramo la habría dejado por debajo de lo prometido sobre material
      // intacto. Con la reserva genérica esa pregunta desapareció: `mountCoil` solo
      // admite bobinas del color y el espesor del producto, que son exactamente las que
      // cumplen el agregado, así que cualquier kilo que esta orden role es un kilo del
      // agregado que el pedido prometía.
      await consumeReservationQty(tx, order.reservationId, neededKg);
      await tx.salesOrder.updateMany({
        where: { id: reservation.salesOrderId, status: SalesOrderStatus.CONFIRMED },
        data: { status: SalesOrderStatus.IN_PRODUCTION },
      });
    }

    const report = await tx.productionReport.create({
      data: {
        productionOrderId: orderId,
        pieces: piecesCount(pieces),
        metersM: madeToMeasure ? toFixedString(piecesMeters(pieces), 'KG') : null,
        theoreticalKg: toFixedString(neededKg, 'KG'),
        // D-146: lo declarado se guarda tal cual y no toca ningún cálculo del kardex.
        consumedKg: declaredKg === null ? null : toFixedString(declaredKg, 'KG'),
        materialCostPen: '0',
        unitCostPen: '0',
        notes: input.notes ?? null,
        createdById: actor.id,
        operationDate: toDateOnly(operationDate),
        piecesDetail: { create: pieces },
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
        notes: `Rolado de ${productionOrderCode(order.seq)}: ${describePieces(pieces)}`,
        actorId: actor.id,
        // D-134: lo que resta de la promesa que esta orden viene a cumplir no puede
        // bloquear su propio consumo. Ver `RecordMovementInput.exceptReservationIds`.
        exceptReservationIds: order.reservationId ? [order.reservationId] : [],
        // Sin esto, un reporte retrofechado dejaba el consumo de la bobina fechado hoy y
        // el ingreso de producto en la fecha real: los dos lados del mismo hecho en meses
        // distintos, en una tabla append-only que no se corrige con un UPDATE.
        operationDate,
        confirmBackdate: input.confirmBackdate,
      });
      if (!out) {
        throw new BadRequestException('La línea de negocio de la orden no lleva inventario');
      }
      materialCostPen = materialCostPen.plus(toDecimal(out.totalCost.toString()));

      await tx.productionOrderConsumption.update({
        where: { id: allocation.consumptionId },
        data: {
          consumedKg: toFixedString(toDecimal(row.consumedKg.toString()).plus(allocation.kg), 'KG'),
        },
      });
    }

    // D-083: el producto a medida entra en METROS y la plancha de catálogo en piezas.
    // El costo unitario es el material que acaba de salir dividido entre lo que entró;
    // el residuo de redondeo lo reconcilia el ajuste del cierre.
    const unitCostPen = materialCostPen.div(outputQty);
    const entry = await this.inventory.record(tx, {
      businessLineId: order.businessLineId,
      itemType: 'PRODUCT',
      itemId: order.productId,
      type: 'IN',
      qty: toFixedString(outputQty, 'KG'),
      unit: outputUnit,
      unitCost: toFixedString(unitCostPen, 'MONEY'),
      refType: 'PRODUCTION',
      refId: report.id,
      notes: `${productionOrderCode(order.seq)}: ${describePieces(pieces)}`,
      actorId: actor.id,
      operationDate,
      confirmBackdate: input.confirmBackdate,
    });
    if (!entry) {
      throw new BadRequestException('La línea de negocio de la orden no lleva inventario');
    }

    // D-088, segunda mitad: las planchas **nacen reservadas** para el pedido que las
    // encargó. Sin esto el material volvería al almacén desprotegido mientras el pedido
    // lo sigue prometiendo, y la primera merma o venta se lo llevaría.
    let productReservationId: string | null = null;
    if (salesOrderId && salesOrderItemId) {
      // **Topado a lo que la línea todavía debe.** Los largos reales difieren del plan
      // (D-084), así que sobre-producir es normal y esperable; prometer de más no lo es:
      // esos metros sobrantes quedarían `ACTIVA` para siempre —el pedido pasa a atendido
      // sin que nada los libere— y ninguna otra venta ni merma podría tocarlos. Lo que
      // sobra entra al kardex como stock libre, que es lo que de verdad es.
      const line = await tx.salesOrderItem.findUniqueOrThrow({
        where: { id: salesOrderItemId },
        select: { qty: true },
      });
      const alreadyHeld = await findLineReservation(
        tx,
        salesOrderItemId,
        InventoryItemType.PRODUCT,
        order.productId,
      );
      const promised = toDecimal(line.qty.toString());
      const held =
        alreadyHeld?.status === ReservationStatus.ACTIVE ? alreadyHeld.qty : new Decimal(0);
      const toReserve = Decimal.min(outputQty, Decimal.max(promised.minus(held), new Decimal(0)));
      if (toReserve.gt(0)) {
        productReservationId = await upsertItemReservation(tx, {
          salesOrderId,
          salesOrderItemId,
          itemType: InventoryItemType.PRODUCT,
          itemId: order.productId,
          qty: toReserve,
          unit: outputUnit,
          actorId: actor.id,
        });
      }
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
      action: 'production.roofing.report',
      entity: 'production_orders',
      entityId: orderId,
      after: {
        reportId: report.id,
        operationDate,
        confirmedBackdate: input.confirmBackdate === true,
        coilCode: row.coil.code,
        plan: describePieces(pieces),
        outputQty: toFixedString(outputQty, 'KG'),
        outputUnit,
        theoreticalKg: toFixedString(neededKg, 'KG'),
        declaredKg: declaredKg === null ? null : toFixedString(declaredKg, 'KG'),
        planMeters: progress.planMeters.toFixed(3),
        reportedMetersAfter: progress.reportedMeters.plus(newMeters).toFixed(3),
        materialCostPen: toFixedString(materialCostPen, 'MONEY'),
        productReservationId,
      },
    });
  }

  // -------------------------------------------------------------------------
  // D-147 — reportar producción en tanda
  // -------------------------------------------------------------------------

  /**
   * Las órdenes de coberturas abiertas, con lo que la tanda necesita por fila (D-147).
   *
   * Es una consulta propia y no el listado de `/production` porque la fila necesita tres
   * cosas que el listado omite a propósito: el plan de corte, los largos ya reportados y la
   * geometría de la bobina montada. Pedirlas orden por orden con `findOne` serían N+1
   * requests desde el navegador, que es justo lo que la pantalla viene a evitar.
   */
  async batchOrders(salesOrderId?: string): Promise<RoofingBatchOrderDto[]> {
    const orders = await this.prisma.productionOrder.findMany({
      where: {
        kind: ProductionOrderKind.ROOFING,
        status: { in: [ProductionOrderStatus.DRAFT, ProductionOrderStatus.IN_PROGRESS] },
        ...(salesOrderId ? { reservation: { salesOrderId } } : {}),
      },
      include: {
        product: { select: { sku: true, name: true, unit: true } },
        items: { orderBy: { lineNumber: 'asc' }, select: { lengthMm: true, qty: true } },
        reservation: {
          select: {
            salesOrder: { select: { id: true, seq: true, customer: { select: { name: true } } } },
          },
        },
        reports: {
          where: { status: ProductionReportStatus.ACTIVE },
          select: {
            theoreticalKg: true,
            consumedKg: true,
            piecesDetail: { select: { lengthMm: true, qty: true } },
          },
        },
        consumptions: {
          where: { releasedAt: null },
          orderBy: { createdAt: 'asc' },
          include: {
            coil: {
              select: {
                code: true,
                widthMm: true,
                thicknessMm: true,
                finish: { select: { densityFactor: true } },
              },
            },
          },
        },
      },
      orderBy: { seq: 'asc' },
      take: 500,
    });

    return orders.map((order) => {
      const planPieces = order.items.map(toPieceLike);
      const reportedPieces = order.reports.flatMap((r) => r.piecesDetail.map(toPieceLike));
      const progress = roofingPlanProgress(planPieces, piecesMeters(reportedPieces));
      const salesOrder = order.reservation?.salesOrder ?? null;
      return {
        orderId: order.id,
        code: productionOrderCode(order.seq),
        status: order.status,
        productId: order.productId,
        productSku: order.product.sku,
        productName: order.product.name,
        productUnit: order.product.unit,
        salesOrderId: salesOrder?.id ?? null,
        salesOrderCode: salesOrder ? salesOrderCode(salesOrder.seq) : null,
        customerName: salesOrder?.customer.name ?? null,
        planItems: order.items.map((i, n) => ({
          lineNumber: n + 1,
          lengthMm: i.lengthMm.toFixed(2),
          qty: i.qty,
        })),
        planMeters: progress.planMeters.toFixed(3),
        reportedMeters: progress.reportedMeters.toFixed(3),
        remainingMeters: progress.remainingMeters.toFixed(3),
        remainingPieces: remainingPlanPieces(planPieces, reportedPieces)
          .filter((p) => p.qty > 0)
          .map((p, n) => ({ lineNumber: n + 1, lengthMm: p.lengthMm, qty: p.qty })),
        declaredKg: order.reports
          .reduce(
            (acc, r) =>
              acc.plus(r.consumedKg === null ? new Decimal(0) : toDecimal(r.consumedKg.toString())),
            new Decimal(0),
          )
          .toFixed(3),
        reportedKg: order.reports
          .reduce((acc, r) => acc.plus(toDecimal(r.theoreticalKg.toString())), new Decimal(0))
          .toFixed(3),
        coils: order.consumptions.map((c) => ({
          coilId: c.coilId,
          coilCode: c.coil.code,
          widthMm: c.coil.widthMm.toFixed(2),
          thicknessMm: c.coil.thicknessMm.toFixed(2),
          densityFactor: c.coil.finish.densityFactor.toFixed(4),
          remainingKg: toFixedString(
            toDecimal(c.assignedKg.toString()).minus(toDecimal(c.consumedKg.toString())),
            'KG',
          ),
        })),
        operationDate: fromDateOnly(order.operationDate),
      };
    });
  }

  /**
   * Reportar una tanda entera: N órdenes, un número de metros por orden (D-147).
   *
   * **Todo o nada, y con todos los errores de una vez.** Una fila que no valida no aborta en
   * el acto: se anota, la tanda sigue evaluándose y al final se lanza un único 400 con el
   * error de cada fila. Quien está transcribiendo una hoja de papel necesita corregirla toda
   * junta, no descubrir un error por intento — y como todo ocurre dentro de la misma
   * transacción, lo que las filas buenas alcanzaron a escribir se deshace entero.
   *
   * Un error que **no** sea de dominio (una violación de constraint, un deadlock) sí corta en
   * el acto: a partir de ahí Postgres aborta la transacción y cualquier consulta siguiente
   * fallaría con un error que no dice nada. Seguir juntando errores ahí sería inventarlos.
   */
  async reportBatch(
    actor: RequestUser,
    input: ReportRoofingBatchInput,
  ): Promise<RoofingBatchResultDto> {
    const operationDate = this.operationDate.resolve(actor, input.operationDate);

    return this.prisma.$transaction(
      async (tx) => {
        const failures: Record<string, string[]> = {};
        let pieces = 0;
        let meters = new Decimal(0);

        // **Ordenadas por id antes de tocar nada.** Cada fila toma un `FOR UPDATE` sobre su
        // orden y los va acumulando hasta el commit; con el orden que mande el cliente, dos
        // tandas simultáneas que compartan órdenes en distinto orden se traban en deadlock.
        // Es el mismo motivo por el que `report` fija el orden pedido → reserva.
        const rows = [...input.rows].sort((a, b) => a.orderId.localeCompare(b.orderId));

        for (const [index, row] of rows.entries()) {
          // **Un savepoint por fila.** `reportInTx` no es atómica por dentro: descuenta la
          // reserva y crea el reporte **antes** del primer punto que puede fallar por dominio
          // (`inventory.record`). Sin el savepoint, una fila que falla deja esas escrituras
          // vivas dentro de la transacción y las filas siguientes se validan contra un estado
          // que no ocurrió — el caso concreto es una tanda retrofechada sin confirmar, donde
          // todas las filas fallaban en el kardex y devolvían N errores fabricados. El
          // resultado final era correcto (el `throw` de abajo revierte todo), pero el contrato
          // que esta pantalla promete —"el error de **cada** fila"— era falso.
          const savepoint = `tanda_${String(index)}`;
          await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
          try {
            const split = await this.splitBatchRow(tx, row);
            await this.reportInTx(
              tx,
              actor,
              row.orderId,
              {
                coilId: row.coilId,
                pieces: split,
                consumedKg: row.consumedKg,
                notes: row.notes,
                confirmBackdate: input.confirmBackdate,
              },
              operationDate,
            );
            await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
            pieces += piecesCount(split);
            meters = meters.plus(piecesMeters(split));
          } catch (err) {
            // Un error que no es de dominio (deadlock, constraint, P2028) corta en el acto:
            // ahí sí la transacción quedó abortada y seguir juntando errores sería inventarlos.
            if (!(err instanceof HttpException)) throw err;
            await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            failures[row.orderId] = [messageOf(err)];
          }
        }

        if (Object.keys(failures).length > 0) {
          throw new BadRequestException({
            statusCode: 400,
            message:
              `${String(Object.keys(failures).length)} de ${String(input.rows.length)} filas no entraron: ` +
              'la tanda no se guardó, corrígelas y vuelve a enviarla',
            errors: failures,
          });
        }

        return { orders: input.rows.length, pieces, meters: meters.toFixed(3) };
      },
      // Una tanda es hasta `MAX_BATCH_ROWS` reportes con su kardex completo cada uno, y cada
      // uno hace lo que `report` hacía solo. El presupuesto es el de `close` por orden de
      // magnitud, no el de un reporte suelto.
      { timeout: 120_000, maxWait: 15_000 },
    );
  }

  /**
   * Los metros de una fila de la tanda, convertidos a los largos del plan de esa orden
   * (D-147). Vive acá y no en `reportBatch` para que el error de la fila —"42.5 m no salen
   * de un número entero de planchas"— llegue por el mismo camino que cualquier otro error de
   * dominio y termine en el mapa de fallas, no en un 500.
   */
  private async splitBatchRow(
    tx: Prisma.TransactionClient,
    row: { orderId: string; meters: string },
  ): Promise<PieceLike[]> {
    const order = await tx.productionOrder.findUnique({
      where: { id: row.orderId },
      select: {
        kind: true,
        items: { orderBy: { lineNumber: 'asc' }, select: { lengthMm: true, qty: true } },
        reports: {
          where: { status: ProductionReportStatus.ACTIVE },
          select: { piecesDetail: { select: { lengthMm: true, qty: true } } },
        },
      },
    });
    if (!order) throw new NotFoundException('Orden de producción no encontrada');
    if (order.kind !== ProductionOrderKind.ROOFING) {
      throw new BadRequestException(
        'Esa orden es de perfiles de drywall: opérala desde producción de drywall',
      );
    }

    const split = piecesFromPlanMeters(
      order.items.map(toPieceLike),
      order.reports.flatMap((r) => r.piecesDetail.map(toPieceLike)),
      row.meters,
    );
    if (!split.ok) throw new BadRequestException(split.reason);

    // Los largos de la tanda **no los tipea nadie**: los deriva el reparto, así que no pasan
    // por el `ZodValidationPipe` del controller como sí pasan los de un reporte suelto. Se
    // validan acá con el mismo schema. Hoy no puede fallar —el plan ya cumple esas cotas y lo
    // derivado es un subconjunto—, y por eso mismo es el chequeo que hay que dejar puesto: si
    // mañana el plan deja de acotarse en algún camino nuevo, el error sale acá y no como una
    // fila imposible en `production_report_pieces`.
    const parsed = roofingPiecesSchema.safeParse(split.pieces);
    if (!parsed.success) {
      throw new BadRequestException(
        `Los largos que salen de esos metros no son válidos: ${parsed.error.issues[0]?.message ?? 'revisa el plan de corte'}`,
      );
    }
    return split.pieces;
  }

  // -------------------------------------------------------------------------
  // D-148 — todas las órdenes de un pedido de una vez
  // -------------------------------------------------------------------------

  /**
   * Crea la OP de cada línea del pedido que todavía no la tiene, en una transacción (D-148).
   *
   * No es un modo nuevo de crear órdenes: cada una pasa por `createFromReservationInTx`, la
   * misma que usa el botón de una sola orden y la importación de ventas (D-141). Lo que
   * agrega es que un pedido de ocho líneas no pueda quedar con cinco en cola y tres
   * olvidadas porque alguien se distrajo a mitad de la lista.
   *
   * Las líneas que **no** se fabrican contra el pedido —una plancha de catálogo, que reserva
   * producto terminado (D-127/D-140)— no son un error: se saltan en silencio, porque su
   * camino es la corrida a stock y no este botón.
   */
  async createFromSalesOrder(
    actor: RequestUser,
    salesOrderId: string,
    input: CreateRoofingOrdersFromSalesOrderInput,
  ): Promise<RoofingBatchCreateResultDto> {
    const operationDate = this.operationDate.resolve(actor, input.operationDate);

    return this.prisma.$transaction(
      async (tx) => {
        const salesOrder = await tx.salesOrder.findUnique({
          where: { id: salesOrderId },
          select: { id: true, seq: true, status: true },
        });
        if (!salesOrder) throw new NotFoundException('Pedido no encontrado');
        if (salesOrder.status === SalesOrderStatus.CANCELLED) {
          throw new BadRequestException('El pedido está anulado');
        }

        const reservations = await tx.reservation.findMany({
          where: {
            salesOrderId,
            status: ReservationStatus.ACTIVE,
            itemType: InventoryItemType.RAW_MATERIAL,
          },
          select: {
            id: true,
            salesOrderItem: { select: { lineNumber: true } },
            productionOrders: {
              where: {
                status: {
                  in: [ProductionOrderStatus.DRAFT, ProductionOrderStatus.IN_PROGRESS],
                },
              },
              select: { id: true },
            },
          },
          orderBy: { salesOrderItem: { lineNumber: 'asc' } },
        });

        const pending = reservations.filter((r) => r.productionOrders.length === 0);
        const alreadyQueued = reservations.length - pending.length;
        if (pending.length === 0) {
          throw new BadRequestException(
            alreadyQueued > 0
              ? `Las ${String(alreadyQueued)} líneas a medida de ${salesOrderCode(salesOrder.seq)} ya tienen su orden en cola`
              : `${salesOrderCode(salesOrder.seq)} no tiene ninguna línea que se fabrique contra el pedido: ` +
                  'una plancha de catálogo se atiende con stock y, si falta, se produce a stock (D-140)',
          );
        }

        const created: { orderId: string; code: string }[] = [];
        for (const reservation of pending) {
          const orderId = await this.createFromReservationInTx(tx, actor, {
            reservationId: reservation.id,
            operationDate,
            notes: input.notes ?? null,
          });
          const order = await tx.productionOrder.findUniqueOrThrow({
            where: { id: orderId },
            select: { seq: true },
          });
          created.push({ orderId, code: productionOrderCode(order.seq) });
        }

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'production.roofing.create_batch',
          entity: 'sales_orders',
          entityId: salesOrderId,
          after: {
            salesOrder: salesOrderCode(salesOrder.seq),
            created: created.map((c) => c.code),
            alreadyQueued,
          },
        });

        return { created, alreadyQueued };
      },
      { timeout: 60_000, maxWait: 15_000 },
    );
  }

  // -------------------------------------------------------------------------
  // D-089 — cerrar: merma por despunte y costeo
  // -------------------------------------------------------------------------

  async close(
    actor: RequestUser,
    orderId: string,
    input: CloseRoofingOrderInput,
  ): Promise<ProductionOrderDto> {
    // D-124: el cierre se fecha aparte del arranque; el despunte es del día del cierre.
    const operationDate = this.operationDate.resolve(actor, input.operationDate);
    await this.prisma.$transaction(
      async (tx) => {
        const order = await lockOrder(tx, orderId);
        assertKind(order, ProductionOrderKind.ROOFING);
        if (order.status !== ProductionOrderStatus.IN_PROGRESS) {
          throw new BadRequestException(
            order.status === ProductionOrderStatus.DRAFT
              ? 'La orden no tiene material ni planchas: anúlala en vez de cerrarla'
              : `La orden ya está ${order.status === ProductionOrderStatus.CLOSED ? 'cerrada' : 'anulada'}`,
          );
        }

        const reports = await tx.productionReport.findMany({
          where: { productionOrderId: orderId, status: ProductionReportStatus.ACTIVE },
        });
        if (reports.length === 0) {
          throw new BadRequestException(
            'La orden no tiene planchas reportadas: anúlala para liberar la bobina en vez de cerrarla',
          );
        }

        const rows = await tx.productionOrderConsumption.findMany({
          where: { productionOrderId: orderId, releasedAt: null },
          include: { coil: { select: { code: true } } },
          orderBy: { createdAt: 'asc' },
        });

        const reportedKg = reports.reduce(
          (acc, r) => acc.plus(toDecimal(r.theoreticalKg.toString())),
          new Decimal(0),
        );
        const remainingKg = rows.reduce(
          (acc, r) =>
            acc.plus(
              Decimal.max(
                toDecimal(r.assignedKg.toString()).minus(toDecimal(r.consumedKg.toString())),
                new Decimal(0),
              ),
            ),
          new Decimal(0),
        );
        // D-146: cuando planta declaró kilos **reporte a reporte**, el cierre los usa como
        // valor por defecto en vez de asumir merma cero. Sin esto, la cifra que el encargado
        // se tomó el trabajo de anotar quedaba de adorno: cerrar sin `consumedKg` la
        // contradecía en silencio y el despunte real desaparecía. Lo explícito sigue
        // mandando: `input.consumedKg` gana siempre.
        //
        // El piso es `reportedKg` porque lo declarado por reporte se topa contra el kilo
        // teórico del **plan**, no contra el de sus propios largos: puede quedar por debajo
        // de lo que las planchas ya representan, y ese material salió de verdad (D-089).
        const declaredByReportsKg = reports.some((r) => r.consumedKg !== null)
          ? Decimal.max(
              reports.reduce(
                (acc, r) => acc.plus(toDecimal((r.consumedKg ?? r.theoreticalKg).toString())),
                new Decimal(0),
              ),
              reportedKg,
            )
          : reportedKg;
        const declaredKg = input.consumedKg ? toDecimal(input.consumedKg) : declaredByReportsKg;

        // D-089: lo declarado no puede ser menos que lo que las planchas ya representan (el
        // material salió de verdad), ni más de lo que la orden tenía montado.
        if (declaredKg.lt(reportedKg)) {
          throw new BadRequestException(
            `Las planchas reportadas ya consumieron ${reportedKg.toFixed(3)} kg: no se puede declarar un consumo de ${declaredKg.toFixed(3)} kg`,
          );
        }
        if (declaredKg.gt(reportedKg.plus(remainingKg))) {
          throw new BadRequestException(
            `La orden tiene ${reportedKg.plus(remainingKg).toFixed(3)} kg montados y se declaran ${declaredKg.toFixed(3)} kg consumidos: monta más material o corrige la cifra`,
          );
        }

        const { scrapKg, scrapRatio } = roofingCloseScrap({ declaredKg, reportedKg, remainingKg });
        if (!input.reason && scrapRatio.gt(MAX_SCRAP_RATIO_WITHOUT_REASON)) {
          throw new BadRequestException(
            `El cierre deja ${scrapKg.toFixed(3)} kg de despunte sobre ${declaredKg.toFixed(3)} kg consumidos (${scrapRatio.times(100).toFixed(1)} %): explica el motivo para cerrar con esa merma`,
          );
        }

        // Un solo instante para el cierre y para la liberación de sus bobinas: es lo que le
        // permite a `reopen` distinguir las que soltó el cierre de las que planta bajó a mano.
        const closedAt = new Date();
        let scrapCostPen = new Decimal(0);
        const scrapped: string[] = [];
        if (scrapKg.gt(0)) {
          // Los kilos del despunte también salen de lo que el pedido prometía, así que la
          // reserva se descuenta **antes** de emitirlos — igual que en `report`. Sin esto,
          // una orden que reservó el rollo entero no se podía cerrar con merma: la propia
          // promesa bloqueaba la salida contra la invariante, y planta veía "anula el pedido
          // o libera la reserva" en el paso más normal de la corrida.
          if (order.reservationId) {
            const reservation = await tx.reservation.findUniqueOrThrow({
              where: { id: order.reservationId },
              select: { salesOrderId: true, itemId: true },
            });
            await tx.$queryRaw`
              SELECT "id" FROM "sales_orders" WHERE "id" = ${reservation.salesOrderId}::uuid FOR UPDATE
            `;
            // Mismo criterio que el reporte (D-134): el despunte sale de una bobina que la
            // orden montó, y toda bobina que la orden pudo montar cumple el agregado que el
            // pedido prometía. No hay rollo "ajeno" del que descontar por error.
            await consumeReservationQty(tx, order.reservationId, scrapKg);
          }
          const allocations = allocateStripKg(
            rows.map((r) => ({
              consumptionId: r.id,
              coilId: r.coilId,
              coilCode: r.coil.code,
              remainingKg: Decimal.max(
                toDecimal(r.assignedKg.toString()).minus(toDecimal(r.consumedKg.toString())),
                new Decimal(0),
              ),
            })),
            scrapKg,
          );
          for (const allocation of allocations) {
            await this.coils.lockCoil(tx, allocation.coilId);
            const out = await this.inventory.record(tx, {
              businessLineId: order.businessLineId,
              itemType: 'COIL',
              itemId: allocation.coilId,
              type: 'OUT',
              qty: toFixedString(allocation.kg, 'KG'),
              unit: Unit.KGM,
              refType: 'SCRAP',
              refId: orderId,
              // D-134: igual que el reporte — el despunte sale de la bobina que esta orden
              // montó para cumplir su propia promesa.
              exceptReservationIds: order.reservationId ? [order.reservationId] : [],
              notes: input.reason
                ? `Despunte al cerrar ${productionOrderCode(order.seq)}: ${input.reason}`
                : `Despunte al cerrar ${productionOrderCode(order.seq)}`,
              actorId: actor.id,
              operationDate,
              confirmBackdate: input.confirmBackdate,
            });
            if (!out) {
              throw new BadRequestException('La línea de negocio de la orden no lleva inventario');
            }
            scrapCostPen = scrapCostPen.plus(toDecimal(out.totalCost.toString()));
            scrapped.push(`${allocation.coilCode}: ${allocation.kg.toFixed(3)} kg`);
            const consumed = rows.find((r) => r.id === allocation.consumptionId);
            await tx.productionOrderConsumption.update({
              where: { id: allocation.consumptionId },
              data: {
                consumedKg: toFixedString(
                  toDecimal(consumed?.consumedKg.toString() ?? '0').plus(allocation.kg),
                  'KG',
                ),
              },
            });
          }
        }

        // **Aquí está la diferencia con D-057.** Lo que quedó montado y no se consumió NO es
        // merma: la bobina sigue en el almacén con su saldo, solo se baja de la roladora.
        await tx.productionOrderConsumption.updateMany({
          where: { productionOrderId: orderId, releasedAt: null },
          data: { releasedAt: closedAt },
        });

        // Fase 7 (D-093, D-096): con la OP cerrada no hay más material que vaya a salir de
        // esta reserva de bobina — lo que el pedido fabricó ya está prometido por el lado
        // del producto (D-088). Sin esto, un pedido cuyo `reserveKg` sobreestimó lo que la
        // corrida realmente iba a gastar —o cuya bobina montada terminó siendo otra que la
        // reservada (D-086)— se quedaba `EN_COLA` para siempre, ya despachado y todo.
        const releasedReservationKg = order.reservationId
          ? await releaseRemainingReservation(tx, order.reservationId)
          : new Decimal(0);

        const outputQty = reports.reduce(
          (acc, r) =>
            acc.plus(r.metersM === null ? new Decimal(r.pieces) : toDecimal(r.metersM.toString())),
          new Decimal(0),
        );
        const reportsCostPen = reports.reduce(
          (acc, r) => acc.plus(toDecimal(r.materialCostPen.toString())),
          new Decimal(0),
        );
        const cost = roofingCost({ reportsCostPen, scrapCostPen, outputQty });

        const adjustPen = roofingCloseAdjustmentPen(
          cost.totalCostPen,
          reports.map((r) => ({
            qty: r.metersM === null ? new Decimal(r.pieces) : toDecimal(r.metersM.toString()),
            unitCostPen: r.unitCostPen.toFixed(4),
          })),
        );
        let adjusted = false;
        if (!adjustPen.isZero()) {
          const product = await tx.product.findUniqueOrThrow({
            where: { id: order.productId },
            select: { unit: true },
          });
          const movement = await this.inventory.adjustCost(tx, {
            businessLineId: order.businessLineId,
            itemType: 'PRODUCT',
            itemId: order.productId,
            unit: product.unit,
            amountPen: toFixedString(adjustPen, 'MONEY'),
            refType: 'PRODUCTION',
            refId: orderId,
            notes: `Cierre de ${productionOrderCode(order.seq)}: despunte ${scrapKg.toFixed(3)} kg imputado a ${outputQty.toFixed(3)}`,
            actorId: actor.id,
            operationDate,
          });
          adjusted = movement !== null;
        }

        await tx.productionOrder.update({
          where: { id: orderId },
          data: {
            status: ProductionOrderStatus.CLOSED,
            scrapKg: toFixedString(scrapKg, 'KG'),
            consumedKg: toFixedString(declaredKg, 'KG'),
            materialCostPen: toFixedString(cost.materialCostPen, 'MONEY'),
            overheadCostPen: toFixedString(cost.overheadCostPen, 'MONEY'),
            totalCostPen: toFixedString(cost.totalCostPen, 'MONEY'),
            unitCostPen: toFixedString(cost.unitCostPen, 'MONEY'),
            notes: input.notes ?? order.notes,
            closedById: actor.id,
            closedAt,
            closedOperationDate: toDateOnly(operationDate),
          },
        });

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'production.roofing.close',
          entity: 'production_orders',
          entityId: orderId,
          before: { status: order.status },
          after: {
            status: ProductionOrderStatus.CLOSED,
            outputQty: toFixedString(outputQty, 'KG'),
            consumedKg: toFixedString(declaredKg, 'KG'),
            scrapKg: toFixedString(scrapKg, 'KG'),
            scrapRatioPct: scrapRatio.times(100).toFixed(2),
            scrapReason: input.reason ?? null,
            scrapped,
            materialCostPen: toFixedString(cost.materialCostPen, 'MONEY'),
            unitCostPen: toFixedString(cost.unitCostPen, 'MONEY'),
            costAdjusted: adjusted,
            releasedReservationKg: releasedReservationKg.gt(0)
              ? toFixedString(releasedReservationKg, 'KG')
              : null,
          },
        });
      },
      { timeout: 60_000 },
    );

    return this.production.findOne(orderId);
  }

  // -------------------------------------------------------------------------
  // Reversas
  // -------------------------------------------------------------------------

  /**
   * Deshace un reporte entero: saca del kardex las planchas que metió, devuelve los kilos a
   * la bobina y **devuelve la promesa a la materia prima** (D-088). Mismo criterio "todo o
   * nada" que RF-16: si el producto ya se movió —un despacho, una merma, el ajuste de otro
   * cierre— falla completa en vez de dejar el kardex a mitad de camino.
   *
   * Solo el **último** reporte vigente: los reportes se apilan sobre la misma bobina, así
   * que deshacer uno del medio dejaría los kilos consumidos contando una historia que no
   * ocurrió.
   */
  async reverseReport(
    actor: RequestUser,
    orderId: string,
    reportId: string,
    input: ReverseMovementInput,
  ): Promise<ProductionOrderDto> {
    const { reason } = input;
    const operationDate = this.operationDate.resolve(actor, input.operationDate);
    await this.prisma.$transaction(
      async (tx) => {
        const order = await lockOrder(tx, orderId);
        assertKind(order, ProductionOrderKind.ROOFING);
        if (order.status !== ProductionOrderStatus.IN_PROGRESS) {
          throw new BadRequestException(
            order.status === ProductionOrderStatus.CLOSED
              ? 'La orden está cerrada: reábrela primero para poder corregir sus reportes'
              : `La orden está ${order.status === ProductionOrderStatus.CANCELLED ? 'anulada' : 'en borrador'}: no tiene reportes que revertir`,
          );
        }

        const report = await tx.productionReport.findFirst({
          where: { id: reportId, productionOrderId: orderId },
          include: { piecesDetail: { orderBy: { lineNumber: 'asc' } } },
        });
        if (!report) throw new NotFoundException('Ese reporte no pertenece a la orden');
        if (report.status !== ProductionReportStatus.ACTIVE) {
          throw new BadRequestException('Ese reporte ya fue revertido');
        }

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
            `Hay reportes posteriores vigentes (${later.pieces} planchas del ${later.createdAt.toISOString().slice(0, 10)}): revierte el último primero`,
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
          throw new BadRequestException('Ese reporte no tiene un ingreso de producto que revertir');
        }
        const coilOuts = movements.filter((m) => m.itemType === 'COIL' && m.type === 'OUT');

        // El producto es fungible dentro de su saldo, así que "movimientos posteriores" a
        // secas sería demasiado estricto: otro reporte del mismo perfil es inofensivo. Lo que
        // bloquea es que después haya **salido** producto (un despacho, una merma: pudo ser
        // justo el de este reporte) o que haya entrado un **ajuste de costo** de otro cierre,
        // que se repartió sobre un saldo que incluía estos metros.
        const productAfter = await tx.inventoryMovement.findMany({
          where: { itemType: 'PRODUCT', itemId: order.productId, id: { gt: entry.id } },
          orderBy: { id: 'asc' },
          include: { reversals: { select: { id: true } } },
        });
        const blocking = liveMovements(productAfter).find((m) => m.type !== 'IN');
        if (blocking) {
          throw new BadRequestException(
            `Las planchas de este reporte ya se movieron (${blocking.type} ${blocking.refType}): anula ese movimiento antes de revertir el reporte`,
          );
        }

        const outputQty = toDecimal(entry.qty.toString());

        // **El orden importa y no es el intuitivo.** La reserva sobre el producto se reduce
        // *antes* de sacarlo del kardex, por el mismo motivo por el que `report` descuenta la
        // reserva de bobina antes de la salida: `InventoryService.reverse` comprueba
        // `disponible ≥ reservado` sobre el saldo que dejaría, y esos metros están reservados
        // justo por este reporte — la reversa se bloqueaba a sí misma con el mensaje "anula el
        // pedido o libera la reserva", en el caso normal y no en un borde.
        let reducedProductQty: string | null = null;
        let reservationLineId: string | null = null;
        if (order.reservationId) {
          const reservation = await tx.reservation.findUniqueOrThrow({
            where: { id: order.reservationId },
            select: { salesOrderItemId: true },
          });
          reservationLineId = reservation.salesOrderItemId;
          const onProduct = await findLineReservation(
            tx,
            reservation.salesOrderItemId,
            InventoryItemType.PRODUCT,
            order.productId,
          );
          if (onProduct) {
            const reduced = await reduceReservation(tx, onProduct.id, outputQty, actor.id);
            reducedProductQty = reduced.toFixed(3);
          }
        }

        // Primero sale el producto y después vuelven los kilos: al revés, la bobina
        // recuperaría material que las planchas todavía están representando.
        await this.inventory.reverse(tx, entry.id, actor.id, reason, operationDate);

        const rows = await tx.productionOrderConsumption.findMany({
          where: { productionOrderId: orderId },
          orderBy: [{ releasedAt: 'asc' }, { createdAt: 'asc' }],
        });
        for (const movement of coilOuts) {
          await this.coils.lockCoil(tx, movement.itemId);
          await this.inventory.reverse(tx, movement.id, actor.id, reason, operationDate);
          const row = rows.find((r) => r.coilId === movement.itemId && r.releasedAt === null);
          if (!row) {
            throw new BadRequestException(
              'La bobina de este reporte ya no está montada en la orden: no se puede revertir',
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
        await recomputeStatus(tx, orderId);

        // D-088 al revés, segunda mitad: los kilos volvieron a la bobina, así que la promesa
        // vuelve con ellos. La primera mitad —reducir la reserva de producto— ya ocurrió
        // arriba, antes de la salida de kardex.
        let restoredCoilKg: string | null = null;
        if (order.reservationId && reservationLineId !== null) {
          // Simétrico a `report` (D-134): se devuelven **todos** los kilos que volvieron a
          // materia prima, sin preguntar de qué rollo salieron. La promesa se descontó por
          // esos mismos kilos cuando el reporte los consumió, así que devolverlos la deja
          // exactamente donde estaba — que es lo que "toda reversa aguas abajo restaura la
          // reserva" quiere decir.
          const returnedKg = coilOuts.reduce(
            (acc, m) => acc.plus(toDecimal(m.qty.toString())),
            new Decimal(0),
          );
          if (
            returnedKg.gt(0) &&
            (await restoreReservationQty(tx, order.reservationId, returnedKg))
          ) {
            restoredCoilKg = returnedKg.toFixed(3);
          }
        }

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'production.roofing.report-reverse',
          entity: 'production_orders',
          entityId: orderId,
          before: { reportId, plan: describePieces(report.piecesDetail.map(toPieceLike)) },
          after: {
            reportId,
            status: ProductionReportStatus.REVERTED,
            reason,
            restoredCoilKg,
            reducedProductQty,
          },
        });
      },
      { timeout: 30_000 },
    );

    return this.production.findOne(orderId);
  }

  /**
   * Deshace el cierre: revierte el ajuste de costo y el despunte, y vuelve a montar las
   * bobinas que el cierre bajó. Mismos guardrails conservadores que D-052 y que la reapertura
   * de drywall: si el producto ya se movió o si alguna bobina se movió después del cierre,
   * falla completa.
   */
  async reopen(
    actor: RequestUser,
    orderId: string,
    input: ReverseMovementInput,
  ): Promise<ProductionOrderDto> {
    const { reason } = input;
    const operationDate = this.operationDate.resolve(actor, input.operationDate);
    await this.prisma.$transaction(
      async (tx) => {
        const order = await lockOrder(tx, orderId);
        assertKind(order, ProductionOrderKind.ROOFING);
        if (order.status !== ProductionOrderStatus.CLOSED) {
          throw new BadRequestException(
            order.status === ProductionOrderStatus.CANCELLED
              ? 'La orden está anulada: no hay cierre que deshacer'
              : 'La orden todavía no está cerrada',
          );
        }

        const own = await tx.inventoryMovement.findMany({
          where: { refId: orderId, refType: { in: ['PRODUCTION', 'SCRAP'] } },
          orderBy: { id: 'asc' },
          include: { reversals: { select: { id: true } } },
        });
        const movements = liveMovements(own);
        const adjust = movements.find((m) => m.itemType === 'PRODUCT' && m.type === 'ADJUST');
        const scrapOuts = movements.filter((m) => m.itemType === 'COIL' && m.type === 'OUT');

        if (adjust) {
          const after = await tx.inventoryMovement.findMany({
            where: { itemType: 'PRODUCT', itemId: order.productId, id: { gt: adjust.id } },
            orderBy: { id: 'asc' },
            include: { reversals: { select: { id: true } } },
          });
          const blocking = liveMovements(after).find((m) => m.type !== 'IN');
          if (blocking) {
            throw new BadRequestException(
              `Las planchas de esta orden ya se movieron (${blocking.type} ${blocking.refType}): anula ese movimiento antes de reabrirla`,
            );
          }
        }

        // Solo vuelven a la orden las bobinas que soltó el **cierre**: las que planta bajó a
        // mano antes ya no son suyas.
        const rows = await tx.productionOrderConsumption.findMany({
          where: { productionOrderId: orderId, releasedAt: order.closedAt },
          include: { coil: { select: { code: true, status: true } } },
          orderBy: { createdAt: 'asc' },
        });
        await assertStripsNotAssigned(
          tx,
          rows.map((r) => r.coilId),
          'reabrir la orden',
        );

        const lastOwnByCoil = new Map<string, bigint>();
        for (const movement of own) {
          if (movement.itemType !== 'COIL') continue;
          const current = lastOwnByCoil.get(movement.itemId);
          if (current === undefined || movement.id > current) {
            lastOwnByCoil.set(movement.itemId, movement.id);
          }
        }
        for (const row of rows) {
          await this.coils.lockCoil(tx, row.coilId);
          if (row.coil.status !== CoilStatus.OPEN) {
            throw new BadRequestException(
              `La bobina ${row.coil.code} ya no está disponible (${row.coil.status}): no se puede reabrir la orden`,
            );
          }
          // Una bobina que se consumió entera no dejó despunte, así que no hay movimiento
          // propio del cierre contra el cual medir "posterior": ahí la referencia es el
          // `closedAt` de la orden.
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
              `La bobina ${row.coil.code} ya tiene movimientos posteriores al cierre (${blocking.refType}): anúlalos antes de reabrir la orden`,
            );
          }
        }

        // Primero el costo y después el material: al revés, el ajuste se prorratearía sobre
        // un saldo que el despunte devuelto todavía no terminó de acomodar.
        if (adjust) await this.inventory.reverse(tx, adjust.id, actor.id, reason, operationDate);
        const returnedByCoil = new Map<string, Decimal>();
        for (const movement of scrapOuts) {
          await this.coils.lockCoil(tx, movement.itemId);
          await this.inventory.reverse(tx, movement.id, actor.id, reason, operationDate);
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
            consumedKg: null,
            materialCostPen: null,
            overheadCostPen: null,
            totalCostPen: null,
            unitCostPen: null,
            closedById: null,
            closedAt: null,
            closedOperationDate: null,
          },
        });

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'production.roofing.reopen',
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

    return this.production.findOne(orderId);
  }

  /**
   * Anula la orden y baja las bobinas que tomó. Solo con **cero reportes vigentes**: con
   * planchas ya producidas hay que revertir esos reportes primero, o el kardex quedaría con
   * producto sin la orden que lo explique.
   *
   * Como montar no mueve kardex (D-060), anular tampoco tiene nada que revertir: la bobina
   * vuelve a estar disponible tal como estaba, con su saldo intacto.
   */
  async cancel(
    actor: RequestUser,
    orderId: string,
    input: CancelProductionOrderInput,
  ): Promise<ProductionOrderDto> {
    const { reason } = input;
    // Anular una OP de coberturas no mueve kardex (D-060: montar es custodia), así que no
    // hay nada que fechar; la validación corre igual para que el contrato no mienta.
    this.operationDate.resolve(actor, input.operationDate);
    await this.prisma.$transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      assertKind(order, ProductionOrderKind.ROOFING);
      assertLive(order, 'anularla');

      const live = await tx.productionReport.findMany({
        where: { productionOrderId: orderId, status: ProductionReportStatus.ACTIVE },
        select: { pieces: true },
      });
      if (live.length > 0) {
        const planchas = live.reduce((acc, r) => acc + r.pieces, 0);
        throw new BadRequestException(
          `La orden tiene ${live.length} reporte(s) vigente(s) con ${planchas} planchas: revierte esos reportes antes de anularla`,
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

      // D-066: anular baja las bobinas, así que el material vuelve a estar prometido y la
      // reserva tiene que volver a `ACTIVA` con él. Es también lo que destraba la anulación
      // del pedido.
      const restored = order.reservationId
        ? await restoreReservationIfIdle(
            tx,
            orderId,
            order.reservationId,
            this.thicknessToleranceMm(),
          )
        : false;

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'production.roofing.cancel',
        entity: 'production_orders',
        entityId: orderId,
        before: { status: order.status },
        after: {
          status: ProductionOrderStatus.CANCELLED,
          reason,
          releasedCoils: released.count,
          ...(restored ? { reservationRestored: order.reservationId } : {}),
        },
      });
    });

    return this.production.findOne(orderId);
  }

  // -------------------------------------------------------------------------
  // D-086 — las bobinas que la orden puede montar
  // -------------------------------------------------------------------------

  /**
   * Bobinas candidatas para una OP de coberturas: abiertas, con saldo, de la línea del
   * producto, con espesor dentro de tolerancia y con **el mismo color** (igualdad estricta,
   * null incluido). Excluye las que otra orden ya tiene montadas (D-060) y las prometidas a
   * otro pedido (D-066) — salvo la reserva propia de esta orden, que es justo el material
   * que viene a rolar.
   */
  async coilOptions(productId: string, reservationId?: string): Promise<RoofingCoilOptionDto[]> {
    const product = await this.production.requireRoofingProduct(productId);

    // La excepción solo vale si esa reserva es de una línea que pide **este** producto: un
    // `reservationId` cualquiera listaba como libre una bobina prometida a otro pedido. No
    // era explotable —montarla se rechaza igual— pero un listado que miente sobre qué está
    // comprometido es exactamente lo que la reserva existe para evitar.
    const ownReservationId =
      reservationId !== undefined &&
      (await this.prisma.reservation.count({
        where: { id: reservationId, salesOrderItem: { productId } },
      })) > 0
        ? reservationId
        : undefined;

    const coils = await this.prisma.coil.findMany({
      // D-127: el filtro vive en `roofing-coil-match` porque la confirmación de una
      // cotización a medida hace la misma pregunta y no puede responderla distinto.
      where: roofingCoilWhere({
        businessLineId: product.businessLineId,
        colorId: product.colorId,
        inputThicknessMm: product.thicknessMm,
        toleranceMm: this.thicknessToleranceMm(),
      }),
      select: {
        id: true,
        code: true,
        typeKey: true,
        widthMm: true,
        thicknessMm: true,
        colorId: true,
        color: { select: { name: true, hexColor: true } },
        finish: { select: { code: true, densityFactor: true } },
      },
      orderBy: { code: 'asc' },
      take: 500,
    });
    if (coils.length === 0) return [];

    const ids = coils.map((c) => c.id);
    const [balances, assignments, reservations] = await Promise.all([
      this.prisma.inventoryBalance.findMany({
        where: { itemType: 'COIL', itemId: { in: ids } },
        select: { itemId: true, qty: true },
      }),
      findLiveStripAssignments(this.prisma, ids),
      this.prisma.reservation.findMany({
        where: {
          status: ReservationStatus.ACTIVE,
          itemType: InventoryItemType.COIL,
          itemId: { in: ids },
        },
        select: { id: true, itemId: true },
      }),
    ]);
    const qtyById = new Map(balances.map((b) => [b.itemId, toDecimal(b.qty.toString())]));
    const taken = new Set(assignments.map((a) => a.coilId));
    const promised = new Set(
      reservations.filter((r) => r.id !== ownReservationId).map((r) => r.itemId),
    );

    return coils
      .filter(
        (c) =>
          !taken.has(c.id) && !promised.has(c.id) && (qtyById.get(c.id) ?? new Decimal(0)).gt(0),
      )
      .map((c) => {
        const availableKg = qtyById.get(c.id) ?? new Decimal(0);
        const geometry: CoilGeometry = {
          widthMm: c.widthMm.toFixed(2),
          thicknessMm: c.thicknessMm.toFixed(2),
          densityFactor: c.finish.densityFactor.toFixed(4),
        };
        return {
          coilId: c.id,
          code: c.code,
          typeKey: c.typeKey,
          finishCode: c.finish.code,
          widthMm: c.widthMm.toFixed(2),
          thicknessMm: c.thicknessMm.toFixed(2),
          colorId: c.colorId,
          colorName: c.color?.name ?? null,
          colorHex: c.color?.hexColor ?? null,
          availableKg: availableKg.toFixed(3),
          estimatedMeters: toFixedString(metersFromKg(geometry, availableKg.toFixed(3)), 'KG'),
        };
      });
  }

  /** La tolerancia de D-086, con el override de entorno que documenta esa decisión. */
  private thicknessToleranceMm(): string {
    return roofingToleranceMm(this.env);
  }
}

/** Fila persistida de largos → la forma mínima que la aritmética compartida necesita. */
/**
 * El texto que un error de dominio le tiene que dejar a la fila de la tanda (D-147). El
 * cuerpo de un `HttpException` de Nest es una cadena o un objeto con `message`, y sin esto
 * el mapa de fallas guardaba "[object Object]" justo en el caso que la pantalla necesita
 * leer.
 */
function messageOf(err: HttpException): string {
  const body: unknown = err.getResponse();
  if (typeof body === 'string') return body;
  // `null` incluido: sin este chequeo, leer `.message` lanzaba **dentro** del `catch` de la
  // tanda y una fila con un error raro salía como 500 opaco en vez de como su motivo.
  if (body === null || typeof body !== 'object') return err.message;
  const message: unknown = (body as { message?: unknown }).message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.join(', ');
  return err.message;
}

function toPieceLike(row: { lengthMm: Prisma.Decimal; qty: number }): PieceLike {
  return { lengthMm: row.lengthMm.toFixed(2), qty: row.qty };
}

/** Reexportado para que el módulo no tenga que importar el tipo desde dos sitios. */
export type { LockedOrder };
