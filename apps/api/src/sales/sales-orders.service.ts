import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CoilStatus,
  Prisma,
  ProductBomKind,
  ProductionOrderStatus,
  QuotationStatus,
  ReservationStatus,
  SalesOrderStatus,
  InventoryItemType as InventoryItemTypeEnum,
  type InventoryItemType,
} from '@prisma/client';
import {
  businessToday,
  productionOrderCode,
  queueSemaphore,
  Role,
  quotationCode,
  RESERVATION_STALE_DAYS,
  salesOrderCode,
  toDecimal,
  type CreateSalesOrderInput,
  type ProductionQueueEntryDto,
  type QueueSemaphore,
  type QueueStatus,
  type ReservableCoilDto,
  type ReservableCoilQuery,
  type ReservationDto,
  type ReservationQuery,
  type SalesOrderDto,
  type SalesOrderListItemDto,
  type SalesOrderQuery,
  type SetSalesOrderPriorityInput,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { toPrismaLineCode, toSharedLineCode } from '../common/business-line-code';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertStripsNotAssigned } from '../production/production-assignments';
import { derivePiecesPlan, roofingTheoreticalKg, type CoilGeometry } from '../production/roofing-math';
import { documentTotals, resolveSalesLines, toSalesItemDto } from './sales-lines';

function toDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

const orderInclude = {
  customer: { select: { id: true, name: true, docNumber: true } },
  businessLine: { select: { code: true } },
  quotation: { select: { id: true, seq: true } },
  items: {
    orderBy: { lineNumber: 'asc' },
    include: {
      product: { select: { sku: true, name: true } },
      // D-083: copia congelada de los largos que se cotizaron.
      pieces: { orderBy: { lineNumber: 'asc' } },
    },
  },
  reservations: {
    orderBy: { createdAt: 'asc' },
    include: {
      salesOrder: {
        select: {
          seq: true,
          customer: { select: { name: true } },
          items: { select: { productId: true } },
        },
      },
      productionOrders: {
        // Solo la OP **viva** (D-084): anular una de coberturas deja `reservation_id`
        // apuntando a la reserva y la devuelve a ACTIVA (D-066), así que con la última a
        // secas la reserva quedaba con una OP anulada colgada — y `/planta`, que ofrece las
        // reservas sin OP, la hacía desaparecer del único punto de entrada para volver a
        // fabricarla.
        where: { status: { in: ['DRAFT', 'IN_PROGRESS'] } },
        select: { id: true, seq: true },
        take: 1,
      },
    },
  },
} satisfies Prisma.SalesOrderInclude;

type OrderRow = Prisma.SalesOrderGetPayload<{ include: typeof orderInclude }>;
type ReservationRow = OrderRow['reservations'][number];

/** Las dos formas en que una fila nombra al ítem del kardex que reserva. */
type ReserveRef =
  | { itemType: InventoryItemType; itemId: string }
  | { reserveItemType: InventoryItemType; reserveItemId: string };

/**
 * Pedidos y ledger de reservas (RF-62; D-054, D-065, D-066).
 *
 * Confirmar una cotización crea el pedido **y** sus reservas en una sola transacción: si
 * una sola línea no tiene disponible, no se crea nada (D-054, "falla completa, nunca
 * parcial"). Anular el pedido libera las reservas por el mismo camino, y se bloquea
 * mientras una orden de producción viva esté fabricando con ese material.
 */
