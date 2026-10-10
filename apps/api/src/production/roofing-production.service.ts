import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
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
  businessToday,
  CoilFilmSource,
  CoilFilmState,
  compareQueueRank,
  Decimal,
  finishRal,
  describePieces,
  isAccessory,
  checkRoofingPlanAdjustment,
  isOverdue,
  queueSemaphore,
  fromDateOnly,
  MAX_ORDER_REPORTS,
  MAX_ORDER_STRIPS,
  MAX_SCRAP_RATIO_WITHOUT_REASON,
  mountedKgForReport,
  piecesCount,
  piecesMeters,
  productionOrderCode,
  remainingPlanPieces,
  roofingConsumptionDeviation,
  closeShortfallMessage,
  planExcessMessage,
  roofingPlanGap,
  roofingPlanOverrun,
  roofingPlanProgress,
  salesOrderCode,
  thicknessWithinTolerance,
  toDateOnly,
  toDecimal,
  toFixedString,
  toleranceOverrideLabel,
  Unit,
  type CancelProductionOrderInput,
  type CloseRoofingOrderInput,
  type CreateRoofingOrderInput,
  type CreateRoofingOrdersFromSalesOrderInput,
  type MountRoofingCoilInput,
  type PieceLike,
  type RoofingPieceDto,
  type PlantClosePreviewDto,
  type ProductionOrderDto,
  type ProductionQueueEntryDto,
  type RawMaterialWarningDto,
  type ReportAndCloseRoofingInput,
  type ReportRoofingPiecesInput,
  type ReverseMovementInput,
  type RoofingBatchCreateResultDto,
  type RoofingBatchOrderDto,
  type RoofingCoilOptionDto,
  type SetProductionOrderPriorityInput,
  type UpdateRoofingPlanInput,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { sellerWhere } from '../auth/seller-scope';
