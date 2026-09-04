import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DispatchStatus,
  FiscalDocType,
  FiscalDocumentStatus,
  Prisma,
  SalesOrderStatus,
  type InventoryItemType,
} from '@prisma/client';
import {
  Decimal,
  Unit,
  dispatchCode,
  salesOrderCode,
  toDecimal,
  toFixedString,
  type CreateDispatchInput,
  type DispatchDto,
  type DispatchListItemDto,
  type DispatchQuery,
  type TransportSuggestionsDto,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { consumeReservationQty, restoreReservationQty } from '../sales/reservation-guard';
import { pendingQty, proratedQty } from './invoicing-math';

/**
 * Despacho de un pedido (RF-77..RF-79; D-074, D-078).
 *
 * Es el módulo que **saca la mercadería**, y de ahí salen sus tres responsabilidades:
 *
 * 1. **Mueve kardex** (regla dura 2): una salida por línea, por `InventoryService`, nunca
 *    escribiendo stock a mano.
 * 2. **Consume la reserva antes de mover el kardex** (D-066/D-074). Si fuera al revés, la
 *    propia reserva del pedido bloquearía contra la invariante justo la salida que viene a
 *    cumplirla. Y consume **solo lo despachado**, no la reserva entera: lo que queda de la
 *    línea sigue prometido y sigue protegido.
 * 3. **Cierra el pedido** —`PARTIALLY_FULFILLED` o `FULFILLED`— porque atender un pedido
 *    es un hecho del almacén, no de SUNAT (D-074). Facturar no lo cierra.
 *
 * La reversa deshace las tres cosas, y se bloquea si un documento electrónico vigente
 * declara ese traslado: deshacer una salida que una guía o una factura ya declararon
 * dejaría al kardex y a SUNAT contando cosas distintas.
 */

const dispatchInclude = {
  salesOrder: {
    select: {
      id: true,
      seq: true,
      status: true,
      businessLineId: true,
      customer: { select: { name: true } },
    },
  },
  items: {
    orderBy: { lineNumber: 'asc' },
    include: {
      product: { select: { sku: true } },
      salesOrderItem: { select: { id: true, lineNumber: true } },
    },
  },
  documents: {
    orderBy: { createdAt: 'desc' },
    select: { id: true, number: true, status: true },
  },
} satisfies Prisma.DispatchInclude;

type DispatchRow = Prisma.DispatchGetPayload<{ include: typeof dispatchInclude }>;

/**
 * Estados en los que un documento electrónico **ya declara** el traslado, y por lo tanto
 * bloquea la reversa del despacho.
 *
 * `SEND_ERROR` está adentro, y es justo el caso que había que cubrir: un documento en ese
 * estado tomó correlativo y el job lo va a seguir reintentando (D-073), así que revertir el
 * despacho mientras tanto termina con el PSE recibiendo una guía que declara un traslado
 * que ya no existe. Es la misma lista que `LIVE_DOCUMENT_STATUSES` en `invoicing.service.ts`
 * y que fueran distintas era el defecto.
 */
const DECLARED_STATUSES: FiscalDocumentStatus[] = [
  FiscalDocumentStatus.ISSUED,
  FiscalDocumentStatus.SEND_ERROR,
  FiscalDocumentStatus.ACCEPTED,
  FiscalDocumentStatus.VOID_PENDING,
];

function toDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

@Injectable()
export class DispatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
  ) {}

  // -------------------------------------------------------------------------
  // RF-77 — despachar
  // -------------------------------------------------------------------------

  async create(actor: RequestUser, input: CreateDispatchInput): Promise<DispatchDto> {
    const id = await this.prisma.$transaction(
      async (tx) => {
        // Lock del pedido primero, igual que `SalesOrdersService.cancel`: dos despachos
        // simultáneos del mismo pedido se serializan en vez de repartirse el pendiente.
        await tx.$queryRaw`
          SELECT "id" FROM "sales_orders" WHERE "id" = ${input.salesOrderId}::uuid FOR UPDATE
        `;
        const order = await tx.salesOrder.findUnique({
          where: { id: input.salesOrderId },
          include: {
            items: { orderBy: { lineNumber: 'asc' }, include: { reservation: true } },
          },
        });
        if (!order) throw new NotFoundException('Pedido no encontrado');
        if (order.status === SalesOrderStatus.CANCELLED) {
          throw new BadRequestException('El pedido está anulado: no se puede despachar');
        }

        const byId = new Map(order.items.map((i) => [i.id, i]));
        const dispatchedBefore = await this.dispatchedByItem(
          tx,
          order.items.map((i) => i.id),
        );

        // Resolución de líneas. Se hace entera antes de tocar kardex para que una línea
        // que no cabe no deje al despacho a medias: todo o nada, como el resto del proyecto.
        const lines = input.items.map((item) => {
          const orderItem = byId.get(item.salesOrderItemId);
          if (!orderItem) {
            throw new BadRequestException('Hay una línea que no pertenece a este pedido');
          }
          const qty = toDecimal(item.qty);
          const pending = pendingQty(
            orderItem.qty.toString(),
            dispatchedBefore.get(orderItem.id) ?? new Decimal(0),
          );
          if (qty.gt(pending)) {
            throw new BadRequestException(
              `A la línea ${orderItem.lineNumber} le quedan ${pending.toFixed(3)} por despachar y se intentan despachar ${qty.toFixed(3)}`,
            );
          }
          // **La cantidad que sale del kardex no es la de venta.** Una cobertura se vende
          // por pieza y sale de los kilos de una bobina (D-066): despachar 100 piezas tiene
          // que sacar los kilos que esa línea reservó, no 100 kilos. En perfiles y trading
          // las dos cifras coinciden —el ítem reservado es el propio producto—, que es
          // justo lo que hace que el error pase desapercibido hasta la primera cobertura.
          const reserveQty = proratedQty(
            qty,
            orderItem.qty.toString(),
            orderItem.reserveQty.toString(),
          );
          if (reserveQty.lte(0)) {
            throw new BadRequestException(
              `La línea ${orderItem.lineNumber} no tiene material asignado: no se puede despachar`,
            );
          }
          // El peso de la guía es un dato de transporte y por eso es editable; por defecto
          // es el mismo número, que es lo correcto cuando la reserva ya está en kilos.
          const weightKg = item.weightKg !== undefined ? toDecimal(item.weightKg) : reserveQty;
          return { orderItem, qty, reserveQty, weightKg };
        });

        const dispatch = await tx.dispatch.create({
          data: {
            salesOrderId: order.id,
            status: DispatchStatus.ISSUED,
            dispatchDate: toDateOnly(input.dispatchDate),
            originAddress: input.originAddress,
            destinationAddress: input.destinationAddress,
            originUbigeo: input.originUbigeo,
            destinationUbigeo: input.destinationUbigeo,
            transferMode: input.transferMode,
            totalWeightKg: toFixedString(input.totalWeightKg, 'KG'),
            packageCount: input.packageCount ?? null,
            vehiclePlate: input.vehiclePlate ?? null,
            driverGivenNames: input.driverGivenNames ?? null,
            driverFamilyNames: input.driverFamilyNames ?? null,
            driverDocType: input.driverDocType ?? null,
            driverDocNumber: input.driverDocNumber ?? null,
            driverLicense: input.driverLicense ?? null,
            carrierDocNumber: input.carrierDocNumber ?? null,
            carrierName: input.carrierName ?? null,
            notes: input.notes ?? null,
            createdById: actor.id,
          },
        });

        // Orden de locks: bobinas y después saldos, el mismo que usan `production.consume`
        // y `createReservations`. Invertirlo abre la ventana en la que un envío a corte o
        // una confirmación de pedido se cruzan con esta salida.
        const coilIds = [
          ...new Set(
            lines
              .filter((l) => l.orderItem.reserveItemType === ('COIL' as InventoryItemType))
              .map((l) => l.orderItem.reserveItemId),
          ),
        ].sort();
        if (coilIds.length > 0) {
          await tx.$queryRaw`
            SELECT "id" FROM "coils" WHERE "id" = ANY(${coilIds}::uuid[]) ORDER BY "id" FOR UPDATE
          `;
        }

        let lineNumber = 0;
        for (const line of lines) {
          lineNumber += 1;
          const { orderItem, qty, reserveQty, weightKg } = line;

          // D-074: la reserva se descuenta **antes** de la salida de kardex. Solo lo que
          // este despacho se lleva, y **en la unidad de la reserva**: el resto de la línea
          // sigue prometido y protegido.
          if (orderItem.reservation) {
            await consumeReservationQty(tx, orderItem.reservation.id, reserveQty);
          }

          const movement = await this.inventory.record(tx, {
            businessLineId: order.businessLineId,
            itemType: orderItem.reserveItemType,
            itemId: orderItem.reserveItemId,
            type: 'OUT',
            qty: toFixedString(reserveQty, 'KG'),
            unit: orderItem.reserveUnit,
            refType: 'SALE',
            refId: dispatch.id,
            notes: `Despacho ${dispatchCode(dispatch.seq)} de ${salesOrderCode(order.seq)}`,
            actorId: actor.id,
          });

          await tx.dispatchItem.create({
            data: {
              dispatchId: dispatch.id,
              lineNumber,
              salesOrderItemId: orderItem.id,
              productId: orderItem.productId,
              description: orderItem.description,
              qty: toFixedString(qty, 'KG'),
              unit: orderItem.unit,
              reserveQty: toFixedString(reserveQty, 'KG'),
              weightKg: toFixedString(weightKg, 'KG'),
              itemType: orderItem.reserveItemType,
              itemId: orderItem.reserveItemId,
              // Null solo en líneas de negocio sin inventario (`NOOP`, §2.2), donde
              // `record` devuelve null a propósito. La reversa lo trata como no-op.
              movementId: movement?.id ?? null,
            },
          });
        }

        const status = await this.recomputeOrderStatus(tx, order.id);

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'invoicing.dispatch.create',
          entity: 'dispatches',
          entityId: dispatch.id,
          after: {
            code: dispatchCode(dispatch.seq),
            salesOrder: salesOrderCode(order.seq),
            lines: lines.length,
            orderStatus: status,
          },
        });
        return dispatch.id;
      },
      // Un despacho toma un lock por línea sobre bobinas y saldos, igual que la
      // confirmación de un pedido; el timeout por defecto de Prisma no alcanza contra Neon.
      { timeout: 30_000 },
    );

    return this.findOne(id);
  }

  // -------------------------------------------------------------------------
  // RF-79 — revertir el despacho
  // -------------------------------------------------------------------------

  /**
   * Devuelve el stock, restaura las reservas y recalcula el estado del pedido.
   *
   * **El guardrail de la fase**: se bloquea si un documento electrónico vigente declara
   * este traslado. Son dos casos distintos y los dos importan:
   *
   * - la **guía de remisión del propio despacho**, que es literalmente el papel que dice
   *   que esa mercadería salió;
   * - un **comprobante vigente del mismo pedido** que factura alguna de las líneas que
   *   este despacho sacó.
   *
   * En los dos, el camino es al revés del que se intenta: primero se resuelve el documento
   * (baja o nota de crédito) y después se revierte el despacho. Deshacerlo al revés dejaría
   * al kardex diciendo que la mercadería está en el almacén y a SUNAT diciendo que salió.
   */
  async reverse(actor: RequestUser, id: string, reason: string): Promise<DispatchDto> {
    await this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          { id: string; status: DispatchStatus; sales_order_id: string }[]
        >`
          SELECT "id", "status", "sales_order_id" FROM "dispatches"
          WHERE "id" = ${id}::uuid FOR UPDATE
        `;
        const head = rows[0];
        if (!head) throw new NotFoundException('Despacho no encontrado');
        if (head.status === DispatchStatus.REVERSED) {
          throw new ConflictException('El despacho ya fue revertido');
        }

        // El pedido, en el mismo orden que `create`: pedido → bobinas → saldos.
        await tx.$queryRaw`
          SELECT "id" FROM "sales_orders" WHERE "id" = ${head.sales_order_id}::uuid FOR UPDATE
        `;

        const dispatch = await tx.dispatch.findUniqueOrThrow({
          where: { id },
          include: {
            items: {
              orderBy: { lineNumber: 'asc' },
              include: { salesOrderItem: { include: { reservation: true } } },
            },
            documents: { select: { number: true, status: true } },
          },
        });

        const declaredNote = dispatch.documents.find((d) => DECLARED_STATUSES.includes(d.status));
        if (declaredNote) {
          throw new BadRequestException(
            `La guía ${declaredNote.number ?? 'de este despacho'} está vigente: dala de baja antes de revertir el despacho`,
          );
        }

        const blocking = await tx.fiscalDocument.findFirst({
          where: {
            salesOrderId: dispatch.salesOrderId,
            status: { in: DECLARED_STATUSES },
            docType: { in: [FiscalDocType.FACTURA, FiscalDocType.BOLETA] },
            items: {
              some: { salesOrderItemId: { in: dispatch.items.map((i) => i.salesOrderItemId) } },
            },
          },
          select: { number: true },
        });
        if (blocking) {
          throw new BadRequestException(
            `El comprobante ${blocking.number ?? ''} factura líneas de este despacho: dalo de baja o emite una nota de crédito antes de revertirlo`,
          );
        }

        for (const item of dispatch.items) {
          if (item.movementId !== null) {
            await this.inventory.reverse(tx, item.movementId, actor.id, reason);
          }
          // Toda reversa aguas abajo restaura la reserva (D-066/D-074): sin esto el
          // material vuelve al almacén sin nada que lo proteja mientras el pedido lo
          // sigue prometiendo, que es el defecto que 5a costó encontrar.
          if (item.salesOrderItem.reservation) {
            // `reserveQty` y no `qty`: se devuelve exactamente lo que salió, en la unidad
            // del ítem de kardex.
            await restoreReservationQty(
              tx,
              item.salesOrderItem.reservation.id,
              toDecimal(item.reserveQty.toString()),
            );
          }
        }

        await tx.dispatch.update({
          where: { id },
          data: {
            status: DispatchStatus.REVERSED,
            reversedAt: new Date(),
            reversedById: actor.id,
          },
        });

        const status = await this.recomputeOrderStatus(tx, dispatch.salesOrderId);

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'invoicing.dispatch.reverse',
          entity: 'dispatches',
          entityId: id,
          before: { status: DispatchStatus.ISSUED, lines: dispatch.items.length },
          after: { status: DispatchStatus.REVERSED, reason, orderStatus: status },
        });
      },
      { timeout: 30_000 },
    );

    return this.findOne(id);
  }

  // -------------------------------------------------------------------------
  // D-074 — el estado del pedido lo decide lo despachado
  // -------------------------------------------------------------------------

  /**
   * Recalcula el estado del pedido **desde las filas de despacho vigentes**, nunca desde
   * un contador: es lo que hace que la reversa de un despacho devuelva el pedido al estado
   * correcto sin ninguna lógica de "restar lo que sumé".
   *
   * No toca `IN_PRODUCTION` mientras no haya nada despachado: ese estado lo pone y lo quita
   * la orden de producción (D-060), y pisarlo acá haría que despachar una línea suelta
   * borrara el hecho de que la planta sigue fabricando el resto.
   */
  private async recomputeOrderStatus(
    tx: Prisma.TransactionClient,
    salesOrderId: string,
  ): Promise<SalesOrderStatus> {
    const order = await tx.salesOrder.findUniqueOrThrow({
      where: { id: salesOrderId },
      select: { status: true, items: { select: { id: true, qty: true } } },
    });
    if (order.status === SalesOrderStatus.CANCELLED) return order.status;

    const dispatched = await this.dispatchedByItem(
      tx,
      order.items.map((i) => i.id),
    );
    const anyDispatched = [...dispatched.values()].some((q) => q.gt(0));
    const allComplete = order.items.every((item) =>
      (dispatched.get(item.id) ?? new Decimal(0)).gte(toDecimal(item.qty.toString())),
    );

    const next = allComplete
      ? SalesOrderStatus.FULFILLED
      : anyDispatched
        ? SalesOrderStatus.PARTIALLY_FULFILLED
        : order.status === SalesOrderStatus.IN_PRODUCTION
          ? SalesOrderStatus.IN_PRODUCTION
          : SalesOrderStatus.CONFIRMED;

    if (next !== order.status) {
      await tx.salesOrder.update({ where: { id: salesOrderId }, data: { status: next } });
    }
    return next;
  }

  /** Cantidad despachada vigente por línea de pedido. Los revertidos no cuentan. */
  private async dispatchedByItem(
    tx: Prisma.TransactionClient,
    salesOrderItemIds: string[],
  ): Promise<Map<string, Decimal>> {
    if (salesOrderItemIds.length === 0) return new Map();
    const rows = await tx.dispatchItem.groupBy({
      by: ['salesOrderItemId'],
      where: {
        salesOrderItemId: { in: salesOrderItemIds },
        dispatch: { status: DispatchStatus.ISSUED },
      },
      _sum: { qty: true },
    });
    return new Map(
      rows.map((r) => [
        r.salesOrderItemId,
        toDecimal((r._sum.qty ?? new Prisma.Decimal(0)).toString()),
      ]),
    );
  }

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  async findAll(query: DispatchQuery): Promise<DispatchListItemDto[]> {
    const where: Prisma.DispatchWhereInput = {
      status: query.status,
      salesOrderId: query.salesOrderId,
    };
    if (query.search) {
      where.OR = [
        { salesOrder: { customer: { name: { contains: query.search, mode: 'insensitive' } } } },
        { vehiclePlate: { contains: query.search, mode: 'insensitive' } },
        { carrierName: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const rows = await this.prisma.dispatch.findMany({
      where,
      include: dispatchInclude,
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    const actors = await this.resolveActorNames(
      rows.flatMap((r) => [r.createdById, r.reversedById]),
    );
    return rows.map((row) => {
      const { items, blockingDocumentNumbers: _blocking, ...rest } = this.toDto(row, actors, []);
      return { ...rest, itemCount: items.length };
    });
  }

  async findOne(id: string): Promise<DispatchDto> {
    const row = await this.prisma.dispatch.findUnique({ where: { id }, include: dispatchInclude });
    if (!row) throw new NotFoundException('Despacho no encontrado');
    const actors = await this.resolveActorNames([row.createdById, row.reversedById]);

    // Lo que hoy bloquearía la reversa, para que la pantalla lo diga antes de que alguien
    // escriba un motivo y reciba un error.
    const blocking = await this.prisma.fiscalDocument.findMany({
      where: {
        salesOrderId: row.salesOrderId,
        status: { in: DECLARED_STATUSES },
        docType: { in: [FiscalDocType.FACTURA, FiscalDocType.BOLETA] },
        items: { some: { salesOrderItemId: { in: row.items.map((i) => i.salesOrderItemId) } } },
      },
      select: { number: true },
    });

    return this.toDto(
      row,
      actors,
      blocking.flatMap((b) => (b.number ? [b.number] : [])),
    );
  }

  /**
   * D-078: valores de transporte ya usados, para autocompletar. Reemplaza al catálogo de
   * vehículos y conductores, que queda diferido: sale de los datos reales y no cuesta una
   * tabla ni un ABM.
   */
  async transportSuggestions(): Promise<TransportSuggestionsDto> {
    const rows = await this.prisma.dispatch.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        vehiclePlate: true,
        driverGivenNames: true,
        driverFamilyNames: true,
        driverDocType: true,
        driverDocNumber: true,
        driverLicense: true,
        carrierDocNumber: true,
        carrierName: true,
        originAddress: true,
        originUbigeo: true,
      },
    });

    const vehicles = new Map<string, { plate: string }>();
    const drivers = new Map<string, TransportSuggestionsDto['drivers'][number]>();
    const carriers = new Map<string, { docNumber: string; name: string }>();
    const origins = new Map<string, { address: string; ubigeo: string }>();

    for (const r of rows) {
      if (r.vehiclePlate) vehicles.set(r.vehiclePlate, { plate: r.vehiclePlate });
      if (
        r.driverGivenNames &&
        r.driverFamilyNames &&
        r.driverDocType &&
        r.driverDocNumber &&
        r.driverLicense
      ) {
        drivers.set(r.driverDocNumber, {
          givenNames: r.driverGivenNames,
          familyNames: r.driverFamilyNames,
          docType: r.driverDocType,
          docNumber: r.driverDocNumber,
          license: r.driverLicense,
        });
      }
      if (r.carrierDocNumber && r.carrierName) {
        carriers.set(r.carrierDocNumber, { docNumber: r.carrierDocNumber, name: r.carrierName });
      }
      origins.set(`${r.originUbigeo}:${r.originAddress}`, {
        address: r.originAddress,
        ubigeo: r.originUbigeo,
      });
    }

    return {
      vehicles: [...vehicles.values()].slice(0, 20),
      drivers: [...drivers.values()].slice(0, 20),
      carriers: [...carriers.values()].slice(0, 20),
      origins: [...origins.values()].slice(0, 10),
    };
  }

  private async resolveActorNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private toDto(
    row: DispatchRow,
    actors: Map<string, string>,
    blockingDocumentNumbers: string[],
  ): DispatchDto {
    // La guía "vigente" es la última que sigue en pie: un rechazo conserva su correlativo
    // y una baja también queda en el historial (D-072), pero ninguno de los dos es la guía
    // del traslado.
    const note = row.documents.find(
      (d) => d.status !== FiscalDocumentStatus.REJECTED && d.status !== FiscalDocumentStatus.VOIDED,
    );
    return {
      id: row.id,
      code: dispatchCode(row.seq),
      salesOrderId: row.salesOrderId,
      salesOrderCode: salesOrderCode(row.salesOrder.seq),
      customerName: row.salesOrder.customer.name,
      status: row.status,
      dispatchDate: row.dispatchDate.toISOString().slice(0, 10),
      originAddress: row.originAddress,
      destinationAddress: row.destinationAddress,
      originUbigeo: row.originUbigeo,
      destinationUbigeo: row.destinationUbigeo,
      transferMode: row.transferMode,
      totalWeightKg: row.totalWeightKg.toFixed(3),
      packageCount: row.packageCount,
      vehiclePlate: row.vehiclePlate,
      driverGivenNames: row.driverGivenNames,
      driverFamilyNames: row.driverFamilyNames,
      driverDocType: row.driverDocType,
      driverDocNumber: row.driverDocNumber,
      driverLicense: row.driverLicense,
      carrierDocNumber: row.carrierDocNumber,
      carrierName: row.carrierName,
      notes: row.notes,
      dispatchNoteId: note?.id ?? null,
      dispatchNoteNumber: note?.number ?? null,
      dispatchNoteStatus: note?.status ?? null,
      blockingDocumentNumbers,
      createdByName: actors.get(row.createdById) ?? null,
      createdAt: row.createdAt.toISOString(),
      reversedAt: row.reversedAt?.toISOString() ?? null,
      reversedByName: row.reversedById ? (actors.get(row.reversedById) ?? null) : null,
      items: row.items.map((i) => ({
        id: i.id,
        lineNumber: i.lineNumber,
        salesOrderItemId: i.salesOrderItemId,
        productId: i.productId,
        productSku: i.product.sku,
        description: i.description,
        qty: i.qty.toFixed(3),
        unit: i.unit,
        reserveQty: i.reserveQty.toFixed(3),
        weightKg: i.weightKg.toFixed(3),
        itemType: i.itemType,
        itemId: i.itemId,
      })),
    };
  }
}

/** Unidad por defecto del peso de una guía. Se declara acá para no repetir el literal. */
export const DISPATCH_WEIGHT_UNIT = Unit.KGM;
