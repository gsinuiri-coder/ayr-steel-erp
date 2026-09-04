import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  QuotationStatus,
  ReservationStatus,
  SalesOrderStatus,
  type InventoryItemType,
} from '@prisma/client';
import {
  productionOrderCode,
  quotationCode,
  RESERVATION_STALE_DAYS,
  salesOrderCode,
  toDecimal,
  type CreateSalesOrderInput,
  type ReservationDto,
  type ReservationQuery,
  type SalesOrderDto,
  type SalesOrderListItemDto,
  type SalesOrderQuery,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { toPrismaLineCode, toSharedLineCode } from '../common/business-line-code';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { documentTotals, resolveSalesLines, toSalesItemDto } from './sales-lines';

function toDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const orderInclude = {
  customer: { select: { id: true, name: true, docNumber: true } },
  businessLine: { select: { code: true } },
  quotation: { select: { id: true, seq: true } },
  items: {
    orderBy: { lineNumber: 'asc' },
    include: { product: { select: { sku: true, name: true } } },
  },
  reservations: {
    orderBy: { createdAt: 'asc' },
    include: {
      salesOrder: { select: { seq: true, customer: { select: { name: true } } } },
      productionOrders: { select: { id: true, seq: true }, take: 1 },
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
 * parcial"). Anular el pedido libera las reservas por el mismo camino, y se bloquea si una
 * OP ya consumió una — ahí la promesa dejó de ser una promesa y pasó a ser material que
 * salió del almacén.
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
  async confirm(actor: RequestUser, quotationId: string): Promise<SalesOrderDto> {
    const orderId = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; seq: number; status: QuotationStatus; valid_until: Date }[]
      >`
        SELECT "id", "seq", "status", "valid_until"
        FROM "quotations" WHERE "id" = ${quotationId}::uuid FOR UPDATE
      `;
      const head = rows[0];
      if (!head) throw new NotFoundException('Cotización no encontrada');

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
      if (validUntil < today()) {
        throw new BadRequestException(
          `La cotización venció el ${validUntil}: no se puede confirmar`,
        );
      }

      const quotation = await tx.quotation.findUniqueOrThrow({
        where: { id: quotationId },
        include: { items: { orderBy: { lineNumber: 'asc' } } },
      });
      if (quotation.items.length === 0) {
        throw new BadRequestException('La cotización no tiene líneas');
      }

      const order = await tx.salesOrder.create({
        data: {
          quotationId,
          customerId: quotation.customerId,
          businessLineId: quotation.businessLineId,
          status: SalesOrderStatus.CONFIRMED,
          issueDate: toDateOnly(today()),
          subtotalPen: quotation.subtotalPen,
          igvPen: quotation.igvPen,
          totalPen: quotation.totalPen,
          notes: quotation.notes,
          createdById: actor.id,
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
    });

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
    const orderId = await this.prisma.$transaction(async (tx) => {
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

      const lines = await resolveSalesLines(tx, line.id, line.quotationRequired, input.items);
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
    });

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
   * Las líneas se ordenan por `(itemType, itemId)` antes de tomar los locks. Dos
   * confirmaciones simultáneas que compartan ítems los piden en el mismo orden, así que se
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
   * Anula el pedido y libera sus reservas activas. Se bloquea si una OP ya consumió alguna:
   * ahí el material salió del almacén y devolverlo es asunto de las reversas de producción
   * (D-060), no de una anulación comercial.
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

      const reservations = await tx.reservation.findMany({
        where: { salesOrderId: id },
        include: { productionOrders: { select: { seq: true }, take: 1 } },
      });
      const consumed = reservations.filter((r) => r.status === ReservationStatus.CONSUMED);
      if (consumed.length > 0) {
        const detail = consumed
          .map((r) => {
            const op = r.productionOrders[0];
            return op ? `orden ${productionOrderCode(op.seq)}` : 'una orden de producción';
          })
          .join(', ');
        throw new BadRequestException(
          `No se puede anular: ${detail} ya consumió el material reservado. Revierte o anula la orden de producción primero.`,
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
        const back = validUntil < today() ? QuotationStatus.EXPIRED : QuotationStatus.EMITTED;
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
        select: { id: true, status: true, salesOrderId: true },
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
        salesOrder: { select: { seq: true, customer: { select: { name: true } } } },
        productionOrders: { select: { id: true, seq: true }, take: 1 },
      },
    });
    const labels = await this.reserveLabels([row]);
    return this.toReservationDto(row, labels);
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
      include: orderInclude,
      orderBy: { seq: 'desc' },
      take: 500,
    });
    const actors = await this.resolveActorNames(rows.map((r) => r.createdById));
    return rows.map((r) => {
      const dto = this.toDto(r, new Map(), actors);
      const { items, reservations, ...rest } = dto;
      return {
        ...rest,
        itemCount: items.length,
        activeReservations: reservations.filter((x) => x.status === 'ACTIVE').length,
      };
    });
  }

  async findOne(id: string): Promise<SalesOrderDto> {
    const row = await this.prisma.salesOrder.findUnique({ where: { id }, include: orderInclude });
    if (!row) throw new NotFoundException('Pedido no encontrado');
    const labels = await this.reserveLabels([...row.items.map(toReserveRef), ...row.reservations]);
    const actors = await this.resolveActorNames([row.createdById]);
    return this.toDto(row, labels, actors);
  }

  async findReservations(query: ReservationQuery): Promise<ReservationDto[]> {
    const rows = await this.prisma.reservation.findMany({
      where: {
        status: query.status,
        itemId: query.itemId,
        salesOrderId: query.salesOrderId,
      },
      include: {
        salesOrder: { select: { seq: true, customer: { select: { name: true } } } },
        productionOrders: { select: { id: true, seq: true }, take: 1 },
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
  ): Promise<{ id: string; status: SalesOrderStatus; quotationId: string | null }> {
    const rows = await tx.$queryRaw<
      { id: string; status: SalesOrderStatus; quotation_id: string | null }[]
    >`
      SELECT "id", "status", "quotation_id" FROM "sales_orders" WHERE "id" = ${id}::uuid FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new NotFoundException('Pedido no encontrado');
    return { id: row.id, status: row.status, quotationId: row.quotation_id };
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
    };
  }
}

function toReserveRef(item: { reserveItemType: InventoryItemType; reserveItemId: string }): {
  itemType: InventoryItemType;
  itemId: string;
} {
  return { itemType: item.reserveItemType, itemId: item.reserveItemId };
}