import { autoTerminateEmptyCoils, reopenAutoTerminatedCoils } from '../coils/coil-auto-terminate';
import { openFilmIfSealed, resealIfOpenedBy } from '../coils/coil-film';
import {
  CoilOperationsService,
  MOUNT_SURPLUS_ALLOWED_OUTS,
} from '../coils/coil-operations.service';
import { CoilsService } from '../coils/coils.service';
import { ENV, type Env } from '../config/env';
import { claimIdempotencyKey } from '../common/idempotency';
import { OperationDateService } from '../common/operation-date.service';
import { CLOSE_PREVIEW_TIMEOUT_MS, previewPlantClose } from './close-preview';
import { preferExactFinish, roofingCoilWhere, roofingToleranceMm } from './roofing-coil-match';
import { DRAFT_INCLUDE, draftCoilStates, draftDtos } from './roofing-drafts';
import { InventoryService } from '../inventory/inventory.service';
import { liveMovements } from '../inventory/live-movements';
import { lockDocuments } from '../inventory/document-locks';
import { itemRefOf } from '../inventory/row-locks';
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
import { findRawMaterialShortfalls, type RawMaterialShortfall } from '../sales/raw-material';
import { reservedByItem } from '../sales/reserved-ledger';
import { sellsByLength } from '../sales/sales-lines';
import { assertStripsNotAssigned, findLiveStripAssignments } from './production-assignments';
import { allocateStripKg, type StripAllocationRow } from './production-math';
import {
  assertKind,
  assertLive,
  lockOrder,
  recomputeStatus,
  resolveActorNames,
  restoreReservationIfIdle,
  appliedToleranceOverride,
  assertToleranceReasonApplies,
  mountedKgRejection,
  otherMountedCoilsHint,
  TOLERANCE_OVERRIDE_AUDIT_ACTION,
  toleranceOverrideAuditAfter,
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
import { allocateRoofingScrap } from './roofing-scrap';
import { sumReportedMeters } from './reported-meters';

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
/**
 * Orden por unidad de código: el mismo que el `.sort()` sin argumento que usan los demás locks
 * de bobinas. No `localeCompare`, que puede ordenar distinto los guiones de un UUID y cruzar el
 * orden de bloqueo con el resto del sistema.
 */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

@Injectable()
export class RoofingProductionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly coils: CoilsService,
    private readonly coilOperations: CoilOperationsService,
    private readonly production: ProductionService,
    private readonly operationDate: OperationDateService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // -------------------------------------------------------------------------
  // D-154 — de quién es la promesa que esta orden no tiene que respetar
  // -------------------------------------------------------------------------

  /**
   * El alcance que la invariante del agregado (D-134) **no** cuenta en contra de esta orden:
   * su propia reserva y todas las hermanas del mismo pedido.
   *
   * La segunda mitad es la que faltaba. Un pedido de coberturas reserva materia prima **una
   * vez por línea** y genera una OP por reserva (D-084/D-148), así que montar la bobina de la
   * primera línea se comprobaba contra la promesa —viva, del mismo pedido— de la segunda y
   * salía "hay 150.000 kg prometidos a PED-000003" sobre el pedido que planta estaba
   * fabricando. Un pedido no puede bloquearse a sí mismo: si el material no alcanza para sus
   * propias líneas, eso se ve al confirmarlo, no en la roladora.
   */
  private async ownPromiseScope(
    tx: Prisma.TransactionClient,
    order: { reservationId: string | null },
  ): Promise<{ exceptReservationIds: string[]; exceptSalesOrderIds: string[] }> {
    if (!order.reservationId) return { exceptReservationIds: [], exceptSalesOrderIds: [] };
    const reservation = await tx.reservation.findUnique({
      where: { id: order.reservationId },
      select: { salesOrderId: true },
    });
    return {
      exceptReservationIds: [order.reservationId],
      exceptSalesOrderIds: reservation ? [reservation.salesOrderId] : [],
    };
  }

  // -------------------------------------------------------------------------
  // D-084 — la orden nace del pedido, con su plan de corte copiado
  // -------------------------------------------------------------------------

  /**
   * D-186: lanza lo mismo que `createFromReservationInTx` lanzaría por el catálogo (espesor,
   * ancho, acabado del SKU). La vista previa de confirmar lo usa para decirlo antes del clic.
   */
  async assertProducible(productId: string): Promise<void> {
    await this.production.requireRoofingProduct(productId);
  }

  async create(actor: RequestUser, input: CreateRoofingOrderInput): Promise<ProductionOrderDto> {
    // D-124: fecha en que la corrida arranca. Montar la bobina es custodia, no consumo
    // (D-060), así que crear la OP no mueve kardex y no hay guardrail que aplicar acá.
    const orderOperationDate = this.operationDate.resolve(actor, input.operationDate);
    const orderId = await this.prisma.$transaction(async (tx) => {
      if (input.reservationId === undefined) {
        // **D-171: producir coberturas a stock deja de existir.** Es la contracara de que la
        // plancha se produzca contra el pedido: si además se pudiera producir a stock,
        // quedaría un saldo de producto terminado que ningún pedido consume nunca —cada uno
        // reserva materia prima y rola lo suyo— y ese saldo envejecería en el valorizado sin
        // que nadie pudiera venderlo.
        //
        // **Es una decisión de negocio del dueño y es reversible**: si mañana quiere reponer
        // mostrador con planchas hechas de antemano, lo que hay que decidir primero es qué
        // hace una línea de pedido cuando ese saldo existe (¿lo toma?, ¿lo ignora y produce
        // igual?, ¿lo toma hasta donde alcanza y produce el resto?). Esa pregunta es la que no
        // tiene respuesta hoy, y por eso la puerta se cierra en vez de dejarse entreabierta.
        // `createToStock` sigue en el archivo, sin llamadores, para que reabrirla sea volver a
        // enchufarla y no volver a escribirla.
        throw new BadRequestException(
          'Una cobertura no se produce a stock: se fabrica contra el pedido que reserva su ' +
            'material (D-171). Confirmá el pedido y producí desde su reserva.',
        );
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
    // "reserva ya tomada" y el material quedaba prometido a dos órdenes. cc30 (D-472): la reserva
    // con su pedido delante —pedido → reserva—, y el estado del pedido se lee ya bloqueado.
    const owner = await tx.reservation.findUnique({
      where: { id: input.reservationId },
      select: { salesOrderId: true },
    });
    await lockDocuments(tx, {
      salesOrders: [owner?.salesOrderId],
      reservations: [input.reservationId],
    });
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
      // **D-171 revirtió D-140.** Hasta acá una plancha de catálogo reservaba producto
      // terminado y este camino la rechazaba: se vendía del saldo que hubiera y, si faltaba,
      // planta producía a stock por separado. El dueño corrigió la premisa —una plancha no es
      // stock terminado, se rola contra el pedido igual que una cobertura a medida— y con eso
      // toda línea de coberturas llega acá con reserva de materia prima.
      //
      // Lo que queda alcanzando esta rama es una línea de **otra** cosa: un perfil de drywall,
      // un producto de trading, o una plancha confirmada bajo el modelo viejo cuyo pedido ya
      // reservó unidades. Ninguna se fabrica en la roladora de coberturas.
      throw new BadRequestException(
        'Esa línea del pedido reserva producto terminado, no materia prima: se atiende con el ' +
          'saldo que ya hay en el almacén y no con una orden de coberturas. Si es una plancha ' +
          'de un pedido anterior a D-171, anulá el pedido y volvé a confirmarlo para que ' +
          'reserve el material que va a rolar.',
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
      // D-343: un accesorio no tiene plan de largos —sus reportes no dejan detalle de largos, así
      // que un plan haría que cada reporte se compare solo contra él y no acumule (D-146)—; lo
      // que pide el pedido son sus metros.
      const planned = await tx.product.findUniqueOrThrow({
        where: { id: order.productId },
        select: { roofingKind: true, unit: true },
      });
      if (isAccessory(planned)) {
        throw new BadRequestException(
          'Un accesorio no lleva plan de largos: lo que pide el pedido son sus metros lineales de bobina',
        );
      }

      // D-191: el plan nuevo no puede quedar por debajo de lo que el borrador ya ocupa sobre lo
      // reportado. Sin esto el borrador quedaba inválido en silencio y planta se enteraba
      // recién al ejecutarlo.
      const drafts = await tx.productionReportDraft.findMany({
        where: { productionOrderId: orderId },
        select: { pieces: { select: { lengthMm: true, qty: true } } },
      });
      if (drafts.length > 0) {
        const reported = await tx.productionReport.findMany({
          where: { productionOrderId: orderId, status: ProductionReportStatus.ACTIVE },
          select: { piecesDetail: { select: { lengthMm: true, qty: true } } },
        });
        const occupied = piecesMeters([
          ...reported.flatMap((r) => r.piecesDetail.map(toPieceLike)),
          ...drafts.flatMap((d) => d.pieces.map(toPieceLike)),
        ]);
        const planMeters = piecesMeters(
          input.items.map((p) => ({ lengthMm: toFixedString(p.lengthMm, 'MM'), qty: p.qty })),
        );
        if (planMeters.lt(occupied)) {
          throw new BadRequestException(
            `El plan nuevo suma ${planMeters.toFixed(3)} m y entre lo reportado y el borrador ya hay ` +
              `${occupied.toFixed(3)} m: quita o corrige filas del borrador antes de achicar el plan`,
          );
        }
      }

      const before = await tx.productionOrderItem.findMany({
        where: { productionOrderId: orderId },
        orderBy: { lineNumber: 'asc' },
      });

      // cc35 (ESPEC §3, D-545/D-546): ningún largo baja de lo ya reportado y, a medida, el plan
      // nuevo suma exactamente los metros del vigente. La misma regla que pinta la pantalla.
      const reportedNow = await tx.productionReport.findMany({
        where: { productionOrderId: orderId, status: ProductionReportStatus.ACTIVE },
        select: { piecesDetail: { select: { lengthMm: true, qty: true } } },
      });
      const adjustment = checkRoofingPlanAdjustment({
        current: before.map(toPieceLike),
        next: input.items.map((p) => ({ lengthMm: toFixedString(p.lengthMm, 'MM'), qty: p.qty })),
        reported: reportedNow.flatMap((r) => r.piecesDetail.map(toPieceLike)),
        // cc38 (D-574): mismos metros también en la plancha de catálogo (antes, D-545, libre).
        exactMeters: true,
      });
      if (!adjustment.ok) throw new BadRequestException(adjustment.message);

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
    const warnings: RawMaterialShortfall[] = [];
    // D-192: una o varias bobinas, en una sola transacción (todo o nada). Se recorren en orden
    // de id para que dos montajes de **las mismas** bobinas las tomen en el mismo orden. No
    // alcanza contra todo cruce: la comprobación del agregado (`findRawMaterialShortfalls`)
    // bloquea después las bobinas compatibles, y un montaje concurrente de otra bobina de la
    // misma spec puede tomarlas al revés — Postgres aborta una y el usuario reintenta, igual
    // que ya pasaba con una sola bobina.
    const coilIds = [...(input.coilIds ?? (input.coilId === undefined ? [] : [input.coilId]))].sort(
      byCodeUnit,
    );
    // D-193: las cerradas que planta confirmó reabrir. El asiento compensatorio se fecha hoy: es
    // un hecho de hoy (se reabre para montarla ahora), no una corrección del cierre original.
    const reopenIds = new Set(input.reopenCoilIds ?? []);
    // D-328: el día de negocio de la apertura del film, que es el del montaje (hoy).
    const mountDate = this.operationDate.resolve(actor, undefined);
    const reopenDate = reopenIds.size > 0 ? mountDate : '';
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
        const mounted: {
          consumptionId: string;
          coilId: string;
          coilCode: string;
          assignedKg: string;
        }[] = [];
        // D-386: todas las bobinas del montaje con sus agregados en una sola sentencia, y el
        // saldo de las que se reabren (D-193 revierte su ajuste de cierre), antes del bucle. Era
        // el cruce que el comentario de arriba aceptaba: la bobina i y su saldo en mano mientras
        // se pedía la i+1, y el agregado bloqueado recién en la comprobación final.
        const reopenRefs =
          reopenIds.size === 0
            ? []
            : (
                await tx.coil.findMany({
                  where: { id: { in: coilIds.filter((id) => reopenIds.has(id)) } },
                  select: { id: true, businessLineId: true },
                })
              ).map((c) => ({
                businessLineId: c.businessLineId,
                itemType: InventoryItemType.COIL,
                itemId: c.id,
                unit: Unit.KGM,
              }));
        await this.inventory.lockInOrder(tx, { coilIds, items: reopenRefs });
        for (const coilId of coilIds) {
          const coil = await this.coils.lockCoil(tx, coilId);

          if (coil.kind !== CoilKind.COIL) {
            throw new BadRequestException(
              `${coil.code} es un fleje, no una bobina: la roladora de coberturas consume bobina (D-049)`,
            );
          }
          const reopening = coil.status === CoilStatus.CLOSED && reopenIds.has(coil.id);
          if (coil.status !== CoilStatus.OPEN && !reopening) {
            throw new BadRequestException(
              coil.status === CoilStatus.CLOSED
                ? `${coil.code} está terminada: para montarla hay que confirmar que se reabre (revierte el ajuste del cierre, D-193)`
                : `${coil.code} no está disponible (${coil.status}): solo una bobina vigente entra a producción`,
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

          // D-193: se reabre recién acá, con el rollo ya validado contra la orden (línea, espesor
          // y color): reabrir uno que después no se puede montar dejaría el kardex movido por
          // nada — aunque la transacción entera lo desharía igual.
          if (reopening) {
            await this.coilOperations.reopenInTx(
              tx,
              actor,
              coil.id,
              input.reopenReason ?? '',
              reopenDate,
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
          let availableKg = toDecimal(balance?.qty.toString() ?? '0');
          // cc29 (D-466): una terminada con el kardex en 0 (ya reabierta) entra con el peso físico
          // que planta declara, como sobrante nuevo; sin ese peso no hay nada que montar.
          const physicalKg = reopening ? input.physicalKg : undefined;
          if (input.physicalKg !== undefined && !reopening) {
            throw new BadRequestException(
              `${coil.code} no está terminada: el peso físico solo se declara al reabrir una bobina terminada con el kardex en 0`,
            );
          }
          if (physicalKg !== undefined && availableKg.gt(0)) {
            throw new BadRequestException(
              `${coil.code} tiene ${availableKg.toFixed(3)} kg en el kardex al reabrirla: el peso físico solo se declara con el kardex en 0`,
            );
          }
          if (availableKg.lte(0) && physicalKg === undefined) {
            throw new BadRequestException(
              reopening
                ? `${coil.code} está terminada con el kardex en 0: para montarla, declara su peso físico (el sobrante entra al kardex, D-466)`
                : `${coil.code} no tiene kilos disponibles en el kardex`,
            );
          }
          if (physicalKg !== undefined) availableKg = toDecimal(physicalKg);
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
          // cc29 (D-466): el sobrante entra apuntando a este montaje, después de reabrir: la
          // reapertura ya pasó y no lo revierte; bajar la bobina sin usarla sí.
          if (physicalKg !== undefined) {
            await this.coilOperations.declareMountSurplusInTx(
              tx,
              actor,
              coil,
              {
                physicalKg,
                reason: input.reopenReason ?? '',
                consumptionId: consumption.id,
                orderCode: productionOrderCode(order.seq),
              },
              reopenDate,
            );
          }
          await tx.productionOrder.update({
            where: { id: orderId },
            data: { status: ProductionOrderStatus.IN_PROGRESS },
          });
          // D-328: montar una bobina sellada la abre (la pantalla lo confirma antes). En este
          // punto la bobina ya está vigente —lo estaba, o `reopenInTx` la reabrió—, aunque la
          // fila leída arriba diga `CLOSED`. El evento guarda el consumo: `releaseCoil` la vuelve
          // a sellar solo si la apertura fue de un montaje.
          await openFilmIfSealed(
            tx,
            { id: coil.id, status: CoilStatus.OPEN, filmSealed: coil.filmSealed },
            {
              source: CoilFilmSource.MOUNT,
              operationDate: mountDate,
              actorId: actor.id,
              refId: consumption.id,
            },
          );

          mounted.push({
            consumptionId: consumption.id,
            coilId: coil.id,
            coilCode: coil.code,
            assignedKg: toFixedString(assignedKg, 'KG'),
          });
        }

        // D-134: montar saca del disponible del agregado los kilos que la orden retiene, sin
        // mover un gramo de kardex (D-060), así que es exactamente la clase de operación que la
        // invariante por ítem no ve.
        //
        // **D-154: avisa, nunca bloquea.** Las promesas del propio pedido no cuentan (ver
        // `ownPromiseScope`), y si aun así el agregado queda corto para pedidos ajenos, el
        // montaje entra igual y el aviso viaja en la respuesta y al `audit_log`.
        //
        // D-192: **una sola vez para todas las bobinas**, después del loop. La comprobación
        // recorre y bloquea el agregado entero; hecha por bobina, montar veinte multiplicaba ese
        // costo por veinte dentro del mismo presupuesto de transacción.
        const shortfalls = await findRawMaterialShortfalls(
          tx,
          mounted.map((m) => m.coilId),
          this.thicknessToleranceMm(),
          await this.ownPromiseScope(tx, order),
        );
        warnings.push(...shortfalls);
        const warningMessages =
          shortfalls.length === 0 ? null : dedupeWarnings(shortfalls).map((w) => w.message);
        for (const m of mounted) {
          await this.audit.write(tx, {
            actorId: actor.id,
            action: 'production.roofing.mount',
            entity: 'production_orders',
            entityId: orderId,
            after: { ...m, rawMaterialWarnings: warningMessages },
          });
        }
      },
      // Cada bobina suma su lock, sus lecturas y su asignación: el presupuesto crece con ellas.
      { timeout: 30_000 + 3_000 * Math.max(coilIds.length - 1, 0), maxWait: 10_000 },
    );

    return this.withWarnings(await this.production.findOne(orderId), warnings);
  }

  /**
   * Cuelga de la respuesta los avisos que dejó **esta** operación (D-154). No toca la orden
   * en la base: es un campo de la respuesta, y un `GET` posterior no lo trae.
   */
  withWarnings(order: ProductionOrderDto, warnings: RawMaterialShortfall[]): ProductionOrderDto {
    const unique = dedupeWarnings(warnings);
    if (unique.length === 0) return order;
    return { ...order, rawMaterialWarnings: unique.map(toWarningDto) };
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
      // D-191: el borrador que sale de esta bobina quedaría apuntando a un rollo desmontado.
      const drafted = await tx.productionReportDraft.count({
        where: { productionOrderId: orderId, coilId: consumption.coilId },
      });
      if (drafted > 0) {
        throw new BadRequestException(
          `${consumption.coil.code} tiene ${String(drafted)} fila(s) en el borrador de la orden: quítalas o cámbialas de bobina antes de bajarla`,
        );
      }

      await tx.productionOrderConsumption.update({
        where: { id: consumption.id },
        data: { releasedAt: new Date() },
      });
      await recomputeStatus(tx, orderId);

      // D-328: bajar una bobina que el montaje abrió, sin que nada haya salido de ella, la
      // vuelve a sellar. Si se abrió a mano, o ya se usó, o sigue montada en otra orden, no.
      // A-2 de la autorrevisión del corte 2 (regla 17): la reversa del sobrante (D-466) toca el
      // saldo de la bobina y la invariante de materia prima, así que la bobina, su agregado y su
      // saldo se toman juntos, en orden, antes de leer nada.
      await this.inventory.lockInOrder(tx, {
        items: [
          {
            businessLineId: order.businessLineId,
            itemType: InventoryItemType.COIL,
            itemId: consumption.coilId,
            unit: Unit.KGM,
          },
        ],
      });
      const coil = await this.coils.lockCoil(tx, consumption.coilId);
      const resealed = await resealIfOpenedBy(
        tx,
        coil,
        {
          source: CoilFilmSource.MOUNT,
          undoSource: CoilFilmSource.MOUNT_UNDO,
          refId: consumption.id,
        },
        { operationDate: this.operationDate.resolve(actor, undefined), actorId: actor.id },
      );

      // cc29 (D-466): la reversa del sobrante que este montaje declaró, si declaró uno. Antes de
      // la red de D-360: sin él, la bobina vuelve a 0 y se termina sola, como estaba.
      const surplus = await this.coilOperations.reverseMountSurplusInTx(
        tx,
        actor,
        consumption.coilId,
        consumption.id,
        this.operationDate.resolve(actor, undefined),
      );

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'production.roofing.release',
        entity: 'production_orders',
        entityId: orderId,
        after: {
          consumptionId,
          coilCode: consumption.coil.code,
          filmResealed: resealed,
          surplusReversed: surplus === null ? null : { ...surplus },
        },
      });
      // D-360: si al bajarla está en exactamente 0, se termina (red de seguridad: bajar exige consumo 0).
      await autoTerminateEmptyCoils(tx, this.audit, {
        actorId: actor.id,
        coilIds: [consumption.coilId],
        cause: {
          kind: 'COIL_RELEASE',
          refId: orderId,
          label: `bajada de ${productionOrderCode(order.seq)}`,
        },
        operationDate: this.operationDate.resolve(actor, undefined),
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
    const warnings = await this.prisma.$transaction(
      async (tx) => {
        // F8-S1/M2: mismo criterio que `ProductionService.report` — un doble click no debe
        // descontar la reserva de bobina ni sumar producto terminado dos veces.
        const claim = await claimIdempotencyKey(tx, 'roofing-report', input.idempotencyKey);
        if (!claim.claimed) return [];
        return this.reportInTx(tx, actor, orderId, input, operationDate);
      },
      { timeout: 30_000 },
    );

    return this.withWarnings(await this.production.findOne(orderId), warnings);
  }

  /**
   * El cuerpo de `report`, **dentro de la transacción del llamador** (patrón `*InTx`,
   * D-099).
   *
   * Sigue partido en dos aunque la tanda de D-147 ya no exista: la importación de ventas y el
   * espacio de producción del pedido (D-155) entran por acá, y con dos copias el tope del
   * plan (D-146) y el traslado de la promesa (D-088) vivirían en dos lugares y divergirían —
   * que es exactamente cómo llegó desplegado D-145.
   *
   * Devuelve los avisos del agregado que dejó (D-154): el llamador los cuelga de la respuesta.
   */
  async reportInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    orderId: string,
    input: ReportRoofingPiecesInput,
    operationDate: string,
  ): Promise<RawMaterialShortfall[]> {
    // D-388/D-389: la casilla la marca cualquiera que pueda reportar (el controlador ya limita los
    // roles); sin administrador de por medio desde D-389.
    const override = input.toleranceOverride;
    const order = await lockOrder(tx, orderId, { parent: true });
    assertKind(order, ProductionOrderKind.ROOFING);
    // cc30 (grupo C): las dos reservas que el reporte escribe —la de materia prima de la OP, que se
    // descuenta, y la del producto fabricado de la misma línea (D-088), que sube después de los
    // saldos— se toman ahora, juntas y por id, detrás de pedido y OP y antes del inventario.
    if (order.reservationId) {
      const line = await tx.reservation.findUniqueOrThrow({
        where: { id: order.reservationId },
        select: { salesOrderItemId: true },
      });
      const onProduct = await findLineReservation(
        tx,
        line.salesOrderItemId,
        InventoryItemType.PRODUCT,
        order.productId,
      );
      await lockDocuments(tx, { reservations: [order.reservationId, onProduct?.id] });
    }
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
      select: { sku: true, unit: true, lengthMm: true, widthMm: true, roofingKind: true },
    });

    // D-343: un accesorio reporta **metros lineales de bobina**, no largos; todo lo demás, largos.
    // El schema solo garantiza que venga una de las dos formas: cuál corresponde lo decide el
    // subtipo del producto de la orden, que solo el servicio conoce.
    const accessory = isAccessory(product);
    if (accessory && input.meters === undefined) {
      throw new BadRequestException(
        `${product.sku} es un accesorio: reporta los metros lineales de bobina que usó, no largos`,
      );
    }
    if (!accessory && input.meters !== undefined) {
      throw new BadRequestException(
        `${product.sku} no es un accesorio: detalla los largos que salieron`,
      );
    }
    const inputPieces = input.pieces ?? [];

    // D-083: una plancha de catálogo tiene el largo en su SKU. Reportar otro largo la
    // convertiría en un producto distinto metido en el mismo saldo.
    if (product.lengthMm !== null) {
      const fixed = product.lengthMm.toFixed(2);
      const off = inputPieces.find((p) => toFixedString(p.lengthMm, 'MM') !== fixed);
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
    // D-343: los metros de un accesorio entran a la cuenta como **un solo largo de esa longitud**.
    // Es solo el vehículo aritmético —el kilo teórico por metro, lo que entra al kardex, lo que
    // se topa contra lo montado— y **no** se guarda como plan ni como detalle de largos: el
    // reporte guarda `meters_m` directo y ninguna fila de `production_report_pieces`.
    const pieces = accessory
      ? [
          {
            lineNumber: 1,
            lengthMm: toFixedString(toDecimal(input.meters ?? '0').times(1000), 'MM'),
            qty: 1,
          },
        ]
      : inputPieces.map((p, i) => ({
          lineNumber: i + 1,
          lengthMm: toFixedString(p.lengthMm, 'MM'),
          qty: p.qty,
        }));
    /** Cómo se nombra lo reportado en el kardex y la auditoría: largos, o metros de bobina. */
    const reportLabel = accessory
      ? `${toDecimal(input.meters ?? '0').toFixed(3)} m de bobina`
      : describePieces(pieces);
    const neededKg = roofingTheoreticalKg(geometry, pieces);

    // -----------------------------------------------------------------------
    // D-146 — el plan de corte es un tope duro, no una intención
    // -----------------------------------------------------------------------
    //
    // Hasta acá la única cota de un reporte era el **material montado**: una orden de 100 ML
    // con un rollo entero encima podía reportar 300 ML sin que nada se quejara, y esos metros
    // de más nacían reservados a nombre del pedido (D-088) o entraban como stock que nadie
    // encargó. El plan dejó de ser solo una intención para esto: cambiar lo que hay que
    // producir es `updatePlan`, no reportar de más. cc35 (D-545): a medida, `updatePlan` reparte los
    // mismos metros; producir más que el pedido solo se puede en una plancha de catálogo.
    const planRows = await tx.productionOrderItem.findMany({
      where: { productionOrderId: orderId },
      orderBy: { lineNumber: 'asc' },
      select: { lengthMm: true, qty: true },
    });
    const liveReportRows = await tx.productionReport.findMany({
      where: { productionOrderId: orderId, status: ProductionReportStatus.ACTIVE },
      select: {
        consumedKg: true,
        metersM: true,
        piecesDetail: { select: { lengthMm: true, qty: true } },
      },
    });
    const planPieces = planRows.map(toPieceLike);
    const reportedPieces = liveReportRows.flatMap((r) => r.piecesDetail.map(toPieceLike));
    const progress = roofingPlanProgress(planPieces, piecesMeters(reportedPieces));
    const newMeters = piecesMeters(pieces);
    // cc38 (D-574): el rechazo nombra cuánto se pasa; el detalle de plan y reportado ya está en
    // la pantalla, que muestra la barra de avance.
    const overrun = roofingPlanOverrun(progress, newMeters);
    if (overrun.gt(0)) {
      throw new BadRequestException(planExcessMessage(overrun));
    }

    // D-146, segunda mitad, **corregida por D-154**: los kilos que planta declara para este
    // reporte. **No es un consumo** —el kardex sale por `neededKg`, y el consumo real se
    // reconcilia al cerrar (D-089)—, así que pasarse del kilo teórico del plan no rompe nada:
    // solo describe una corrida que gastó más de lo que la geometría dice, que es justamente
    // lo que hay que poder anotar. Como tope duro convertía el dato observado en un dato que
    // había que falsear para poder guardarlo. Queda como **aviso de desviación**, del mismo
    // lado que el aviso del agregado.
    const declaredKg = input.consumedKg === undefined ? null : toDecimal(input.consumedKg);
    const deviation: string[] = [];
    if (declaredKg !== null) {
      const alreadyDeclaredKg = liveReportRows.reduce(
        (acc, r) =>
          acc.plus(r.consumedKg === null ? new Decimal(0) : toDecimal(r.consumedKg.toString())),
        new Decimal(0),
      );
      const note = roofingConsumptionDeviation({
        declaredKg,
        theoreticalKg: neededKg,
        alreadyDeclaredKg,
        planKg: progress.hasPlan ? roofingTheoreticalKg(geometry, planPieces) : null,
      });
      if (note !== null) deviation.push(note);
    }

    // D-343 → cc38 (D-573, D-574): un accesorio no tiene plan de largos; su plan son los **metros**
    // que encargó la línea del pedido. Hasta cc38 pasarse solo avisaba; con D-573 la orden se
    // cierra solo con esos metros exactos, así que un reporte que los pasa dejaría la orden sin
    // poder cerrarse nunca: se rechaza igual que en una cobertura con plan.
    if (accessory && order.reservationId) {
      const orderedMl = await accessoryOrderedMeters(tx, order.reservationId);
      const reportedBeforeMl = liveReportRows.reduce(
        (acc, r) => (r.metersM === null ? acc : acc.plus(toDecimal(r.metersM.toString()))),
        new Decimal(0),
      );
      const { excess } = roofingPlanGap(orderedMl, reportedBeforeMl.plus(newMeters));
      if (excess.gt(0)) throw new BadRequestException(planExcessMessage(excess));
    }

    // D-345 (P2 de 03b): los kilos que el pedido reservó y el piso de precio de un accesorio salen
    // del ancho **del SKU**, pero lo que se produce sale con el ancho de la bobina montada. Si
    // difieren, el kardex sale con el real y la reserva quedó calculada con otro número: no se
    // bloquea —el ancho del SKU es nominal y el operario monta el rollo que hay—, se **avisa** en
    // el reporte y en la auditoría para que quien revise vea de dónde sale la diferencia.
    if (accessory && product.widthMm !== null && !product.widthMm.equals(row.coil.widthMm)) {
      deviation.push(
        `La bobina montada ${row.coil.code} mide ${row.coil.widthMm.toFixed(2)} mm de ancho y el SKU ${product.sku} declara ${product.widthMm.toFixed(2)} mm: los kilos que reservó el pedido y el piso de precio salieron del ancho del SKU, y el kardex sale con el de la bobina.`,
      );
    }

    // Un solo rollo por reporte, así que el reparto es trivial — pero pasa por el mismo
    // `allocateStripKg` que drywall para heredar su mensaje cuando el material no
    // alcanza, en vez de escribir una segunda versión del mismo chequeo.
    const rowRemainingKg = toDecimal(row.assignedKg.toString()).minus(
      toDecimal(row.consumedKg.toString()),
    );
    // D-246: si el teórico pasa lo montado y el acero ya salió (lo declarado cabe, o el
    // exceso entra en la tolerancia), el reporte se topa en lo montado en vez de bloquear.
    // El teórico queda en la fila del reporte como dato; el kardex sale por `outKg`.
    // D-388/D-389: pasado el 1 % sin casilla, el rechazo lleva su código y las cifras para que
    // la pantalla la ofrezca; pasado el 5 % el aviso es más fuerte, sin tope (D-389).
    const mounted = mountedKgForReport({
      label: row.coil.code,
      theoreticalKg: neededKg,
      availableKg: rowRemainingKg,
      declaredKg,
      // D-389: el accesorio (reporte por metros) también entra con la casilla, como las planchas.
      overrideBands: { authorized: override !== undefined },
    });
    if (!mounted.ok) {
      // cc28 (P2-2 de cc20): si otra bobina montada tiene saldo, el rechazo lo nombra.
      const hint =
        mounted.code === undefined
          ? null
          : otherMountedCoilsHint(
              row.coil.code,
              rows.map((r) => ({
                code: r.coil.code,
                remainingKg: Decimal.max(
                  toDecimal(r.assignedKg.toString()).minus(toDecimal(r.consumedKg.toString())),
                  new Decimal(0),
                ),
              })),
            );
      throw mountedKgRejection(
        hint === null ? mounted : { ...mounted, message: `${mounted.message} ${hint}` },
      );
    }
    if (mounted.note !== null) deviation.unshift(mounted.note);
    const applied = appliedToleranceOverride(mounted, override);
    if (applied !== null) {
      // D-389: el motivo tiene que aplicar a la dirección del exceso.
      assertToleranceReasonApplies(applied.override.reason);
      deviation.unshift(
        `Fuera de tolerancia, confirmado con la casilla: ${toleranceOverrideLabel(applied.override)}.`,
      );
    }
    const outKg = mounted.kg;
    const allocationRows: StripAllocationRow[] = [
      {
        consumptionId: row.id,
        coilId: row.coilId,
        coilCode: row.coil.code,
        remainingKg: rowRemainingKg,
      },
    ];
    const allocations = allocateStripKg(allocationRows, outKg);

    // D-171: el nombre importa con cuatro predicados en juego. Lo que decide en qué unidad
    // entra lo producido al kardex es **la unidad de venta**, o sea `sellsByLength`, y no el
    // subtipo: llamarlo `madeToMeasure` invitaba a responder con la pregunta equivocada.
    const byLength = sellsByLength(product);
    const outputQty = byLength ? piecesMeters(pieces) : new Decimal(piecesCount(pieces));
    const outputUnit = byLength ? Unit.MTR : Unit.NIU;

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
      // La misma fila que necesita `ownPromiseScope` (D-154): se lee una vez.
      // Pedido primero, reserva después: `SalesOrdersService.cancel` toma esos dos
      // recursos en ese mismo orden, y con el orden invertido anular un pedido y
      // reportar producción a la vez se trababan en un deadlock. cc30: el pedido ya viene
      // tomado de `lockOrder`, antes que la OP; esto no vuelve a esperar.
      await lockDocuments(tx, { salesOrders: [reservation.salesOrderId] });
      // **Siempre se descuenta** (D-134). Antes había que preguntar si el rollo que se
      // roló era el que el pedido había reservado, porque la promesa nombraba una bobina
      // concreta y nada obligaba a montar esa: descontar la promesa de un rollo del que
      // no salió un gramo la habría dejado por debajo de lo prometido sobre material
      // intacto. Con la reserva genérica esa pregunta desapareció: `mountCoil` solo
      // admite bobinas del color y el espesor del producto, que son exactamente las que
      // cumplen el agregado, así que cualquier kilo que esta orden role es un kilo del
      // agregado que el pedido prometía.
      await consumeReservationQty(tx, order.reservationId, outKg);
      await tx.salesOrder.updateMany({
        where: { id: reservation.salesOrderId, status: SalesOrderStatus.CONFIRMED },
        data: { status: SalesOrderStatus.IN_PRODUCTION },
      });
    }

    const report = await tx.productionReport.create({
      data: {
        productionOrderId: orderId,
        // D-343: en un accesorio son las piezas informativas que anotó el operario (o cero); no entran a nada.
        pieces: accessory ? (input.piecesCount ?? 0) : piecesCount(pieces),
        metersM: byLength ? toFixedString(piecesMeters(pieces), 'KG') : null,
        theoreticalKg: toFixedString(neededKg, 'KG'),
        // D-146: lo declarado se guarda tal cual y no toca ningún cálculo del kardex.
        consumedKg: declaredKg === null ? null : toFixedString(declaredKg, 'KG'),
        materialCostPen: '0',
        unitCostPen: '0',
        notes: input.notes ?? null,
        createdById: actor.id,
        operationDate: toDateOnly(operationDate),
        // D-343: un accesorio no tiene detalle de largos: los metros van en `meters_m`.
        ...(accessory ? {} : { piecesDetail: { create: pieces } }),
      },
    });

    let materialCostPen = new Decimal(0);
    const warnings: RawMaterialShortfall[] = [];
    const scope = {
      exceptReservationIds: order.reservationId ? [order.reservationId] : [],
      exceptSalesOrderIds: salesOrderId === null ? [] : [salesOrderId],
    };
    // D-386: bobinas con sus agregados, después los saldos de las bobinas y del producto, de una
    // vez y antes de la primera salida (pedido y reserva ya se tomaron arriba). Van todas las
    // bobinas montadas y no solo la del reparto: «reportar y cerrar» sigue con el cierre en la
    // misma transacción, y el despunte del cierre sale de cualquiera de ellas; así el cierre no
    // pide filas nuevas con saldos ya en mano.
    const mountedCoilIds = (
      await tx.productionOrderConsumption.findMany({
        where: { productionOrderId: orderId, releasedAt: null },
        select: { coilId: true },
      })
    ).map((r) => r.coilId);
    await this.inventory.lockInOrder(tx, {
      items: [
        ...[...mountedCoilIds, ...allocations.map((a) => a.coilId)].map((coilId) => ({
          businessLineId: order.businessLineId,
          itemType: InventoryItemType.COIL,
          itemId: coilId,
          unit: Unit.KGM,
        })),
        {
          businessLineId: order.businessLineId,
          itemType: InventoryItemType.PRODUCT,
          itemId: order.productId,
          unit: outputUnit,
        },
      ],
    });
    for (const allocation of allocations) {
      await this.coils.lockCoil(tx, allocation.coilId);
      // **La custodia se actualiza ANTES de emitir el kardex.** El saldo baja con el
      // movimiento y `heldKg` sale de `assignedKg − consumedKg`: con el orden invertido, en
      // el instante en que la invariante lee el agregado el saldo ya bajó y el consumo
      // todavía no, así que el disponible salía subestimado en exactamente los kilos que
      // este reporte acaba de sacar — un aviso falso, y encima persistido en el reporte.
      await tx.productionOrderConsumption.update({
        where: { id: allocation.consumptionId },
        data: {
          consumedKg: toFixedString(toDecimal(row.consumedKg.toString()).plus(allocation.kg), 'KG'),
        },
      });
      const out = await this.inventory.record(tx, {
        businessLineId: order.businessLineId,
        itemType: 'COIL',
        itemId: allocation.coilId,
        type: 'OUT',
        qty: toFixedString(allocation.kg, 'KG'),
        unit: Unit.KGM,
        refType: 'PRODUCTION',
        refId: report.id,
        notes: `Rolado de ${productionOrderCode(order.seq)}: ${reportLabel}`,
        actorId: actor.id,
        // D-134/D-154: ni lo que resta de la promesa que esta orden viene a cumplir ni la de
        // sus hermanas del mismo pedido pueden bloquear su propio consumo, y el faltante de
        // un pedido ajeno **avisa en vez de cortar**. Ver `ownPromiseScope` y
        // `RecordMovementInput.rawMaterialWarnings`.
        ...scope,
        rawMaterialWarnings: warnings,
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
      notes: `${productionOrderCode(order.seq)}: ${reportLabel}`,
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

    // D-154: el aviso queda **en la fila del reporte**, no solo en el log. Quien audita una
    // corrida corta de material mira sus reportes; obligarlo a cruzar `audit_log` para
    // enterarse de que el sistema ya lo había avisado es la diferencia entre un dato y una
    // arqueología. `null` cuando no hubo nada que avisar, que es el caso normal.
    const warningNote =
      [...deviation, ...dedupeWarnings(warnings).map((w) => w.message)].join(' ') || null;
    await tx.productionReport.update({
      where: { id: report.id },
      data: {
        materialCostPen: toFixedString(materialCostPen, 'MONEY'),
        unitCostPen: toFixedString(unitCostPen, 'MONEY'),
        rawMaterialWarning: warningNote,
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
        plan: reportLabel,
        outputQty: toFixedString(outputQty, 'KG'),
        outputUnit,
        theoreticalKg: toFixedString(neededKg, 'KG'),
        outKg: toFixedString(outKg, 'KG'),
        declaredKg: declaredKg === null ? null : toFixedString(declaredKg, 'KG'),
        planMeters: progress.planMeters.toFixed(3),
        reportedMetersAfter: progress.reportedMeters.plus(newMeters).toFixed(3),
        materialCostPen: toFixedString(materialCostPen, 'MONEY'),
        productReservationId,
        rawMaterialWarning: warningNote,
      },
    });

    // D-388: la autorización tiene su propia entrada, en el historial de la orden y con el
    // reporte adentro: es lo que el detalle de la orden lee para su etiqueta «Fuera de tolerancia».
    if (applied !== null) {
      await this.audit.write(tx, {
        actorId: actor.id,
        action: TOLERANCE_OVERRIDE_AUDIT_ACTION,
        entity: 'production_orders',
        entityId: orderId,
        after: toleranceOverrideAuditAfter({
          reportId: report.id,
          orderId,
          orderSeq: order.seq,
          coilId: row.coilId,
          coilCode: row.coil.code,
          realKg: toFixedString(outKg, 'KG'),
          applied,
        }),
      });
    }

    return warnings;
  }

  // -------------------------------------------------------------------------
  // D-155 — el espacio de producción: todas las órdenes abiertas de un pedido
  // -------------------------------------------------------------------------

  /**
   * Las órdenes de coberturas abiertas con todo lo que el espacio de producción (D-155)
   * necesita por pestaña. Sin `salesOrderId` son todas; con él, las de ese pedido.
   *
   * Es una consulta propia y no el listado de `/production` porque cada pestaña necesita
   * cuatro cosas que el listado omite a propósito: el plan de corte, los largos ya
   * reportados, la geometría de la bobina montada y la reserva de la orden (para pedirle al
   * selector las bobinas candidatas sin que la promesa propia se excluya a sí misma).
   * Pedirlas orden por orden con `findOne` serían N+1 requests desde el navegador, que es
   * justo lo que la pantalla viene a evitar.
   */
  async batchOrders(salesOrderId?: string): Promise<RoofingBatchOrderDto[]> {
    const orders = await this.prisma.productionOrder.findMany({
      where: {
        kind: ProductionOrderKind.ROOFING,
        status: { in: [ProductionOrderStatus.DRAFT, ProductionOrderStatus.IN_PROGRESS] },
        ...(salesOrderId ? { reservation: { salesOrderId } } : {}),
      },
      include: {
        product: {
          select: { sku: true, name: true, unit: true, lengthMm: true, roofingKind: true },
        },
        items: { orderBy: { lineNumber: 'asc' }, select: { lengthMm: true, qty: true } },
        reservation: {
          select: {
            // D-343: los metros que encargó la línea, que en un accesorio son el «plan».
            salesOrderItem: { select: { qty: true } },
            salesOrder: {
              select: {
                id: true,
                seq: true,
                promisedDeliveryDate: true,
                customer: { select: { name: true } },
              },
            },
          },
        },
        reports: {
          where: { status: ProductionReportStatus.ACTIVE },
          select: {
            id: true,
            theoreticalKg: true,
            consumedKg: true,
            metersM: true,
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
        // D-191: el borrador de la orden viaja con la pestaña, igual que su plan.
        reportDrafts: { include: DRAFT_INCLUDE, orderBy: { seq: 'asc' } },
      },
      orderBy: { seq: 'asc' },
      take: 500,
    });

    // cc38 (D-576): de qué bobina salió cada parte vigente, para que cada bobina muestre lo que ya
    // tiene registrado. Un parte sale de un solo rollo; su bobina es la de su salida de kardex
    // (cc34). Una sola consulta para todo el lote.
    const reportIds = orders.flatMap((o) => o.reports.map((r) => r.id));
    const coilOfReport = new Map(
      reportIds.length === 0
        ? []
        : liveMovements(
            await this.prisma.inventoryMovement.findMany({
              where: {
                refType: 'PRODUCTION',
                refId: { in: reportIds },
                itemType: 'COIL',
                type: 'OUT',
              },
              select: {
                id: true,
                refId: true,
                itemId: true,
                reversalOfId: true,
                reversals: { select: { id: true } },
              },
            }),
          ).map((m) => [m.refId, m.itemId]),
    );

    const rows = orders.map((order): RoofingBatchOrderDto => {
      const planPieces = order.items.map(toPieceLike);
      const reportedPieces = order.reports.flatMap((r) => r.piecesDetail.map(toPieceLike));
      // D-388: cada fila del borrador sale con su marca de «fuera de tolerancia», medida contra
      // el estado de esta misma lectura (las bobinas montadas y lo ya reportado).
      const drafts = draftDtos(
        {
          orderSeq: order.seq,
          productSku: order.product.sku,
          fixedLengthMm: order.product.lengthMm === null ? null : order.product.lengthMm.toFixed(2),
          planPieces,
          reportedMeters: piecesMeters(reportedPieces),
          coils: draftCoilStates(order.consumptions),
        },
        order.reportDrafts,
      );
      const progress = roofingPlanProgress(planPieces, piecesMeters(reportedPieces));
      const salesOrder = order.reservation?.salesOrder ?? null;
      // D-343: un accesorio no tiene plan de largos; su «plan» son los metros que encargó la línea
      // y lo «reportado» son los metros de bobina de sus reportes (`meters_m`), que no dejan
      // detalle de largos. Se expresan en los mismos campos para que la pantalla los muestre sin
      // un segundo camino.
      const accessory = isAccessory(order.product);
      const accessoryOrdered = toDecimal(order.reservation?.salesOrderItem?.qty.toString() ?? '0');
      const accessoryReported = order.reports.reduce(
        (acc, r) => (r.metersM === null ? acc : acc.plus(toDecimal(r.metersM.toString()))),
        new Decimal(0),
      );
      return {
        orderId: order.id,
        code: productionOrderCode(order.seq),
        seq: order.seq,
        status: order.status,
        priority: order.priorityAt !== null,
        priorityReason: order.priorityAt === null ? null : order.priorityReason,
        promisedDeliveryDate: salesOrder?.promisedDeliveryDate
          ? fromDateOnly(salesOrder.promisedDeliveryDate)
          : null,
        // D-155: la pestaña monta bobinas, y `GET /production/roofing/coils` necesita la
        // reserva propia para no esconder el material que este mismo pedido prometió.
        reservationId: order.reservationId,
        productId: order.productId,
        productSku: order.product.sku,
        productName: order.product.name,
        productUnit: order.product.unit,
        // D-159: `null` en una cobertura a medida — el largo lo trae cada línea del pedido.
        productLengthMm: order.product.lengthMm?.toFixed(2) ?? null,
        salesOrderId: salesOrder?.id ?? null,
        salesOrderCode: salesOrder ? salesOrderCode(salesOrder.seq) : null,
        customerName: salesOrder?.customer.name ?? null,
        planItems: order.items.map((i, n) => ({
          lineNumber: n + 1,
          lengthMm: i.lengthMm.toFixed(2),
          qty: i.qty,
        })),
        isAccessory: accessory,
        planMeters: (accessory ? accessoryOrdered : progress.planMeters).toFixed(3),
        reportedMeters: (accessory ? accessoryReported : progress.reportedMeters).toFixed(3),
        remainingMeters: (accessory
          ? Decimal.max(accessoryOrdered.minus(accessoryReported), new Decimal(0))
          : progress.remainingMeters
        ).toFixed(3),
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
        // D-246: lo que los reportes sacaron de verdad, no la suma de sus teóricos (un reporte
        // topado en lo montado sacó menos). Con la orden abierta, el `consumedKg` de sus
        // bobinas montadas es exactamente eso: solo lo mueven los reportes y sus reversas, y
        // una bobina con consumo no se puede bajar. Es la cota que la pantalla usa al cerrar.
        reportedKg: order.consumptions
          .reduce((acc, c) => acc.plus(toDecimal(c.consumedKg.toString())), new Decimal(0))
          .toFixed(3),
        coils: order.consumptions.map((c) => ({
          coilId: c.coilId,
          consumptionId: c.id,
          coilCode: c.coil.code,
          widthMm: c.coil.widthMm.toFixed(2),
          thicknessMm: c.coil.thicknessMm.toFixed(2),
          densityFactor: c.coil.finish.densityFactor.toFixed(4),
          consumedKg: c.consumedKg.toFixed(3),
          remainingKg: toFixedString(
            toDecimal(c.assignedKg.toString()).minus(toDecimal(c.consumedKg.toString())),
            'KG',
          ),
          ...registeredByCoil(order.reports.filter((r) => coilOfReport.get(r.id) === c.coilId)),
        })),
        reportedPieces: piecesCount(reportedPieces),
        drafts,
        draftMeters: drafts
          .reduce((acc, d) => acc.plus(toDecimal(d.meters)), new Decimal(0))
          .toFixed(3),
        operationDate: fromDateOnly(order.operationDate),
      };
    });

    // D-189: **un solo ranking**. Las órdenes en curso primero (son las que ya tienen material
    // en la roladora) y después las no iniciadas exactamente en el orden de la cola.
    const today = businessToday();
    return rows.sort((a, b) => {
      const startedA = a.status === ProductionOrderStatus.IN_PROGRESS;
      const startedB = b.status === ProductionOrderStatus.IN_PROGRESS;
      if (startedA !== startedB) return startedA ? -1 : 1;
      return compareQueueRank(a, b, today);
    });
  }

  // -------------------------------------------------------------------------
  // D-189 — la cola de producción: órdenes no iniciadas, con prioridad por orden
  // -------------------------------------------------------------------------

  /**
   * La cola (RF-37, D-189): órdenes de coberturas **no iniciadas** —en borrador, sin bobina
   * montada y sin reportes vigentes— ordenadas por `compareQueueRank`, el mismo criterio que
   * usa `batchOrders` para `/planta`.
   *
   * `DRAFT` ya garantiza las dos condiciones (`recomputeStatus` vuelve a borrador solo sin
   * asignaciones ni reportes, y montar pasa a en curso); se filtran igual en la consulta
   * porque la definición es esa y no el estado, y un borrador que las incumpla sería un
   * defecto que la cola no debe esconder poniéndolo delante de planta.
   */
  async queue(actor?: RequestUser): Promise<ProductionQueueEntryDto[]> {
    const orders = await this.prisma.productionOrder.findMany({
      where: {
        kind: ProductionOrderKind.ROOFING,
        status: ProductionOrderStatus.DRAFT,
        consumptions: { none: { releasedAt: null } },
        reports: { none: { status: ProductionReportStatus.ACTIVE } },
        ...(actor ? { reservation: { salesOrder: sellerWhere(actor) } } : {}),
      },
      include: {
        product: {
          select: {
            sku: true,
            name: true,
            thicknessMm: true,
            widthMm: true,
            color: { select: { name: true } },
            finish: { select: { densityFactor: true } },
          },
        },
        items: { orderBy: { lineNumber: 'asc' }, select: { lengthMm: true, qty: true } },
        reservation: {
          select: {
            salesOrder: {
              select: {
                id: true,
                seq: true,
                promisedDeliveryDate: true,
                customer: { select: { name: true } },
              },
            },
          },
        },
      },
      orderBy: { seq: 'asc' },
      // Sin tope: la cola está acotada por naturaleza (borradores de coberturas), y un `take`
      // antes de ordenar por prioridad dejaba afuera justo a una OP nueva priorizada.
    });
    const actors = await resolveActorNames(
      this.prisma,
      orders.map((o) => o.priorityById).filter((id): id is string => id !== null),
    );

    const today = businessToday();
    const entries = orders.map((order): ProductionQueueEntryDto => {
      const planItems = order.items.map((i, n) => ({
        lineNumber: n + 1,
        lengthMm: i.lengthMm.toFixed(2),
        qty: i.qty,
      }));
      const product = order.product;
      // El kilo teórico sale de la geometría **del SKU**: la orden todavía no montó ninguna
      // bobina, y es el mismo número que el vendedor vio al cotizar (D-134/D-122).
      const geometry: CoilGeometry | null =
        product.thicknessMm !== null && product.widthMm !== null && product.finish !== null
          ? {
              widthMm: product.widthMm.toFixed(2),
              thicknessMm: product.thicknessMm.toFixed(2),
              densityFactor: product.finish.densityFactor.toFixed(4),
            }
          : null;
      const salesOrder = order.reservation?.salesOrder ?? null;
      const promisedDeliveryDate = salesOrder?.promisedDeliveryDate
        ? fromDateOnly(salesOrder.promisedDeliveryDate)
        : null;
      return {
        orderId: order.id,
        code: productionOrderCode(order.seq),
        seq: order.seq,
        salesOrderId: salesOrder?.id ?? null,
        salesOrderCode: salesOrder ? salesOrderCode(salesOrder.seq) : null,
        customerName: salesOrder?.customer.name ?? null,
        productId: order.productId,
        productSku: product.sku,
        productName: product.name,
        colorName: product.color?.name ?? null,
        thicknessMm: product.thicknessMm?.toFixed(2) ?? null,
        planItems,
        planMeters: piecesMeters(planItems).toFixed(3),
        theoreticalKg: geometry ? roofingTheoreticalKg(geometry, planItems).toFixed(3) : null,
        promisedDeliveryDate,
        semaphore: queueSemaphore(promisedDeliveryDate, today),
        overdue: isOverdue(promisedDeliveryDate, today),
        priority: order.priorityAt !== null,
        priorityAt: order.priorityAt?.toISOString() ?? null,
        priorityByName: order.priorityById ? (actors.get(order.priorityById) ?? null) : null,
        priorityReason: order.priorityAt === null ? null : order.priorityReason,
        createdAt: order.createdAt.toISOString(),
      };
    });
    return entries.sort((a, b) => compareQueueRank(a, b, today));
  }

  /**
   * Prioridad manual excepcional de una orden (D-094, movida a la orden por D-189): solo
   * ADMINISTRADOR (lo corta el controller), siempre con motivo. Una orden terminal no se
   * prioriza: ya no está esperando a nadie.
   */
  async setPriority(
    actor: RequestUser,
    orderId: string,
    input: SetProductionOrderPriorityInput,
  ): Promise<ProductionOrderDto> {
    await this.prisma.$transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      assertKind(order, ProductionOrderKind.ROOFING);
      assertLive(order, 'cambiar su prioridad');
      const before = await tx.productionOrder.findUniqueOrThrow({
        where: { id: orderId },
        select: { priorityAt: true, priorityReason: true },
      });
      await tx.productionOrder.update({
        where: { id: orderId },
        data: input.priority
          ? { priorityAt: new Date(), priorityById: actor.id, priorityReason: input.reason }
          : { priorityAt: null, priorityById: null, priorityReason: null },
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: input.priority ? 'production.priority-set' : 'production.priority-clear',
        entity: 'production_orders',
        entityId: orderId,
        before: { priority: before.priorityAt !== null, reason: before.priorityReason },
        after: { priority: input.priority, reason: input.reason },
      });
    });
    return this.production.findOne(orderId);
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
        // cc30 (cruce C6): el pedido y todas sus reservas de materia prima al inicio, por id. Antes
        // el pedido no se tomaba y las reservas se tomaban de a una, en orden de línea, entre alta y
        // alta de OP: se cruzaba con anular el pedido y con completar su reserva.
        const raw = await tx.reservation.findMany({
          where: { salesOrderId, itemType: InventoryItemType.RAW_MATERIAL },
          select: { id: true },
        });
        await lockDocuments(tx, {
          salesOrders: [salesOrderId],
          reservations: raw.map((r) => r.id),
        });
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
    const warnings: RawMaterialShortfall[] = [];
    await this.prisma.$transaction(
      async (tx) => {
        await this.closeInTx(tx, actor, orderId, input, operationDate, warnings);
      },
      { timeout: 60_000 },
    );

    return this.withWarnings(await this.production.findOne(orderId), warnings);
  }

  /**
   * cc27 (UX26-03, D-453): lo que `close` haría, sin hacerlo (`previewPlantClose`).
   */
  async previewClose(
    actor: RequestUser,
    orderId: string,
    input: CloseRoofingOrderInput,
  ): Promise<PlantClosePreviewDto> {
    const operationDate = this.operationDate.resolve(actor, input.operationDate);
    return previewPlantClose(
      this.prisma,
      orderId,
      (tx, warnings) => this.closeInTx(tx, actor, orderId, input, operationDate, warnings),
      CLOSE_PREVIEW_TIMEOUT_MS,
    );
  }

  /**
   * cc27 (UX26-03, D-453): lo que `reportAndClose` haría, sin hacerlo. Las mismas dos mitades,
   * sin reclamar la clave de idempotencia.
   */
  async previewReportAndClose(
    actor: RequestUser,
    orderId: string,
    input: ReportAndCloseRoofingInput,
  ): Promise<PlantClosePreviewDto> {
    const operationDate = this.operationDate.resolve(actor, input.operationDate);
    return previewPlantClose(
      this.prisma,
      orderId,
      async (tx, warnings) => {
        warnings.push(...(await this.reportInTx(tx, actor, orderId, input, operationDate)));
        await this.closeInTx(
          tx,
          actor,
          orderId,
          {
            consumedKg: input.closeConsumedKg,
            reason: input.closeReason,
            confirmBackdate: input.confirmBackdate,
          },
          operationDate,
          warnings,
        );
      },
      CLOSE_PREVIEW_TIMEOUT_MS,
    );
  }

  /**
   * Reportar los últimos largos **y cerrar la orden en la misma transacción** (D-159).
   *
   * Las dos mitades ya existían y son las mismas: `reportInTx` y `closeInTx`, sin una línea de
   * lógica propia acá. Lo que aporta es la atomicidad — hasta acá el cierre era un segundo
   * viaje que podía fallar con el reporte ya escrito, y la bobina quedaba montada en una
   * orden a medio cerrar mientras la orden hermana del mismo pedido la esperaba.
   */
  async reportAndClose(
    actor: RequestUser,
    orderId: string,
    input: ReportAndCloseRoofingInput,
  ): Promise<ProductionOrderDto> {
    // Una sola fecha para las dos mitades: es un solo acto de planta, y resolverla dos veces
    // dejaba el reporte y su cierre en días distintos si la corrida cruzaba la medianoche.
    const operationDate = this.operationDate.resolve(actor, input.operationDate);
    // **Un arreglo por mitad.** Compartirlo hacía que el asiento del cierre repitiera en su
    // `after` los faltantes que ya había anotado el asiento del reporte (y su propia columna
    // `production_reports.raw_material_warning`), o sea que el `audit_log` —que es
    // append-only y se lee para reconstruir qué pasó— dijera que el cierre avisó de algo que
    // avisó el reporte. Para la respuesta se juntan, que ahí sí son "lo que dejó esta
    // operación" (D-154).
    const reportWarnings: RawMaterialShortfall[] = [];
    const closeWarnings: RawMaterialShortfall[] = [];
    await this.prisma.$transaction(
      async (tx) => {
        // F8-S1/M2: intento de submit, no el hecho de negocio — un doble click no debe
        // reportar Y cerrar dos veces. Alcance propio (`roofing-report-and-close`): no
        // comparte clave con `report()` porque acá el efecto es el de las dos mitades.
        const claim = await claimIdempotencyKey(
          tx,
          'roofing-report-and-close',
          input.idempotencyKey,
        );
        if (!claim.claimed) return;

        reportWarnings.push(...(await this.reportInTx(tx, actor, orderId, input, operationDate)));
        await this.closeInTx(
          tx,
          actor,
          orderId,
          {
            consumedKg: input.closeConsumedKg,
            reason: input.closeReason,
            confirmBackdate: input.confirmBackdate,
          },
          operationDate,
          closeWarnings,
        );
      },
      // El presupuesto del cierre, no el del reporte: las dos mitades entran en la misma
      // transacción y la que manda es la más cara.
      { timeout: 60_000, maxWait: 15_000 },
    );

    return this.withWarnings(await this.production.findOne(orderId), [
      ...reportWarnings,
      ...closeWarnings,
    ]);
  }

  /**
   * El cuerpo de `close`, **dentro de la transacción del llamador** (patrón `*InTx`, D-099).
   *
   * `warnings` se recibe y se **muta**: es el mismo arreglo que `InventoryService.record`
   * llena con los faltantes del agregado (D-154), y el llamador lo cuelga de la respuesta.
   */
  async closeInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    orderId: string,
    input: CloseRoofingOrderInput,
    operationDate: string,
    warnings: RawMaterialShortfall[],
  ): Promise<void> {
    // cc30 (grupo C, cruce d): pedido → OP → reserva al inicio. Las dos ramas escriben la reserva
    // de materia prima (el despunte la descuenta; sin despunte se libera lo que sobró) con las
    // bobinas y el saldo en mano; antes, sin despunte, se tomaba recién ahí.
    const order = await lockOrder(tx, orderId, { own: true });
    assertKind(order, ProductionOrderKind.ROOFING);
    if (order.status !== ProductionOrderStatus.IN_PROGRESS) {
      throw new BadRequestException(
        order.status === ProductionOrderStatus.DRAFT
          ? 'La orden no tiene material ni planchas: anúlala en vez de cerrarla'
          : `La orden ya está ${order.status === ProductionOrderStatus.CLOSED ? 'cerrada' : 'anulada'}`,
      );
    }

    // D-191: cerrar con filas en el borrador las dejaría huérfanas de una orden que ya no
    // admite reportes — y lo que salió de verdad no entraría nunca. Se ejecutan o se quitan.
    // (El commit del borrador las borra antes de llamar acá.)
    const drafted = await tx.productionReportDraft.count({ where: { productionOrderId: orderId } });
    if (drafted > 0) {
      throw new BadRequestException(
        `${productionOrderCode(order.seq)} tiene ${String(drafted)} fila(s) sin ejecutar en el borrador: ejecútalas o quítalas antes de cerrar`,
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

    // cc38 (D-573): la orden se cierra solo con el plan completo. Es la puerta común de los tres
    // caminos de cierre —close, report-and-close y el commit del borrador con close=true— y de sus
    // vistas previas; corre después de los reportes de la misma transacción, así que lo que se
    // registra en ese mismo acto ya cuenta.
    await this.assertPlanComplete(tx, order, reports);

    const rows = await tx.productionOrderConsumption.findMany({
      where: { productionOrderId: orderId, releasedAt: null },
      include: { coil: { select: { code: true } } },
      orderBy: { createdAt: 'asc' },
    });

    // D-246: el piso es lo que los reportes **sacaron** de la bobina, no la suma de sus
    // teóricos: un reporte topado en lo montado sacó menos que su teórico. Para los reportes
    // de antes de D-246 la salida es su teórico, así que el cierre les da lo mismo que antes.
    const coilOuts = liveMovements(
      await tx.inventoryMovement.findMany({
        where: {
          refType: 'PRODUCTION',
          refId: { in: reports.map((r) => r.id) },
          itemType: 'COIL',
          type: 'OUT',
        },
        include: { reversals: { select: { id: true } } },
      }),
    );
    // D-146: cuando planta declaró kilos **reporte a reporte**, el cierre los usa como valor por
    // defecto en vez de asumir merma cero; `input.consumedKg` (el total escrito al cerrar) manda
    // siempre. D-089: lo declarado no baja de lo que las planchas ya sacaron ni pasa lo montado.
    // cc34 (B1): el despunte de cada bobina sale de sus propios partes —la bobina de cada parte es
    // la de su salida de kardex— y un total escrito se reparte en proporción a lo reportado de
    // cada bobina viva (`allocateRoofingScrap`). Con una sola bobina, lo de siempre.
    const scrapPlan = allocateRoofingScrap({
      rows: rows.map((r) => ({
        consumptionId: r.id,
        coilId: r.coilId,
        coilCode: r.coil.code,
        remainingKg: Decimal.max(
          toDecimal(r.assignedKg.toString()).minus(toDecimal(r.consumedKg.toString())),
          new Decimal(0),
        ),
      })),
      reports: reports.map((r) => ({
        id: r.id,
        declaredKg: r.consumedKg === null ? null : toDecimal(r.consumedKg.toString()),
        theoreticalKg: toDecimal(r.theoreticalKg.toString()),
      })),
      outs: coilOuts.flatMap((m) =>
        m.refId === null
          ? []
          : [{ reportId: m.refId, coilId: m.itemId, kg: toDecimal(m.qty.toString()) }],
      ),
      explicitTotalKg: input.consumedKg ? toDecimal(input.consumedKg) : null,
    });
    const { reportedKg, declaredKg } = scrapPlan;
    const { scrapKg, scrapRatio } = roofingCloseScrap({
      declaredKg,
      reportedKg,
      remainingKg: new Decimal(0),
    });
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
    // D-386: las bobinas que el cierre baja (con sus agregados), después los saldos de las que
    // sueltan despunte y el del producto que recibe el ajuste, de una vez. Va después del pedido y
    // la reserva (que el despunte descuenta abajo) y antes de la primera salida.
    const productUnit = (
      await tx.product.findUniqueOrThrow({ where: { id: order.productId }, select: { unit: true } })
    ).unit;
    const lockCloseSet = (scrapCoilIds: readonly string[]) =>
      this.inventory.lockInOrder(tx, {
        coilIds: rows.map((r) => r.coilId),
        items: [
          ...scrapCoilIds.map((coilId) => ({
            businessLineId: order.businessLineId,
            itemType: InventoryItemType.COIL,
            itemId: coilId,
            unit: Unit.KGM,
          })),
          {
            businessLineId: order.businessLineId,
            itemType: InventoryItemType.PRODUCT,
            itemId: order.productId,
            unit: productUnit,
          },
        ],
      });
    if (!scrapKg.gt(0)) await lockCloseSet([]);
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
        // cc30: pedido y reserva ya vienen tomados de `lockOrder`; esto no vuelve a esperar.
        await lockDocuments(tx, { salesOrders: [reservation.salesOrderId] });
        // Mismo criterio que el reporte (D-134): el despunte sale de una bobina que la
        // orden montó, y toda bobina que la orden pudo montar cumple el agregado que el
        // pedido prometía. No hay rollo "ajeno" del que descontar por error.
        await consumeReservationQty(tx, order.reservationId, scrapKg);
      }
      const { allocations } = scrapPlan;
      await lockCloseSet(allocations.map((a) => a.coilId));
      // Fuera del bucle: es la misma para todas las asignaciones y adentro sería una
      // consulta por rollo dentro de una transacción con presupuesto acotado.
      const scope = await this.ownPromiseScope(tx, order);
      for (const allocation of allocations) {
        await this.coils.lockCoil(tx, allocation.coilId);
        // La custodia primero, por el mismo motivo que en el reporte: con el orden
        // invertido la invariante lee un agregado al que ya le bajaron el saldo y
        // todavía no el consumo, y avisa por kilos que este mismo cierre acaba de sacar.
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
        const out = await this.inventory.record(tx, {
          businessLineId: order.businessLineId,
          itemType: 'COIL',
          itemId: allocation.coilId,
          type: 'OUT',
          qty: toFixedString(allocation.kg, 'KG'),
          unit: Unit.KGM,
          refType: 'SCRAP',
          refId: orderId,
          // D-134/D-154: igual que el reporte — el despunte sale de la bobina que esta
          // orden montó para cumplir la promesa de su pedido, y un faltante ajeno avisa
          // en vez de cortar. Bloquear acá dejaba la orden imposible de cerrar y el
          // material montado retenido para siempre, que es el peor de los dos males.
          ...scope,
          rawMaterialWarnings: warnings,
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

    // D-360: las bobinas que el cierre bajó y quedaron en exactamente 0 se terminan solas (el
    // reporte y el despunte no las terminan: estaban montadas). Reabrir la orden las reabre.
    await autoTerminateEmptyCoils(tx, this.audit, {
      actorId: actor.id,
      coilIds: rows.map((r) => r.coilId),
      cause: {
        kind: 'PRODUCTION_ORDER_CLOSE',
        refId: orderId,
        label: `cierre de ${productionOrderCode(order.seq)}`,
      },
      operationDate,
    });

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
      const movement = await this.inventory.adjustCost(tx, {
        businessLineId: order.businessLineId,
        itemType: 'PRODUCT',
        itemId: order.productId,
        unit: productUnit,
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
        rawMaterialWarnings:
          warnings.length === 0 ? null : dedupeWarnings(warnings).map((w) => w.message),
      },
    });
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
        // cc30: pedido → OP; las dos reservas se toman abajo, juntas.
        const order = await lockOrder(tx, orderId, { parent: true });
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
            `Hay reportes posteriores vigentes (${later.metersM === null ? `${later.pieces} planchas` : `${later.metersM.toFixed(3)} m de bobina`} del ${businessToday(later.createdAt)}): revierte el último primero`,
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

        // La reserva sobre el producto que este reporte fabricó, si la orden nació de un pedido.
        let reservationLineId: string | null = null;
        let onProduct: Awaited<ReturnType<typeof findLineReservation>> = null;
        if (order.reservationId) {
          const reservation = await tx.reservation.findUniqueOrThrow({
            where: { id: order.reservationId },
            select: { salesOrderItemId: true },
          });
          reservationLineId = reservation.salesOrderItemId;
          onProduct = await findLineReservation(
            tx,
            reservation.salesOrderItemId,
            InventoryItemType.PRODUCT,
            order.productId,
          );
        }
        // D-386 (P2-2 de cc15b): las reservas, después las bobinas con sus agregados y al final los
        // saldos, todos antes de mirar qué se movió después y antes de la primera reversa. Antes
        // se tomaba el saldo del producto (al revertir el ingreso) y recién después cada bobina.
        // cc30 (grupo C, cruce b): las dos reservas que esta reversa escribe —la del producto y
        // la de materia prima de la OP, que se restaura al final— juntas y por id; antes la de
        // materia prima se tomaba recién al escribirla, con los saldos en mano.
        await lockDocuments(tx, { reservations: [onProduct?.id, order.reservationId] });
        await this.inventory.lockInOrder(tx, { items: movements.map(itemRefOf) });

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
        if (onProduct) {
          const reduced = await reduceReservation(tx, onProduct.id, outputQty, actor.id);
          reducedProductQty = reduced.toFixed(3);
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
          before: {
            reportId,
            // D-343: un accesorio no tiene detalle de largos; se nombra por sus metros de bobina.
            plan:
              report.piecesDetail.length === 0 && report.metersM !== null
                ? `${report.metersM.toFixed(3)} m de bobina`
                : describePieces(report.piecesDetail.map(toPieceLike)),
          },
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

        // D-386: las bobinas que vuelven a la orden y las del despunte (con sus agregados),
        // después los saldos de lo que se revierte, antes de mirar qué se movió después del
        // cierre. Antes se tomaba el saldo del producto (la reversa del ajuste) y después cada
        // bobina.
        await this.inventory.lockInOrder(tx, {
          coilIds: (
            await tx.productionOrderConsumption.findMany({
              where: { productionOrderId: orderId, releasedAt: order.closedAt },
              select: { coilId: true },
            })
          ).map((r) => r.coilId),
          items: movements.map(itemRefOf),
        });

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
        // D-360: las bobinas que el cierre terminó solas vuelven a estar vigentes; las que se
        // terminaron por otra causa siguen bloqueando la reapertura, como antes.
        const reopened = await reopenAutoTerminatedCoils(tx, this.audit, {
          actorId: actor.id,
          coilIds: rows.map((r) => r.coilId),
          cause: { kind: 'PRODUCTION_ORDER_CLOSE', refId: orderId },
          // Revisión C06: también la que terminó el lote después de que esta OP la dejara en 0.
          zeroedBy: {
            refIds: [
              orderId,
              ...(
                await tx.productionReport.findMany({
                  where: { productionOrderId: orderId },
                  select: { id: true },
                })
              ).map((r) => r.id),
            ],
          },
          label: `reapertura de ${productionOrderCode(order.seq)}`,
          operationDate,
        });
        const reopenedIds = new Set(reopened.reopened.map((c) => c.id));

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
          if (row.coil.status !== CoilStatus.OPEN && !reopenedIds.has(row.coilId)) {
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
      // cc30: anular restaura la reserva y el pedido (`restoreReservationIfIdle`).
      const order = await lockOrder(tx, orderId, { own: true });
      assertKind(order, ProductionOrderKind.ROOFING);
      assertLive(order, 'anularla');

      const live = await tx.productionReport.findMany({
        where: { productionOrderId: orderId, status: ProductionReportStatus.ACTIVE },
        select: { pieces: true, metersM: true },
      });
      if (live.length > 0) {
        // D-343: un accesorio reporta metros de bobina, no planchas.
        const produced = live.some((r) => r.metersM !== null && r.pieces === 0)
          ? `${live.reduce((acc, r) => acc.plus(r.metersM ?? 0), new Decimal(0)).toFixed(3)} m de bobina`
          : `${live.reduce((acc, r) => acc + r.pieces, 0)} planchas`;
        throw new BadRequestException(
          `La orden tiene ${live.length} reporte(s) vigente(s) con ${produced}: revierte esos reportes antes de anularla`,
        );
      }

      // D-191: anular descarta el borrador. No es un hecho del dominio —nunca movió kardex—,
      // así que se borra con la orden que ya no lo va a ejecutar.
      const discardedDrafts = await tx.productionReportDraft.deleteMany({
        where: { productionOrderId: orderId },
      });

      const held = await tx.productionOrderConsumption.findMany({
        where: { productionOrderId: orderId, releasedAt: null },
        select: { coilId: true },
      });
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
      // D-360: si al bajarla está en exactamente 0, se termina (red de seguridad: anular exige cero reportes).
      await autoTerminateEmptyCoils(tx, this.audit, {
        actorId: actor.id,
        coilIds: held.map((h) => h.coilId),
        cause: {
          kind: 'PRODUCTION_ORDER_CANCEL',
          refId: orderId,
          label: `anulación de ${productionOrderCode(order.seq)}`,
        },
        operationDate: this.operationDate.resolve(actor, undefined),
      });

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
          discardedDraftRows: discardedDrafts.count,
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
   *
   * D-193: con `includeClosed` suma las **cerradas** del mismo filtro, con el ajuste del cierre
   * que reabrirlas va a revertir y el saldo que les quedaría. Se ofrecen para reabrir y montar
   * con confirmación; sin ella el montaje las sigue rechazando.
   */
  async coilOptions(
    productId: string,
    reservationId?: string,
    includeClosed = false,
  ): Promise<RoofingCoilOptionDto[]> {
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

    // D-127: el filtro vive en `roofing-coil-match` porque la confirmación de una cotización a
    // medida hace la misma pregunta y no puede responderla distinto.
    const specWhere = roofingCoilWhere({
      businessLineId: product.businessLineId,
      colorId: product.colorId,
      inputThicknessMm: product.thicknessMm,
      toleranceMm: this.thicknessToleranceMm(),
    });
    const coilSelect = {
      id: true,
      code: true,
      status: true,
      filmSealed: true,
      typeKey: true,
      weightKg: true,
      widthMm: true,
      thicknessMm: true,
      colorId: true,
      color: { select: { name: true, hexColor: true } },
      finishId: true,
      finish: { select: { code: true, name: true, densityFactor: true } },
    } satisfies Prisma.CoilSelect;

    // D-193: abiertas y cerradas en **dos** consultas, cada una con su tope. En una sola, las
    // cerradas —que no salen nunca de la tabla— terminaban desplazando del corte a las bobinas
    // recién compradas de la misma spec.
    const openCoils = await this.prisma.coil.findMany({
      where: specWhere,
      select: coilSelect,
      orderBy: { code: 'asc' },
      take: 500,
    });

    // Las cerradas que valen la pena: las que tienen un ajuste de cierre vivo como último
    // movimiento (reabrir lo revierte) o saldo. Se resuelve primero sobre los ids —una lectura
    // liviana— y recién después se traen las filas completas, así una spec con cientos de
    // rollos agotados no gasta el tope en bobinas que no se van a mostrar.
    let closedCoils: typeof openCoils = [];
    const lastByCoil = new Map<
      string,
      {
        refType: string;
        type: string;
        qty: Prisma.Decimal;
        reversed: boolean;
        /** cc29 (D-466): el ajuste es de un cierre (apunta a la bobina), no el sobrante de un montaje. */
        closure: boolean;
      }
    >();
    if (includeClosed) {
      const closedIds = (
        await this.prisma.coil.findMany({
          where: { ...specWhere, status: CoilStatus.CLOSED },
          select: { id: true },
        })
      ).map((c) => c.id);
      if (closedIds.length > 0) {
        const [last, closedBalances] = await Promise.all([
          this.prisma.$queryRaw<
            {
              item_id: string;
              ref_type: string;
              type: string;
              qty: Prisma.Decimal;
              reversed: boolean;
              closure: boolean;
            }[]
          >`
            SELECT DISTINCT ON (m."item_id") m."item_id", m."ref_type"::text AS "ref_type",
                   m."type"::text AS "type", m."qty",
                   (m."ref_id" = m."item_id"::text) AS "closure",
                   EXISTS (SELECT 1 FROM "inventory_movements" r WHERE r."reversal_of_id" = m."id") AS "reversed"
            FROM "inventory_movements" m
            WHERE m."item_type" = 'COIL' AND m."item_id" = ANY(${closedIds}::uuid[])
            ORDER BY m."item_id", m."id" DESC
          `,
          this.prisma.inventoryBalance.findMany({
            where: { itemType: 'COIL', itemId: { in: closedIds }, qty: { gt: 0 } },
            select: { itemId: true },
          }),
        ]);
        for (const row of last) {
          lastByCoil.set(row.item_id, {
            refType: row.ref_type,
            type: row.type,
            qty: row.qty,
            reversed: row.reversed,
            closure: row.closure,
          });
        }
        const withStock = new Set(closedBalances.map((b) => b.itemId));
        // cc29 (D-466): también las terminadas con el kardex en 0, que se montan declarando su
        // peso físico. Primero las que tienen kilos (o un ajuste que reabrir devuelve).
        const hasKilos = (id: string) => {
          const m = lastByCoil.get(id);
          return (
            withStock.has(id) || (m?.refType === 'CLOSE_ADJUSTMENT' && m.closure && !m.reversed)
          );
        };
        const withKilos = closedIds.filter(hasKilos);
        // P1 de la revisión del corte 2: de las agotadas, solo las que se fueron en planta
        // (producción, merma o cierre). Una vendida, partida o enviada al corte no está ahí.
        const zero = closedIds.filter((id) => !hasKilos(id));
        const elsewhere =
          zero.length === 0
            ? new Set<string>()
            : new Set(
                (
                  await this.prisma.inventoryMovement.findMany({
                    where: {
                      itemType: 'COIL',
                      itemId: { in: zero },
                      type: 'OUT',
                      refType: { notIn: [...MOUNT_SURPLUS_ALLOWED_OUTS] },
                      reversalOfId: null,
                      reversals: { none: {} },
                    },
                    select: { itemId: true },
                    distinct: ['itemId'],
                  })
                ).map((m) => m.itemId),
              );
        const empty = zero.filter((id) => !elsewhere.has(id));
        // El tope de 100 lo llenan primero las que tienen kilos: cientos de rollos agotados no
        // pueden desplazarlas del corte.
        const [kept, spent] = await Promise.all([
          withKilos.length === 0
            ? Promise.resolve([])
            : this.prisma.coil.findMany({
                where: { id: { in: withKilos } },
                select: coilSelect,
                orderBy: { updatedAt: 'desc' },
                take: 100,
              }),
          empty.length === 0
            ? Promise.resolve([])
            : this.prisma.coil.findMany({
                where: { id: { in: empty } },
                select: coilSelect,
                orderBy: { updatedAt: 'desc' },
                take: 100,
              }),
        ]);
        closedCoils = [...kept, ...spent].slice(0, 100);
      }
    }

    const coils = [...openCoils, ...closedCoils];
    if (coils.length === 0) return [];

    const ids = coils.map((c) => c.id);
    const [balances, assignments, reservations] = await Promise.all([
      this.prisma.inventoryBalance.findMany({
        where: { itemType: 'COIL', itemId: { in: ids } },
        select: { itemId: true, qty: true },
      }),
      findLiveStripAssignments(this.prisma, ids),
      // D-185: firme más temporal vigente — una bobina apartada para venderse entera tampoco
      // se ofrece para montar.
      reservedByItem(
        this.prisma,
        InventoryItemType.COIL,
        ids,
        ownReservationId === undefined ? {} : { exceptReservationIds: [ownReservationId] },
      ),
    ]);
    // D-193: reabrir revierte el ajuste del cierre **solo si es el último movimiento** y no está
    // anulado (D-164, `reverseCloseAdjustment`): la misma pregunta, contestada igual.
    const adjustmentById = new Map(
      [...lastByCoil]
        .filter(([, m]) => m.refType === 'CLOSE_ADJUSTMENT' && m.closure && !m.reversed)
        .map(([itemId, m]) => [
          itemId,
          {
            kind: m.type === 'OUT' ? ('SHORTAGE' as const) : ('SURPLUS' as const),
            qty: toDecimal(m.qty.toString()),
          },
        ]),
    );
    // En una cerrada, el saldo que queda después de reabrir: el faltante vuelve, el sobrante sale.
    const afterReopen = (coilId: string, balance: Decimal): Decimal => {
      const adjustment = adjustmentById.get(coilId);
      if (adjustment === undefined) return balance;
      return adjustment.kind === 'SHORTAGE'
        ? balance.plus(adjustment.qty)
        : balance.minus(adjustment.qty);
    };
    const qtyById = new Map(
      coils.map((c) => {
        const balance = toDecimal(balances.find((b) => b.itemId === c.id)?.qty.toString() ?? '0');
        return [c.id, c.status === CoilStatus.CLOSED ? afterReopen(c.id, balance) : balance];
      }),
    );
    const taken = new Set(assignments.map((a) => a.coilId));
    const promised = new Set(
      [...reservations].filter(([, qty]) => qty.gt(0)).map(([itemId]) => itemId),
    );

    // cc29 (D-466): una terminada que reabierta queda en 0 también se ofrece, para declarar su peso.
    const needsPhysical = (c: { id: string; status: CoilStatus }) =>
      c.status === CoilStatus.CLOSED && (qtyById.get(c.id) ?? new Decimal(0)).lte(0);
    const mountable = coils
      .filter(
        (c) =>
          !taken.has(c.id) &&
          !promised.has(c.id) &&
          ((qtyById.get(c.id) ?? new Decimal(0)).gt(0) || needsPhysical(c)),
      )
      .map((c) => ({
        ...c,
        status: c.status === CoilStatus.CLOSED ? ('CLOSED' as const) : ('OPEN' as const),
      }));
    // D-271: primero las del acabado exacto del producto —el RAL que se vendió—, sin sacar
    // ninguna: cualquier bobina del mismo color comercial se puede montar (D-270).
    return preferExactFinish(mountable, product.finish.id).map((c) => {
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
        finishName: c.finish.name,
        ral: finishRal(c.finish),
        exactFinish: c.exactFinish,
        widthMm: c.widthMm.toFixed(2),
        thicknessMm: c.thicknessMm.toFixed(2),
        colorId: c.colorId,
        colorName: c.color?.name ?? null,
        colorHex: c.color?.hexColor ?? null,
        weightKg: c.weightKg.toFixed(3),
        status: c.status,
        // D-328: montar una bobina sellada la abre; el selector lo avisa antes de montar.
        film: c.filmSealed ? CoilFilmState.SEALED : CoilFilmState.OPENED,
        closeAdjustment: (() => {
          const adjustment = c.status === 'CLOSED' ? adjustmentById.get(c.id) : undefined;
          return adjustment === undefined
            ? null
            : { kind: adjustment.kind, qtyKg: adjustment.qty.toFixed(3) };
        })(),
        availableKg: Decimal.max(availableKg, 0).toFixed(3),
        needsPhysicalKg: c.status === 'CLOSED' && availableKg.lte(0),
        estimatedMeters: toFixedString(
          metersFromKg(geometry, Decimal.max(availableKg, 0).toFixed(3)),
          'KG',
        ),
      };
    });
  }

  /**
   * cc38 (D-573): los metros registrados por los reportes vigentes son iguales a los del plan, con
   * tres decimales. Cobertura a medida y plancha: el plan de corte (en una plancha, planchas ×
   * largo fijo). Accesorio: los metros que encargó la línea del pedido. Sin plan no hay contra qué
   * comparar: solo lo alcanzan órdenes anteriores a D-146, y ninguna está abierta (diagnóstico de
   * cc38), así que se rechaza en vez de cerrar a ciegas.
   */
  private async assertPlanComplete(
    tx: Prisma.TransactionClient,
    order: LockedOrder,
    reports: readonly { id: string }[],
  ): Promise<void> {
    const [product, planRows, reportRows] = await Promise.all([
      tx.product.findUniqueOrThrow({
        where: { id: order.productId },
        select: { roofingKind: true },
      }),
      tx.productionOrderItem.findMany({
        where: { productionOrderId: order.id },
        select: { lengthMm: true, qty: true },
      }),
      tx.productionReport.findMany({
        where: { id: { in: reports.map((r) => r.id) } },
        select: { metersM: true, piecesDetail: { select: { lengthMm: true, qty: true } } },
      }),
    ]);
    const accessory = isAccessory(product);
    if (accessory ? order.reservationId === null : planRows.length === 0) {
      throw new BadRequestException(
        `${productionOrderCode(order.seq)} no tiene plan contra el que comprobar que está completa: no se puede cerrar`,
      );
    }
    const planMeters =
      accessory && order.reservationId !== null
        ? await accessoryOrderedMeters(tx, order.reservationId)
        : piecesMeters(planRows.map(toPieceLike));
    const { missing, excess } = roofingPlanGap(
      planMeters,
      sumReportedMeters(reportRows) ?? new Decimal(0),
    );
    if (missing.gt(0)) throw new BadRequestException(closeShortfallMessage(missing));
    if (excess.gt(0)) throw new BadRequestException(planExcessMessage(excess));
  }

  /** La tolerancia de D-086, con el override de entorno que documenta esa decisión. */
  thicknessToleranceMm(): string {
    return roofingToleranceMm(this.env);
  }
}

/**
 * Un aviso por agregado, y no uno por bobina (D-154). Una orden con tres rollos de la misma
 * spec montados emite una salida de kardex por rollo, y cada una comprueba el **mismo**
 * agregado: sin esto, el operario leía tres veces la misma frase y el `audit_log` guardaba
 * tres copias. Gana el último, que es el que describe el estado final de la operación.
 */
function dedupeWarnings(warnings: readonly RawMaterialShortfall[]): RawMaterialShortfall[] {
  const bySpec = new Map<string, RawMaterialShortfall>();
  for (const w of warnings) bySpec.set(w.specId, w);
  return [...bySpec.values()];
}

/**
 * El faltante del agregado tal como sale a la respuesta (D-154): sin `specId`, que es una
 * llave interna y no le dice nada a quien lee el aviso en pantalla.
 */
function toWarningDto(shortfall: RawMaterialShortfall): RawMaterialWarningDto {
  const { specId: _specId, ...dto } = shortfall;
  return dto;
}

/**
 * cc38 (D-576): lo que una bobina ya tiene registrado en la orden —sus largos sumados por largo, en
 * orden de largo, y sus metros (en un accesorio, los metros de bobina de sus partes)—.
 */
function registeredByCoil(
  reports: readonly {
    metersM: Prisma.Decimal | null;
    piecesDetail: readonly { lengthMm: Prisma.Decimal; qty: number }[];
  }[],
): { reportedPieces: RoofingPieceDto[]; reportedMeters: string } {
  const byLength = new Map<string, number>();
  for (const piece of reports.flatMap((r) => r.piecesDetail)) {
    const key = piece.lengthMm.toFixed(2);
    byLength.set(key, (byLength.get(key) ?? 0) + piece.qty);
  }
  return {
    reportedPieces: [...byLength]
      .sort(([a], [b]) => toDecimal(b).comparedTo(toDecimal(a)))
      .map(([lengthMm, qty], i) => ({ lineNumber: i + 1, lengthMm, qty })),
    reportedMeters: (sumReportedMeters(reports) ?? new Decimal(0)).toFixed(3),
  };
}

/** D-343: el «plan» de un accesorio son los metros que encargó la línea del pedido. */
async function accessoryOrderedMeters(
  tx: Prisma.TransactionClient,
  reservationId: string,
): Promise<Decimal> {
  const reservation = await tx.reservation.findUniqueOrThrow({
    where: { id: reservationId },
    select: { salesOrderItem: { select: { qty: true } } },
  });
  return toDecimal(reservation.salesOrderItem.qty.toString());
}

/** Fila persistida de largos → la forma mínima que la aritmética compartida necesita. */
function toPieceLike(row: { lengthMm: Prisma.Decimal; qty: number }): PieceLike {
  return { lengthMm: row.lengthMm.toFixed(2), qty: row.qty };
}

/** Reexportado para que el módulo no tenga que importar el tipo desde dos sitios. */
export type { LockedOrder };