@Injectable()
export class SalesOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
  ) {}

  // -------------------------------------------------------------------------
  // RF-62 — confirmar una cotización
  // -------------------------------------------------------------------------

  /**
   * Confirmar (acto del vendedor, D-054): crea el pedido y las reservas juntos.
   *
   * La vigencia se revalida acá aunque el job de vencimiento (D-069) exista: el job es una
   * comodidad de la lista, no la regla. Si el API estuvo dormido, una cotización vencida
   * seguiría figurando `EMITIDA` y sin este chequeo se podría confirmar.
   */
  async confirm(
    actor: RequestUser,
    quotationId: string,
    promisedDeliveryDate?: string,
  ): Promise<SalesOrderDto> {
    const orderId = await this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          {
            id: string;
            seq: number;
            status: QuotationStatus;
            valid_until: Date;
            created_by_id: string;
          }[]
        >`
        SELECT "id", "seq", "status", "valid_until", "created_by_id"
        FROM "quotations" WHERE "id" = ${quotationId}::uuid FOR UPDATE
      `;
        const head = rows[0];
        if (!head) throw new NotFoundException('Cotización no encontrada');
        // RF-66: confirmar es el acto del vendedor **sobre su propia** cotización. Sin esto,
        // cualquier vendedor podía comprometer stock a nombre del cliente de otro.
        if (actor.role !== Role.ADMINISTRADOR && actor.id !== head.created_by_id) {
          throw new ForbiddenException('La cotización es de otro vendedor: no puedes confirmarla');
        }

        if (head.status === QuotationStatus.CONFIRMED) {
          throw new ConflictException('La cotización ya fue confirmada');
        }
        if (head.status !== QuotationStatus.EMITTED) {
          throw new BadRequestException(
            head.status === QuotationStatus.EXPIRED
              ? 'La cotización está vencida: no se puede confirmar'
              : `Solo se confirma una cotización emitida; esta está ${head.status}`,
          );
        }
        const validUntil = head.valid_until.toISOString().slice(0, 10);
        if (validUntil < businessToday()) {
          throw new BadRequestException(
            `La cotización venció el ${validUntil}: no se puede confirmar`,
          );
        }

        const quotation = await tx.quotation.findUniqueOrThrow({
          where: { id: quotationId },
          include: {
            items: {
              orderBy: { lineNumber: 'asc' },
              include: { pieces: { orderBy: { lineNumber: 'asc' } } },
            },
          },
        });
        if (quotation.items.length === 0) {
          throw new BadRequestException('La cotización no tiene líneas');
        }

        // Entre emitir y confirmar pueden pasar hasta 365 días (D-069): en ese lapso el
        // cliente o un producto pueden haberse dado de baja. `resolveSalesLines` lo valida
        // al **crear** la cotización, así que sin este chequeo la confirmación era la única
        // puerta del ciclo que no lo miraba, y el pedido nacía contra un maestro muerto.
        const customer = await tx.customer.findUniqueOrThrow({
          where: { id: quotation.customerId },
          select: { isActive: true, name: true },
        });
        if (!customer.isActive) {
          throw new BadRequestException(
            `El cliente ${customer.name} está desactivado: reactívalo o cotiza a otro cliente`,
          );
        }
        const inactive = await tx.product.findFirst({
          where: {
            id: { in: quotation.items.map((i) => i.productId) },
            isActive: false,
          },
          select: { sku: true },
        });
        if (inactive) {
          throw new BadRequestException(
            `El producto ${inactive.sku} está desactivado desde que se emitió la cotización: crea una nueva`,
          );
        }

        const order = await tx.salesOrder.create({
          data: {
            quotationId,
            customerId: quotation.customerId,
            businessLineId: quotation.businessLineId,
            status: SalesOrderStatus.CONFIRMED,
            issueDate: toDateOnly(businessToday()),
            subtotalPen: quotation.subtotalPen,
            igvPen: quotation.igvPen,
            totalPen: quotation.totalPen,
            notes: quotation.notes,
            createdById: actor.id,
            // D-096: única ventana en la que el vendedor la fija; después es de ADMINISTRADOR.
            promisedDeliveryDate: promisedDeliveryDate ? toDateOnly(promisedDeliveryDate) : null,
            items: {
              create: quotation.items.map((i) => ({
                lineNumber: i.lineNumber,
                productId: i.productId,
                description: i.description,
                qty: i.qty,
                unit: i.unit,
                listPricePen: i.listPricePen,
                unitPricePen: i.unitPricePen,
                subtotalPen: i.subtotalPen,
                igvPen: i.igvPen,
                totalPen: i.totalPen,
                reserveItemType: i.reserveItemType,
                reserveItemId: i.reserveItemId,
                reserveQty: i.reserveQty,
                reserveUnit: i.reserveUnit,
                // D-083: el pedido congela los largos igual que congela el precio; a partir
                // de acá la cotización puede reemitirse y estos no se mueven.
                ...(i.pieces.length > 0
                  ? {
                      pieces: {
                        create: i.pieces.map((p) => ({
                          lineNumber: p.lineNumber,
                          lengthMm: p.lengthMm,
                          qty: p.qty,
                        })),
                      },
                    }
                  : {}),
              })),
            },
          },
          include: { items: { orderBy: { lineNumber: 'asc' } } },
        });

        await this.createReservations(tx, actor, order.id, order.businessLineId, order.items);

        await tx.quotation.update({
          where: { id: quotationId },
          data: { status: QuotationStatus.CONFIRMED, confirmedAt: new Date() },
        });

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'sales.order.confirm',
          entity: 'sales_orders',
          entityId: order.id,
          after: {
            code: salesOrderCode(order.seq),
            quotationCode: quotationCode(head.seq),
            totalPen: order.totalPen.toFixed(4),
          },
        });
        return order.id;
      },
      // Una confirmación toma un lock por línea (hasta `MAX_SALES_ITEMS`) sobre bobinas y
      // saldos. Con el timeout por defecto de Prisma (5 s) un pedido de varias líneas
      // contra Neon se caía por reloj; mismo criterio que el resto de transacciones largas
      // del proyecto (partido, recepción de corte, cierre de OP).
      { timeout: 30_000 },
    );

    return this.findOne(orderId);
  }

  // -------------------------------------------------------------------------
  // D-065 — pedido directo, sin cotización
  // -------------------------------------------------------------------------

  /**
   * Alta directa de pedido. Solo en líneas cuya cotización es **opcional**: en las que la
   * exigen (coberturas, RF-31) este es exactamente el camino que hay que cerrar, o el flag
   * de D-065 no significaría nada.
   */
  async createDirect(actor: RequestUser, input: CreateSalesOrderInput): Promise<SalesOrderDto> {
    const orderId = await this.prisma.$transaction(
      async (tx) => {
        const customer = await tx.customer.findUnique({
          where: { id: input.customerId },
          select: { id: true, isActive: true },
        });
        if (!customer) throw new NotFoundException('Cliente no encontrado');
        if (!customer.isActive) throw new BadRequestException('El cliente está desactivado');

        const line = await tx.businessLine.findUnique({
          where: { code: toPrismaLineCode(input.businessLine) },
          select: { id: true, quotationRequired: true, inventoryStrategy: true },
        });
        if (!line) throw new NotFoundException('Línea de negocio no encontrada');
        if (line.inventoryStrategy === 'NOOP') {
          throw new BadRequestException('La línea services no lleva stock: no se vende por acá');
        }
        if (line.quotationRequired) {
          throw new BadRequestException(
            'Esta línea de negocio exige una cotización confirmada (RF-31): crea la cotización, emítela y confírmala',
          );
        }

        const lines = await resolveSalesLines(tx, line.id, input.items);
        const totals = documentTotals(lines);

        const order = await tx.salesOrder.create({
          data: {
            quotationId: null,
            customerId: customer.id,
            businessLineId: line.id,
            status: SalesOrderStatus.CONFIRMED,
            issueDate: toDateOnly(input.issueDate),
            subtotalPen: totals.subtotalPen,
            igvPen: totals.igvPen,
            totalPen: totals.totalPen,
            notes: input.notes ?? null,
            createdById: actor.id,
            promisedDeliveryDate: input.promisedDeliveryDate
              ? toDateOnly(input.promisedDeliveryDate)
              : null,
            items: {
              create: lines.map((l) => ({
                lineNumber: l.lineNumber,
                productId: l.productId,
                description: l.description,
                qty: l.qty,
                unit: l.unit,
                listPricePen: l.listPricePen,
                unitPricePen: l.unitPricePen,
                subtotalPen: l.subtotalPen,
                igvPen: l.igvPen,
                totalPen: l.totalPen,
                reserveItemType: l.reserveItemType,
                reserveItemId: l.reserveItemId,
                reserveQty: l.reserveQty,
                reserveUnit: l.reserveUnit,
                ...(l.pieces.length > 0
                  ? {
                      pieces: {
                        create: l.pieces.map((p) => ({
                          lineNumber: p.lineNumber,
                          lengthMm: p.lengthMm,
                          qty: p.qty,
                        })),
                      },
                    }
                  : {}),
              })),
            },
          },
          include: { items: { orderBy: { lineNumber: 'asc' } } },
        });

        await this.createReservations(tx, actor, order.id, order.businessLineId, order.items);

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'sales.order.create-direct',
          entity: 'sales_orders',
          entityId: order.id,
          after: { code: salesOrderCode(order.seq), totalPen: totals.totalPen },
        });
        return order.id;
      },
      // Mismo motivo que `confirm`: un lock por línea sobre bobinas y saldos.
      { timeout: 30_000 },
    );

    return this.findOne(orderId);
  }

  // -------------------------------------------------------------------------
  // El corazón: crear las reservas comprobando disponible
  // -------------------------------------------------------------------------

  /**
   * Una reserva por línea, con el saldo del ítem bloqueado. Si a una línea no le alcanza el
   * disponible, lanza y **toda** la transacción se cae: el pedido no queda a medias con
   * unas líneas reservadas y otras no (D-054).
   *
   * **Orden de locks: primero las bobinas, después los saldos.** Es el mismo orden que ya
   * usan `production.consume` (`lockCoil` → `record`) y `coils.split`, y no es negociable:
   * comprobar el disponible bajo el lock del **saldo** no serializa contra
   * `production.consume` ni `cutting.send`, que bloquean la fila de la **bobina** y ni
   * siquiera tocan el saldo (D-050/D-060: asignar y enviar no mueven kardex). Sin este
   * lock previo quedaba una ventana en la que una confirmación y un envío a corte se
   * cruzaban y la bobina terminaba reservada **y** en poder de un tercero.
   *
   * Dentro de cada grupo las filas se piden por id ascendente y las líneas se ordenan por
   * `(itemType, itemId)`, así que dos confirmaciones simultáneas que compartan ítems se
   * serializan en vez de trabarse en un deadlock.
   */
  private async createReservations(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    orderId: string,
    businessLineId: string,
    items: {
      id: string;
      lineNumber: number;
      reserveItemType: InventoryItemType;
      reserveItemId: string;
      reserveQty: Prisma.Decimal;
      reserveUnit: string;
    }[],
  ): Promise<void> {
    const sorted = [...items].sort((a, b) =>
      `${a.reserveItemType}:${a.reserveItemId}`.localeCompare(
        `${b.reserveItemType}:${b.reserveItemId}`,
      ),
    );

    const coilIds = [
      ...new Set(
        sorted
          .filter((i) => i.reserveItemType === InventoryItemTypeEnum.COIL)
          .map((i) => i.reserveItemId),
      ),
    ].sort();
    if (coilIds.length > 0) {
      await tx.$queryRaw`
        SELECT "id" FROM "coils" WHERE "id" = ANY(${coilIds}::uuid[]) ORDER BY "id" FOR UPDATE
      `;

      // **La invariante también vale al revés.** Comprobar el disponible no alcanza para
      // decidir si el material se puede prometer: entre cotizar y confirmar, la bobina pudo
      // irse a un tercero (D-050) o quedar montada en una orden de producción (D-060), y
      // ninguna de esas dos cosas mueve un gramo de kardex, así que el saldo se ve intacto.
      // Prometerla igual deja al pedido comprometiendo material que no está, y —peor— hace
      // que la recepción del corte o el reporte de esa OP se caigan después contra la
      // invariante, sin más salida que liberar la reserva a mano.
      const coils = await tx.coil.findMany({
        where: { id: { in: coilIds } },
        select: { id: true, code: true, status: true },
      });
      const unavailable = coils.filter((c) => c.status !== CoilStatus.OPEN);
      if (unavailable.length > 0) {
        const detail = unavailable.map((c) => `${c.code} (${c.status})`).join(', ');
        throw new BadRequestException(
          `No se puede reservar material de una bobina que no está disponible: ${detail}.`,
        );
      }
      await assertStripsNotAssigned(tx, coilIds, 'reservar su material para un pedido');
    }

    for (const item of sorted) {
      const qty = toDecimal(item.reserveQty.toString());
      const availability = await this.inventory.lockAvailability(tx, {
        businessLineId,
        itemType: item.reserveItemType,
        itemId: item.reserveItemId,
        unit: item.reserveUnit,
      });
      if (qty.gt(availability.available)) {
        const label = await this.itemLabel(tx, item.reserveItemType, item.reserveItemId);
        throw new BadRequestException(
          `Línea ${item.lineNumber}: ${label} tiene ${availability.available.toFixed(3)} ${availability.unit} disponibles (${availability.qty.toFixed(3)} físicos menos ${availability.reserved.toFixed(3)} ya reservados) y el pedido necesita ${qty.toFixed(3)}.`,
        );
      }
      await tx.reservation.create({
        data: {
          salesOrderId: orderId,
          salesOrderItemId: item.id,
          itemType: item.reserveItemType,
          itemId: item.reserveItemId,
          qty: item.reserveQty,
          unit: item.reserveUnit,
          status: ReservationStatus.ACTIVE,
          createdById: actor.id,
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Anular el pedido (libera las reservas)
  // -------------------------------------------------------------------------

  /**
   * Anula el pedido y libera sus reservas activas.
   *
   * **Se bloquea mientras exista una OP viva (`DRAFT`/`IN_PROGRESS`) colgada de cualquiera
   * de sus reservas**, sin importar en qué estado esté la reserva. La distinción importa:
   * una OP que ya montó el fleje (`consume`) pero todavía no reportó tiene su reserva en
   * `ACTIVA`, y filtrar por `CONSUMIDA` dejaba anular el pedido en silencio — la reserva
   * pasaba a `LIBERADA`, la orden seguía fabricando para un pedido que ya no existía y su
   * primer reporte no encontraba nada que consumir.
   *
   * Que el bloqueo mire el **estado de la orden** y no el de la reserva es lo que evita el
   * otro extremo: deshacer la producción (revertir el reporte, anular la OP) devuelve la
   * reserva a `ACTIVA` y libera este bloqueo, así que un pedido nunca queda sin poder
   * anularse para siempre — el agujero que D-061 tuvo que cerrar con los pagos a proveedor.
   *
   * Con la OP cerrada no hay nada que impedir: el material ya salió y anular el pedido es un
   * acto puramente comercial.
   *
   * Si el pedido venía de una cotización, esa cotización vuelve a `EMITIDA` cuando sigue
   * vigente — el cliente puede volver a aceptarla— y queda `VENCIDA` cuando ya no.
   */
  async cancel(actor: RequestUser, id: string, reason: string): Promise<SalesOrderDto> {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, id);
      if (order.status === SalesOrderStatus.CANCELLED) {
        throw new ConflictException('El pedido ya está anulado');
      }
      if (order.status === SalesOrderStatus.FULFILLED) {
        throw new BadRequestException('Un pedido ya atendido no se anula');
      }

      // Lock de las reservas antes de leerlas, en orden de id. `production.report` escribe
      // primero el pedido y después la reserva; sin este lock, las dos transacciones tomaban
      // los mismos dos recursos en orden inverso y Postgres abortaba una con un deadlock que
      // salía al usuario como un 500 opaco.
      await tx.$queryRaw`
        SELECT "id" FROM "reservations" WHERE "sales_order_id" = ${id}::uuid
        ORDER BY "id" FOR UPDATE
      `;
      const reservations = await tx.reservation.findMany({
        where: { salesOrderId: id },
        include: {
          productionOrders: {
            where: {
              status: { in: [ProductionOrderStatus.DRAFT, ProductionOrderStatus.IN_PROGRESS] },
            },
            select: { seq: true },
            take: 1,
          },
        },
      });
      const blocking = reservations.flatMap((r) => r.productionOrders);
      if (blocking.length > 0) {
        const detail = blocking.map((op) => `orden ${productionOrderCode(op.seq)}`).join(', ');
        throw new BadRequestException(
          `No se puede anular: ${detail} está fabricando con el material reservado. Anula la orden de producción primero.`,
        );
      }

      const active = reservations.filter((r) => r.status === ReservationStatus.ACTIVE);
      if (active.length > 0) {
        await tx.reservation.updateMany({
          where: { id: { in: active.map((r) => r.id) }, status: ReservationStatus.ACTIVE },
          data: {
            status: ReservationStatus.RELEASED,
            releasedAt: new Date(),
            releasedById: actor.id,
          },
        });
      }

      await tx.salesOrder.update({
        where: { id },
        data: {
          status: SalesOrderStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelledById: actor.id,
        },
      });

      if (order.quotationId) {
        const quotation = await tx.quotation.findUniqueOrThrow({
          where: { id: order.quotationId },
          select: { validUntil: true, status: true },
        });
        const validUntil = quotation.validUntil.toISOString().slice(0, 10);
        const back =
          validUntil < businessToday() ? QuotationStatus.EXPIRED : QuotationStatus.EMITTED;
        await tx.quotation.update({
          where: { id: order.quotationId },
          data: {
            status: back,
            confirmedAt: null,
            expiredAt: back === QuotationStatus.EXPIRED ? new Date() : null,
          },
        });
      }

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.order.cancel',
        entity: 'sales_orders',
        entityId: id,
        before: { status: order.status, activeReservations: active.length },
        after: { status: SalesOrderStatus.CANCELLED, reason },
      });
    });

    return this.findOne(id);
  }

  // -------------------------------------------------------------------------
  // D-054 — liberación manual de una reserva
  // -------------------------------------------------------------------------

  /**
   * Libera una reserva sin anular el pedido (D-054: sin vencimiento automático, alerta +
   * liberación manual). Solo ADMINISTRADOR, siempre con motivo: es material que se le
   * prometió a un cliente y que a partir de acá cualquier otra operación puede tomar.
   */
  async releaseReservation(
    actor: RequestUser,
    reservationId: string,
    reason: string,
  ): Promise<ReservationDto> {
    await this.prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
        select: {
          id: true,
          status: true,
          salesOrderId: true,
          productionOrders: {
            where: {
              status: { in: [ProductionOrderStatus.DRAFT, ProductionOrderStatus.IN_PROGRESS] },
            },
            select: { seq: true },
            take: 1,
          },
        },
      });
      if (!reservation) throw new NotFoundException('Reserva no encontrada');
      if (reservation.status === ReservationStatus.RELEASED) {
        throw new ConflictException('La reserva ya está liberada');
      }
      if (reservation.status === ReservationStatus.CONSUMED) {
        throw new BadRequestException(
          'La reserva ya fue consumida por una orden de producción: no hay nada que liberar',
        );
      }
      // Mismo bloqueo que anular el pedido, y por el mismo motivo: si se libera el material
      // que una OP ya tiene montado, otro pedido lo puede reservar y el reporte de esa OP
      // queda trabado contra la invariante, sin culpa de planta.
      const busy = reservation.productionOrders[0];
      if (busy) {
        throw new BadRequestException(
          `La orden de producción ${productionOrderCode(busy.seq)} está fabricando con este material. Anúlala antes de liberar la reserva.`,
        );
      }
      const released = await tx.reservation.updateMany({
        where: { id: reservationId, status: ReservationStatus.ACTIVE },
        data: {
          status: ReservationStatus.RELEASED,
          releasedAt: new Date(),
          releasedById: actor.id,
        },
      });
      if (released.count !== 1) {
        throw new ConflictException('La reserva cambió de estado mientras se liberaba');
      }
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.reservation.release',
        entity: 'reservations',
        entityId: reservationId,
        before: { status: ReservationStatus.ACTIVE },
        after: { status: ReservationStatus.RELEASED, reason },
      });
    });

    const row = await this.prisma.reservation.findUniqueOrThrow({
      where: { id: reservationId },
      include: {
        salesOrder: {
          select: {
            seq: true,
            customer: { select: { name: true } },
            items: { select: { productId: true } },
          },
        },
        productionOrders: {
          // Solo la OP **viva** (D-084): anular una de coberturas deja `reservation_id`
          // apuntando a la reserva y la devuelve a ACTIVA (D-066), así que con la última a
          // secas la reserva quedaba con una OP anulada colgada — y `/planta`, que ofrece las
          // reservas sin OP, la hacía desaparecer del único punto de entrada para volver a
          // fabricarla.
          where: { status: { in: ['DRAFT', 'IN_PROGRESS'] } },
          select: { id: true, seq: true },
          take: 1,
        },
      },
    });
    const labels = await this.reserveLabels([row]);
    return this.toReservationDto(row, labels);
  }

  // -------------------------------------------------------------------------
  // Fase 7 — cola de producción (D-092..D-096)
  // -------------------------------------------------------------------------

  /**
   * Prioridad manual excepcional (D-094): solo ADMINISTRADOR, siempre con motivo. Cachea
   * `priorityAt`/`priorityById`/`priorityReason` en el pedido para poder ordenar la cola sin
   * releer `audit_log`, que sigue siendo la fuente de "quién y cuándo" (RF-95).
   */
  async setPriority(
    actor: RequestUser,
    id: string,
    input: SetSalesOrderPriorityInput,
  ): Promise<SalesOrderDto> {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, id);
      if (order.status === SalesOrderStatus.CANCELLED) {
        throw new BadRequestException('El pedido está anulado');
      }
      await tx.salesOrder.update({
        where: { id },
        data: input.priority
          ? { priorityAt: new Date(), priorityById: actor.id, priorityReason: input.reason }
          : { priorityAt: null, priorityById: null, priorityReason: null },
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: input.priority ? 'sales.order.priority-set' : 'sales.order.priority-clear',
        entity: 'sales_orders',
        entityId: id,
        before: { priority: order.priorityReason !== null, reason: order.priorityReason },
        after: { priority: input.priority, reason: input.reason },
      });
    });
    return this.findOne(id);
  }

  /**
   * Fecha prometida de entrega, después de que el pedido existe (D-096): el vendedor solo la
   * fija al confirmar/crear (`confirm`/`createDirect`); de acá en adelante es de
   * ADMINISTRADOR. `null` la borra.
   */
  async setPromisedDeliveryDate(
    actor: RequestUser,
    id: string,
    promisedDeliveryDate: string | null,
  ): Promise<SalesOrderDto> {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, id);
      if (order.status === SalesOrderStatus.CANCELLED) {
        throw new BadRequestException('El pedido está anulado');
      }
      await tx.salesOrder.update({
        where: { id },
        data: {
          promisedDeliveryDate: promisedDeliveryDate ? toDateOnly(promisedDeliveryDate) : null,
        },
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.order.promised-delivery-date',
        entity: 'sales_orders',
        entityId: id,
        before: { promisedDeliveryDate: order.promisedDeliveryDate },
        after: { promisedDeliveryDate },
      });
    });
    return this.findOne(id);
  }

  /**
   * La cola (RF-37): pedidos con reserva de bobina activa sobre un producto que se fabrica
   * contra el pedido (D-093, misma señal que `resolveDispatchTarget`, D-088) y sin OP viva
   * todavía. No hay tabla: se recalcula acá en cada lectura.
   */
  async findProductionQueue(): Promise<ProductionQueueEntryDto[]> {
    const reservations = await this.prisma.reservation.findMany({
      where: { status: ReservationStatus.ACTIVE, itemType: InventoryItemTypeEnum.COIL },
      include: {
        salesOrder: {
          select: {
            id: true,
            seq: true,
            createdAt: true,
            promisedDeliveryDate: true,
            priorityAt: true,
            priorityById: true,
            priorityReason: true,
            customer: { select: { name: true } },
          },
        },
        salesOrderItem: {
          include: {
            product: { select: { id: true, sku: true, name: true } },
            pieces: { orderBy: { lineNumber: 'asc' } },
          },
        },
        productionOrders: {
          where: { status: { in: [ProductionOrderStatus.DRAFT, ProductionOrderStatus.IN_PROGRESS] } },
          select: { id: true },
          take: 1,
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    const pending = reservations.filter((r) => r.productionOrders.length === 0);
    if (pending.length === 0) return [];

    const productIds = [...new Set(pending.map((r) => r.salesOrderItem.productId))];
    const boms = await this.prisma.productBom.findMany({
      // D-092: v1 es solo Metallic Roofing. `kind` descarta el caso —posible a nivel de
      // datos, aunque el web nunca lo arma— de una línea reservando bobina para un producto
      // con receta DRYWALL: sin este filtro, la cola le aplicaría la aritmética de
      // coberturas (`roofingTheoreticalKg`, `pieceLengthMm` de otra receta) a un perfil.
      where: { productId: { in: productIds }, isActive: true, kind: ProductBomKind.ROOFING },
      select: { productId: true, pieceLengthMm: true },
    });
    const bomByProduct = new Map(boms.map((b) => [b.productId, b]));
    // La trampa de RF-73 (D-037, D-088): una venta directa de bobina también reserva
    // `itemType=COIL` y no tiene receta. Sin este filtro, cada bobina vendida tal cual
    // aparecía en la cola de planta como un pedido de cobertura pendiente.
    const eligible = pending.filter((r) => bomByProduct.has(r.salesOrderItem.productId));
    if (eligible.length === 0) return [];

    const coils = await this.prisma.coil.findMany({
      where: { id: { in: eligible.map((r) => r.itemId) } },
      select: {
        id: true,
        widthMm: true,
        thicknessMm: true,
        finish: { select: { densityFactor: true } },
      },
    });
    const coilById = new Map(coils.map((c) => [c.id, c]));

    const priorityByIds = eligible
      .map((r) => r.salesOrder.priorityById)
      .filter((id): id is string => id !== null);
    const actors = await this.resolveActorNames(priorityByIds);

    const today = businessToday();
    const entries = eligible.flatMap((r): ProductionQueueEntryDto[] => {
      const bom = bomByProduct.get(r.salesOrderItem.productId);
      if (!bom) return [];
      const coil = coilById.get(r.itemId);
      const pieces = derivePiecesPlan(
        r.salesOrderItem.pieces.map((p) => ({ lengthMm: p.lengthMm.toFixed(2), qty: p.qty })),
        bom.pieceLengthMm === null ? null : bom.pieceLengthMm.toFixed(2),
        r.salesOrderItem.qty.toString(),
      );
      const geometry: CoilGeometry | null = coil
        ? {
            widthMm: coil.widthMm.toFixed(2),
            thicknessMm: coil.thicknessMm.toFixed(2),
            densityFactor: coil.finish.densityFactor.toFixed(4),
          }
        : null;
      const promisedDeliveryDate = r.salesOrder.promisedDeliveryDate
        ? r.salesOrder.promisedDeliveryDate.toISOString().slice(0, 10)
        : null;
      return [
        {
          salesOrderId: r.salesOrder.id,
          salesOrderCode: salesOrderCode(r.salesOrder.seq),
          salesOrderItemId: r.salesOrderItemId,
          reservationId: r.id,
          customerName: r.salesOrder.customer.name,
          productId: r.salesOrderItem.productId,
          productSku: r.salesOrderItem.product.sku,
          productName: r.salesOrderItem.product.name,
          pieces,
          theoreticalKg: geometry ? roofingTheoreticalKg(geometry, pieces).toFixed(3) : null,
          promisedDeliveryDate,
          semaphore: queueSemaphore(promisedDeliveryDate, today),
          createdAt: r.salesOrder.createdAt.toISOString(),
          priority: r.salesOrder.priorityById !== null,
          priorityAt: r.salesOrder.priorityAt?.toISOString() ?? null,
          priorityByName: r.salesOrder.priorityById
            ? (actors.get(r.salesOrder.priorityById) ?? null)
            : null,
          priorityReason: r.salesOrder.priorityReason,
        },
      ];
    });

    // D-094: prioridad > semáforo > FIFO. Entre dos priorizados, gana el que se priorizó
    // primero — la misma idea de FIFO, aplicada al momento de priorizar.
    const semaphoreRank: Record<QueueSemaphore, number> = {
      VENCIDO: 0,
      PROXIMO: 1,
      A_TIEMPO: 2,
      SIN_FECHA: 3,
    };
    return entries.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority ? -1 : 1;
      if (a.priority && b.priority) return (a.priorityAt ?? '').localeCompare(b.priorityAt ?? '');
      const rankDiff = semaphoreRank[a.semaphore] - semaphoreRank[b.semaphore];
      if (rankDiff !== 0) return rankDiff;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  /**
   * Estado del pedido frente a la cola (D-093), para el detalle de `/pedidos/[id]`: `null`
   * cuando no tiene nada que fabricar contra el pedido, o ya salió de la cola.
   */
  private async computeQueueStatus(row: OrderRow): Promise<QueueStatus | null> {
    const productIdByItem = new Map(row.items.map((i) => [i.id, i.productId]));
    const candidates = row.reservations.filter(
      (r) => r.status === ReservationStatus.ACTIVE && r.itemType === InventoryItemTypeEnum.COIL,
    );
    if (candidates.length === 0) return null;
    const productIds = [
      ...new Set(
        candidates
          .map((r) => productIdByItem.get(r.salesOrderItemId))
          .filter((id): id is string => id !== undefined),
      ),
    ];
    if (productIds.length === 0) return null;
    const boms = await this.prisma.productBom.findMany({
      // D-092: mismo filtro que `findProductionQueue` — v1 es solo Metallic Roofing.
      where: { productId: { in: productIds }, isActive: true, kind: ProductBomKind.ROOFING },
      select: { productId: true },
    });
    const madeToOrder = new Set(boms.map((b) => b.productId));
    const relevant = candidates.filter((r) => {
      const productId = productIdByItem.get(r.salesOrderItemId);
      return productId !== undefined && madeToOrder.has(productId);
    });
    if (relevant.length === 0) return null;
    return relevant.some((r) => r.productionOrders.length === 0) ? 'EN_COLA' : 'EN_PRODUCCION';
  }

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  async findAll(query: SalesOrderQuery): Promise<SalesOrderListItemDto[]> {
    const rows = await this.prisma.salesOrder.findMany({
      where: {
        status: query.status,
        customerId: query.customerId,
        businessLine: query.businessLine
          ? { code: toPrismaLineCode(query.businessLine) }
          : undefined,
        ...(query.search
          ? {
              OR: [
                { customer: { name: { contains: query.search, mode: 'insensitive' as const } } },
                { customer: { docNumber: { contains: query.search } } },
              ],
            }
          : {}),
      },
      // Igual que la lista de cotizaciones: totales, no detalle. Las reservas activas se
      // cuentan con un `_count` filtrado en vez de materializar cada una con su pedido, su
      // cliente y su orden de producción.
      include: {
        ...orderInclude,
        items: false,
        reservations: false,
        _count: {
          select: {
            items: true,
            reservations: { where: { status: ReservationStatus.ACTIVE } },
          },
        },
      },
      orderBy: { seq: 'desc' },
      take: 500,
    });
    const actorIds = rows.flatMap((r) => [r.createdById, ...(r.priorityById ? [r.priorityById] : [])]);
    const actors = await this.resolveActorNames(actorIds);
    return rows.map((r) => {
      const dto = this.toDto({ ...r, items: [], reservations: [] }, new Map(), actors);
      const { items: _items, reservations: _reservations, queueStatus: _queueStatus, ...rest } = dto;
      return {
        ...rest,
        itemCount: r._count.items,
        activeReservations: r._count.reservations,
      };
    });
  }

  async findOne(id: string): Promise<SalesOrderDto> {
    const row = await this.prisma.salesOrder.findUnique({ where: { id }, include: orderInclude });
    if (!row) throw new NotFoundException('Pedido no encontrado');
    const labels = await this.reserveLabels([...row.items.map(toReserveRef), ...row.reservations]);
    const actorIds = [row.createdById, ...(row.priorityById ? [row.priorityById] : [])];
    const [actors, queueStatus] = await Promise.all([
      this.resolveActorNames(actorIds),
      this.computeQueueStatus(row),
    ]);
    return this.toDto(row, labels, actors, queueStatus);
  }

  /**
   * Bobinas abiertas de una línea con su disponible ya descontado de lo reservado (D-066).
   *
   * Es lo que el formulario de cotización ofrece al vendedor para elegir de qué rollo sale
   * el material prometido. Vive acá y no en `coils` porque VENDEDOR no llega a esa ruta:
   * expone costos y proveedor, que §3.4 le oculta. Acá no viaja ningún costo.
   */
  async findReservableCoils(query: ReservableCoilQuery): Promise<ReservableCoilDto[]> {
    const coils = await this.prisma.coil.findMany({
      where: {
        status: CoilStatus.OPEN,
        businessLine: { code: toPrismaLineCode(query.businessLine) },
      },
      select: {
        id: true,
        code: true,
        typeKey: true,
        widthMm: true,
        thicknessMm: true,
        finish: { select: { code: true } },
      },
      orderBy: { code: 'asc' },
      take: 500,
    });
    if (coils.length === 0) return [];

    const ids = coils.map((c) => c.id);
    const [balances, reserved] = await Promise.all([
      this.prisma.inventoryBalance.findMany({
        where: { itemType: InventoryItemTypeEnum.COIL, itemId: { in: ids } },
        select: { itemId: true, qty: true },
      }),
      this.prisma.reservation.groupBy({
        by: ['itemId'],
        where: {
          status: ReservationStatus.ACTIVE,
          itemType: InventoryItemTypeEnum.COIL,
          itemId: { in: ids },
        },
        _sum: { qty: true },
      }),
    ]);
    const qtyById = new Map(balances.map((b) => [b.itemId, toDecimal(b.qty.toString())]));
    const reservedById = new Map(
      reserved.map((r) => [r.itemId, toDecimal((r._sum.qty ?? 0).toString())]),
    );

    // D-060: un fleje montado en una OP viva no se puede prometer aunque su saldo esté
    // intacto — asignar no mueve kardex, así que el disponible no lo delata. Ofrecerlo
    // llevaría al vendedor a un 400 al confirmar, o peor, a trabar esa corrida de planta.
    const assigned = new Set(
      (
        await this.prisma.productionOrderConsumption.findMany({
          where: {
            coilId: { in: ids },
            releasedAt: null,
            productionOrder: {
              status: { in: [ProductionOrderStatus.DRAFT, ProductionOrderStatus.IN_PROGRESS] },
            },
          },
          select: { coilId: true },
        })
      ).map((c) => c.coilId),
    );

    return (
      coils
        .filter((c) => !assigned.has(c.id))
        .map((c) => {
          const qty = qtyById.get(c.id) ?? toDecimal('0');
          const res = reservedById.get(c.id) ?? toDecimal('0');
          return {
            coilId: c.id,
            code: c.code,
            typeKey: c.typeKey,
            finishCode: c.finish.code,
            widthMm: c.widthMm.toFixed(2),
            thicknessMm: c.thicknessMm.toFixed(2),
            qty: qty.toFixed(3),
            reservedQty: res.toFixed(3),
            availableQty: qty.minus(res).toFixed(3),
          };
        })
        // Una bobina sin nada disponible tampoco se puede prometer.
        .filter((c) => toDecimal(c.availableQty).gt(0))
    );
  }

  async findReservations(query: ReservationQuery): Promise<ReservationDto[]> {
    const rows = await this.prisma.reservation.findMany({
      where: {
        status: query.status,
        itemId: query.itemId,
        salesOrderId: query.salesOrderId,
      },
      include: {
        salesOrder: {
          select: {
            seq: true,
            customer: { select: { name: true } },
            items: { select: { productId: true } },
          },
        },
        productionOrders: {
          // Solo la OP **viva** (D-084): anular una de coberturas deja `reservation_id`
          // apuntando a la reserva y la devuelve a ACTIVA (D-066), así que con la última a
          // secas la reserva quedaba con una OP anulada colgada — y `/planta`, que ofrece las
          // reservas sin OP, la hacía desaparecer del único punto de entrada para volver a
          // fabricarla.
          where: { status: { in: ['DRAFT', 'IN_PROGRESS'] } },
          select: { id: true, seq: true },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const labels = await this.reserveLabels(rows);
    return rows.map((r) => this.toReservationDto(r, labels));
  }

  // -------------------------------------------------------------------------
  // Interno
  // -------------------------------------------------------------------------

  private async lockOrder(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<{
    id: string;
    status: SalesOrderStatus;
    quotationId: string | null;
    priorityReason: string | null;
    promisedDeliveryDate: string | null;
  }> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        status: SalesOrderStatus;
        quotation_id: string | null;
        priority_reason: string | null;
        promised_delivery_date: Date | null;
      }[]
    >`
      SELECT "id", "status", "quotation_id", "priority_reason", "promised_delivery_date"
      FROM "sales_orders" WHERE "id" = ${id}::uuid FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new NotFoundException('Pedido no encontrado');
    return {
      id: row.id,
      status: row.status,
      quotationId: row.quotation_id,
      priorityReason: row.priority_reason,
      promisedDeliveryDate: row.promised_delivery_date
        ? row.promised_delivery_date.toISOString().slice(0, 10)
        : null,
    };
  }

  private async itemLabel(
    tx: Prisma.TransactionClient,
    itemType: InventoryItemType,
    itemId: string,
  ): Promise<string> {
    if (itemType === 'COIL') {
      const coil = await tx.coil.findUnique({ where: { id: itemId }, select: { code: true } });
      return coil?.code ?? 'la bobina';
    }
    const product = await tx.product.findUnique({ where: { id: itemId }, select: { sku: true } });
    return product?.sku ?? 'el producto';
  }

  /**
   * Etiqueta y nombre de cada ítem reservado, en dos consultas para toda la lista. Acepta
   * tanto filas de reserva (`itemType`/`itemId`) como líneas de pedido
   * (`reserveItemType`/`reserveItemId`), que son las mismas coordenadas con otro nombre.
   */
  private async reserveLabels(
    rows: ReserveRef[],
  ): Promise<Map<string, { label: string; name: string }>> {
    const refs = rows.map((r) => ({
      itemType: 'itemType' in r ? r.itemType : r.reserveItemType,
      itemId: 'itemId' in r ? r.itemId : r.reserveItemId,
    }));
    const map = new Map<string, { label: string; name: string }>();
    const coilIds = refs.filter((r) => r.itemType === 'COIL').map((r) => r.itemId);
    const productIds = refs.filter((r) => r.itemType === 'PRODUCT').map((r) => r.itemId);
    if (coilIds.length > 0) {
      const coils = await this.prisma.coil.findMany({
        where: { id: { in: coilIds } },
        select: { id: true, code: true, typeKey: true },
      });
      for (const c of coils) map.set(c.id, { label: c.code, name: c.typeKey });
    }
    if (productIds.length > 0) {
      const products = await this.prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, sku: true, name: true },
      });
      for (const p of products) map.set(p.id, { label: p.sku, name: p.name });
    }
    return map;
  }

  private toReservationDto(
    row: ReservationRow,
    labels: Map<string, { label: string; name: string }>,
  ): ReservationDto {
    const op = row.productionOrders[0];
    const staleFrom = new Date(Date.now() - RESERVATION_STALE_DAYS * 24 * 60 * 60 * 1000);
    const label = labels.get(row.itemId);
    return {
      id: row.id,
      salesOrderId: row.salesOrderId,
      salesOrderCode: salesOrderCode(row.salesOrder.seq),
      salesOrderItemId: row.salesOrderItemId,
      customerName: row.salesOrder.customer.name,
      orderProductIds: [...new Set(row.salesOrder.items.map((i) => i.productId))],
      itemType: row.itemType,
      itemId: row.itemId,
      itemLabel: label?.label ?? row.itemId,
      itemName: label?.name ?? '',
      qty: row.qty.toFixed(3),
      unit: row.unit,
      status: row.status,
      productionOrderId: op?.id ?? null,
      productionOrderCode: op ? productionOrderCode(op.seq) : null,
      isStale: row.status === ReservationStatus.ACTIVE && row.createdAt < staleFrom,
      createdAt: row.createdAt.toISOString(),
      consumedAt: row.consumedAt?.toISOString() ?? null,
      releasedAt: row.releasedAt?.toISOString() ?? null,
    };
  }

  /** Nombres de los usuarios que crearon las filas, en una sola consulta. */
  private async resolveActorNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private toDto(
    row: OrderRow,
    labels: Map<string, { label: string; name: string }>,
    actors: Map<string, string>,
    queueStatus: QueueStatus | null = null,
  ): SalesOrderDto {
    return {
      id: row.id,
      code: salesOrderCode(row.seq),
      quotationId: row.quotation?.id ?? null,
      quotationCode: row.quotation ? quotationCode(row.quotation.seq) : null,
      customerId: row.customer.id,
      customerName: row.customer.name,
      customerDocNumber: row.customer.docNumber,
      businessLine: toSharedLineCode(row.businessLine.code),
      status: row.status,
      issueDate: row.issueDate.toISOString().slice(0, 10),
      subtotalPen: row.subtotalPen.toFixed(4),
      igvPen: row.igvPen.toFixed(4),
      totalPen: row.totalPen.toFixed(4),
      notes: row.notes,
      items: row.items.map((i) => toSalesItemDto(i, labels.get(i.reserveItemId)?.label ?? '')),
      reservations: row.reservations.map((r) => this.toReservationDto(r, labels)),
      createdAt: row.createdAt.toISOString(),
      createdByName: actors.get(row.createdById) ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      promisedDeliveryDate: row.promisedDeliveryDate
        ? row.promisedDeliveryDate.toISOString().slice(0, 10)
        : null,
      priority: row.priorityById !== null,
      priorityReason: row.priorityReason,
      priorityByName: row.priorityById ? (actors.get(row.priorityById) ?? null) : null,
      queueStatus,
    };
  }
}

function toReserveRef(item: { reserveItemType: InventoryItemType; reserveItemId: string }): {
  itemType: InventoryItemType;
  itemId: string;
} {
  return { itemType: item.reserveItemType, itemId: item.reserveItemId };
}
