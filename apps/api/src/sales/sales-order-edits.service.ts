import { assertSellerAccess } from '../auth/seller-scope';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DispatchStatus,
  FiscalDocType,
  InventoryItemType,
  Prisma,
  ProductionOrderKind,
  ProductionOrderStatus,
  ProductionReportStatus,
  ReservationStatus,
  SalesOrderStatus,
} from '@prisma/client';
import {
  businessToday,
  carriesInventory,
  Decimal,
  describePieces,
  piecesCount,
  piecesMeters,
  toDecimal,
  type PieceLike,
  type QtyChangeKind,
  type SalesOrderItemQtyOutcomeDto,
  type SalesOrderItemQtyPreviewDto,
  type SalesOrderItemQtyPreviewInput,
  DERIVED_UNIT_VALUE_DECIMALS,
  derivedUnitValue,
  isImportedQuotation,
  lineAmounts,
  MAX_SALES_ITEMS,
  money,
  productionOrderCode,
  Role,
  salesOrderCode,
  STANDING_DOCUMENT_STATUSES,
  roundDocumentTotals,
  toFixedString,
  Unit,
  type AddSalesOrderItemsInput,
  type ChangeSalesOrderCustomerInput,
  type LineAmountBasis,
  type SalesItemInput,
  type SalesOrderDto,
  type UpdateSalesOrderItemCoilInput,
  type UpdateSalesOrderItemPriceInput,
  type UpdateSalesOrderItemQtyInput,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { claimIdempotencyKey } from '../common/idempotency';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { roofingToleranceMm } from '../production/roofing-coil-match';
import { lockDocuments } from '../inventory/document-locks';
import { derivePiecesPlan } from '../production/roofing-math';
import { RoofingProductionService } from '../production/roofing-production.service';
import {
  COIL_SALE_IDENTITY_SELECT,
  coilPoolFor,
  coilSaleSkus,
  findCoilSaleProducts,
  lineCoilPool,
} from './coil-sale-product';
import { unitSymbol } from '../common/unit-symbol';
import { sumReportedMeters } from '../production/reported-meters';
import type { ShortfallLine } from './order-shortfall';
import { recordPriceChanges } from './price-changes';
import {
  lengthRows,
  piecesChanges,
  piecesMinus,
  qtyFloorViolation,
  qtyKindOf,
  releaseSplit,
  samePieces,
} from './qty-change';
import { rawMaterialSpecLabels } from './raw-material';
import { assertPriceFloor } from './price-floor';
import { resolveSalesLines } from './sales-lines';
import { SalesOrdersService } from './sales-orders.service';

/** La línea con lo que las ediciones leen de ella. */
const ITEM_INCLUDE = {
  product: {
    select: {
      businessLineId: true,
      lengthMm: true,
      sku: true,
      name: true,
      roofingKind: true,
      businessLine: { select: { code: true } },
    },
  },
  pieces: { orderBy: { lineNumber: 'asc' } },
} satisfies Prisma.SalesOrderItemInclude;

type QtyItem = Prisma.SalesOrderItemGetPayload<{ include: typeof ITEM_INCLUDE }>;

/** cc45: lo que la línea tiene hoy, leído bajo los locks de sus OP y sus reservas. */
interface QtyFacts {
  kind: QtyChangeKind;
  reservations: {
    id: string;
    status: ReservationStatus;
    itemType: InventoryItemType;
    itemId: string;
    qty: Decimal;
    shortfallQty: Decimal;
  }[];
  orders: {
    id: string;
    seq: number;
    status: ProductionOrderStatus;
    reservationId: string | null;
    live: boolean;
    planMeters: Decimal;
    registeredMeters: Decimal;
  }[];
  registeredPieces: PieceLike[];
  registeredClosedPieces: PieceLike[];
  /** En la unidad de la línea: metros (a medida, accesorio) o planchas (catálogo). */
  registeredQty: Decimal;
  registeredClosedQty: Decimal;
  dispatchedQty: Decimal;
  hasProduction: boolean;
  hasDispatches: boolean;
  /** Órdenes de perfiles (drywall) atadas a la línea antes de D-599: su producción es otra. */
  drywallOrders: string[];
}

type QtyOutcome = Omit<SalesOrderItemQtyOutcomeDto, 'ok' | 'message'>;

/** La vista previa corre la acción y la deshace tirando esto (como `previewPlantClose`). */
class QtyPreviewRollback extends Error {
  constructor(readonly result: SalesOrderItemQtyPreviewDto) {
    super('vista previa de la cantidad');
  }
}

function httpMessage(error: HttpException): string {
  const response = error.getResponse();
  if (typeof response === 'string') return response;
  const message = (response as { message?: string | string[] }).message;
  return Array.isArray(message) ? message.join(' ') : (message ?? error.message);
}

function toPieceLike(row: { lengthMm: Prisma.Decimal; qty: number }): PieceLike {
  return { lengthMm: row.lengthMm.toFixed(2), qty: row.qty };
}

function lineMeters(kind: QtyChangeKind, item: QtyItem): string | null {
  return kind === 'PIECES' || kind === 'METERS' ? item.qty.toFixed(3) : null;
}

function linePieces(kind: QtyChangeKind, item: QtyItem): number | null {
  if (kind === 'PIECES') return piecesCount(item.pieces.map(toPieceLike));
  if (kind === 'UNITS') return item.qty.toNumber();
  return null;
}

/** `4,787.80`: solo para el texto de «Qué va a pasar». */
function formatPen(value: Decimal): string {
  const [int = '0', dec = '00'] = value.toFixed(2).split('.');
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
}

/** El pedido bloqueado, con lo que las cuatro ediciones necesitan mirar. */
interface LockedOrder {
  id: string;
  seq: number;
  status: SalesOrderStatus;
  createdById: string;
  sellerId: string | null;
  /** D-256: el pedido nació de una cotización importada (D-152). */
  imported: boolean;
}

/**
 * D-187 (F8-S2/M4): lo que se edita de un pedido **después** de confirmarlo y **antes** de su
 * comprobante.
 *
 * El corte es el comprobante —factura o boleta, en borrador o vivo— porque es el primer
 * documento que congela ante terceros el cliente, el precio y las cantidades: hasta ahí el
 * pedido es un acuerdo interno que el cliente todavía puede corregir por teléfono. La guía de
 * un despacho parcial no corta: no lleva precio, y agregar un ítem a un pedido medio
 * despachado es justo el caso que el dueño pidió.
 *
 * Quién edita qué:
 * - **Precio y cliente**: solo ADMINISTRADOR. Mientras era cotización lo decidía el vendedor;
 *   confirmada, cambiar el importe de lo comprometido es una excepción y queda con nombre.
 *   Cada cambio de precio pasa por el piso de D-163 y deja una fila en `sales_price_changes`.
 * - **Agregar ítems y cambiar la cantidad de una línea**: el vendedor dueño del pedido o
 *   ADMINISTRADOR. Reservan por la misma puerta que confirmar (`createReservations`) y generan
 *   o ajustan la OP igual que D-186.
 */
@Injectable()
export class SalesOrderEditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly orders: SalesOrdersService,
    private readonly roofing: RoofingProductionService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // -------------------------------------------------------------------------
  // Precio de una línea (solo ADMINISTRADOR)
  // -------------------------------------------------------------------------

  async updateItemPrice(
    actor: RequestUser,
    orderId: string,
    itemId: string,
    input: UpdateSalesOrderItemPriceInput,
  ): Promise<SalesOrderDto> {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockEditable(tx, orderId, 'cambiar el precio');
      const item = await this.requireItem(tx, orderId, itemId);
      const at = `Línea ${item.lineNumber}`;
      // D-256 (aclaración de D-163): lo que trajo el importador ya se vendió, a los precios a los
      // que se vendió. Corregirle una línea al pedido —igual que a la cotización— no la vuelve
      // una oferta nueva, así que no pasa por el piso; queda auditado como exento.
      const imported = order.imported;
      const floor = imported ? undefined : { toleranceMm: roofingToleranceMm(this.env) };

      let next: {
        unitPricePen: string;
        valuePerMeterPen: string | null;
        subtotalPen: string;
        igvPen: string;
        totalPen: string;
      };
      if (item.reserveItemType === InventoryItemType.COIL) {
        // Venta de bobina entera (D-116): la cantidad es el saldo que se reservó y el precio es
        // por kg. No pasa por `resolveSalesLines`, que volvería a leer el saldo **disponible**
        // de la bobina —cero, porque este mismo pedido la tiene reservada— y rechazaría.
        // D-255 (R2): por kg, con IGV o por importe de línea; el unitario se deriva.
        const basis: LineAmountBasis | null =
          input.netAmountPen !== undefined
            ? { netAmountPen: input.netAmountPen }
            : input.unitPriceWithIgvPen !== undefined
              ? { unitPriceWithIgvPen: input.unitPriceWithIgvPen }
              : input.unitPricePen !== undefined
                ? { unitValuePen: input.unitPricePen }
                : null;
        if (basis === null) {
          throw new BadRequestException(`${at}: la venta de una bobina se cotiza por kg`);
        }
        const amounts = lineAmounts(item.qty.toString(), basis);
        const unitPricePen = toFixedString(money(amounts.unitValue), 'MONEY');
        const coil = await tx.coil.findUniqueOrThrow({
          where: { id: item.reserveItemId },
          select: { code: true },
        });
        if (floor) {
          await assertPriceFloor(
            tx,
            [
              {
                at,
                sku: coil.code,
                businessLineId: item.product.businessLineId,
                basis: { kind: 'UNIT', unitLabel: 'kg' },
                unitValuePen: unitPricePen,
                cost: { kind: 'COIL', coilId: item.reserveItemId },
              },
            ],
            floor.toleranceMm,
          );
        }
        next = {
          unitPricePen,
          valuePerMeterPen: null,
          subtotalPen: toFixedString(amounts.subtotal, 'MONEY'),
          igvPen: toFixedString(amounts.igv, 'MONEY'),
          totalPen: toFixedString(amounts.total, 'MONEY'),
        };
      } else {
        // El resto recalcula la línea entera por el mismo camino que la cotización —mismo
        // redondeo, misma regla del valor por metro (D-161), mismo piso (D-163)— y se queda
        // solo con el precio y los importes: lo reservado no cambia con el precio.
        const [line] = await resolveSalesLines(tx, [this.lineInput(item, { price: input })], {
          ...(floor ? { priceFloor: floor } : {}),
          firstLineNumber: item.lineNumber,
        });
        if (!line) throw new NotFoundException(`${at}: no se pudo recalcular`);
        next = line;
      }

      const changed = await recordPriceChanges(
        tx,
        { salesOrderId: orderId },
        [item],
        [{ lineNumber: item.lineNumber, productId: item.productId, ...next }],
        actor.id,
      );
      // D-255: el registro de precios compara el unitario de cuatro decimales, y con el importe
      // como dato un cambio real puede no moverlo (3840 kg de 11 715.25 a 11 715.20 son 3.0508
      // los dos). Se guarda si cambió el unitario **o** cualquiera de los importes.
      const amountsChanged =
        !item.subtotalPen.equals(next.subtotalPen) ||
        !item.igvPen.equals(next.igvPen) ||
        !item.totalPen.equals(next.totalPen);
      if (changed === 0 && !amountsChanged) return;

      await tx.salesOrderItem.update({
        where: { id: item.id },
        data: {
          unitPricePen: next.unitPricePen,
          valuePerMeterPen: next.valuePerMeterPen,
          subtotalPen: next.subtotalPen,
          igvPen: next.igvPen,
          totalPen: next.totalPen,
        },
      });
      const totals = await this.refreshTotals(tx, orderId);

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.order.item-price',
        entity: 'sales_orders',
        entityId: orderId,
        before: {
          code: salesOrderCode(order.seq),
          lineNumber: item.lineNumber,
          unitPricePen: item.unitPricePen.toFixed(4),
          valuePerMeterPen: item.valuePerMeterPen?.toFixed(4) ?? null,
        },
        after: {
          unitPricePen: next.unitPricePen,
          valuePerMeterPen: next.valuePerMeterPen,
          subtotalPen: next.subtotalPen,
          totalPen: totals.totalPen,
          // D-255: la forma en que se cargó el precio; D-256: la exención del piso, con nombre.
          priceForm:
            input.netAmountPen !== undefined
              ? 'IMPORTE_DE_LINEA'
              : input.unitPriceWithIgvPen !== undefined
                ? 'PRECIO_CON_IGV'
                : input.valuePerMeterPen !== undefined
                  ? 'VALOR_POR_METRO'
                  : 'VALOR_UNITARIO',
          ...(imported ? { priceFloorExempt: 'D-163/D-256: pedido importado' } : {}),
        },
      });
    });
    return this.orders.findOne(orderId);
  }

  // -------------------------------------------------------------------------
  // D-255 (R2): restablecer el importe del comprobante de origen (barrido)
  // -------------------------------------------------------------------------

  /**
   * Devuelve a una línea de un pedido **importado y abierto** los importes del comprobante de
   * origen: el valor de venta y, si el papel los trae y cuadran, su IGV y su total. El unitario
   * se deriva (D-255). Solo lo usa el barrido de lo importado, con auditoría; un pedido con
   * comprobante no se toca (`lockEditable`), y uno que no viene del importador tampoco.
   */
  async restorePaperAmounts(
    actor: RequestUser,
    orderId: string,
    itemId: string,
    paper: { netAmountPen: string; igvAmountPen?: string; totalAmountPen?: string },
    reason: string,
  ): Promise<void> {
    await this.prisma.$transaction((tx) =>
      this.restorePaperAmountsInTx(tx, actor, orderId, itemId, paper, reason),
    );
  }

  /**
   * La misma corrección dentro de la transacción del llamador (el barrido corrige el pedido
   * entero). D-264: `recordPriceChange: false` desde el barrido, que queda solo en `audit_log`.
   */
  async restorePaperAmountsInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    orderId: string,
    itemId: string,
    paper: { netAmountPen: string; igvAmountPen?: string; totalAmountPen?: string },
    reason: string,
    options: { recordPriceChange?: boolean } = {},
  ): Promise<void> {
    const order = await this.lockEditable(tx, orderId, 'restablecer importes');
    if (!order.imported) {
      throw new BadRequestException(
        `${salesOrderCode(order.seq)} no viene del importador: no tiene comprobante de origen`,
      );
    }
    const item = await this.requireItem(tx, orderId, itemId);
    const amounts = lineAmounts(
      item.qty.toString(),
      paper.igvAmountPen !== undefined && paper.totalAmountPen !== undefined
        ? {
            netAmountPen: paper.netAmountPen,
            igvAmountPen: paper.igvAmountPen,
            totalAmountPen: paper.totalAmountPen,
          }
        : { netAmountPen: paper.netAmountPen },
    );
    const next = {
      unitPricePen: toFixedString(money(amounts.unitValue), 'MONEY'),
      // El importe del papel manda: un valor por metro guardado ya no lo describiría (D-161
      // deriva el unitario del metro, y acá el unitario sale del importe).
      valuePerMeterPen: null,
      subtotalPen: toFixedString(amounts.subtotal, 'MONEY'),
      igvPen: toFixedString(amounts.igv, 'MONEY'),
      totalPen: toFixedString(amounts.total, 'MONEY'),
    };
    if (options.recordPriceChange !== false) {
      await recordPriceChanges(
        tx,
        { salesOrderId: orderId },
        [item],
        [{ lineNumber: item.lineNumber, productId: item.productId, ...next }],
        actor.id,
      );
    }
    await tx.salesOrderItem.update({ where: { id: item.id }, data: next });
    const totals = await this.refreshTotals(tx, orderId);
    await this.audit.write(tx, {
      actorId: actor.id,
      action: 'sales.order.item-paper-amounts',
      entity: 'sales_orders',
      entityId: orderId,
      before: {
        code: salesOrderCode(order.seq),
        lineNumber: item.lineNumber,
        subtotalPen: item.subtotalPen.toFixed(4),
        igvPen: item.igvPen.toFixed(4),
        totalPen: item.totalPen.toFixed(4),
      },
      after: { ...next, orderTotalPen: totals.totalPen },
      reason,
    });
  }

  // -------------------------------------------------------------------------
  // D-254 (R1): atar una línea a una bobina del pool
  // -------------------------------------------------------------------------

  /**
   * Ata la línea a una bobina concreta del pool de su SKU de bobina. La cantidad y el importe no
   * cambian —los manda el papel (D-255)—; lo que cambia es qué bobina se promete y, si la línea
   * estaba enganchada a un `BOB…` suelto (COT-000002), el producto pasa al de venta canónico.
   *
   * Solo se ofrece una bobina que el pool acepta para esta línea: mismo espesor exacto y mismo
   * color comercial o tipo, libre y con saldo ≥ la cantidad (D-254). La reserva propia del pedido
   * no le quita candidatas.
   */
  async updateItemCoil(
    actor: RequestUser,
    orderId: string,
    itemId: string,
    input: UpdateSalesOrderItemCoilInput,
  ): Promise<SalesOrderDto> {
    await this.prisma.$transaction(
      (tx) => this.updateItemCoilInTx(tx, actor, orderId, itemId, input),
      { timeout: 30_000 },
    );
    return this.orders.findOne(orderId);
  }

  /**
   * Lo mismo dentro de la transacción del llamador. La doble promesa de una bobina entre dos
   * pedidos simultáneos la corta `createReservations`, que bloquea la bobina y comprueba su
   * disponible: el chequeo del pool de acá es para rechazar temprano con un mensaje claro.
   */
  async updateItemCoilInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    orderId: string,
    itemId: string,
    input: UpdateSalesOrderItemCoilInput,
  ): Promise<void> {
    const order = await this.lockEditable(tx, orderId, 'cambiar la bobina');
    this.assertOwner(actor, order, 'cambiarle la bobina');
    const item = await this.requireItem(tx, orderId, itemId);
    const at = `Línea ${item.lineNumber}`;
    const dispatched = await tx.dispatchItem.findFirst({
      where: { salesOrderItemId: item.id, dispatch: { status: DispatchStatus.ISSUED } },
      select: { id: true },
    });
    if (dispatched) {
      throw new BadRequestException(`${at}: ya tiene despachos, así que su bobina no se cambia`);
    }
    const pool = await lineCoilPool(tx, item);
    if (pool === null) {
      throw new BadRequestException(
        `${at}: ${item.product.sku} no es una venta de bobina, así que no se ata a una bobina`,
      );
    }
    const qty = toFixedString(item.qty.toString(), 'KG');
    const candidates = await coilPoolFor(tx, pool, qty, { exceptSalesOrderIds: [orderId] });
    if (!candidates.candidates.some((c) => c.coilId === input.saleCoilId)) {
      throw new BadRequestException(
        `${at}: esa bobina no está en el pool de ${pool.sku} con ${qty} kg libres (espesor exacto, mismo color o tipo, sin reserva ni OP)`,
      );
    }
    const coil = await tx.coil.findUniqueOrThrow({
      where: { id: input.saleCoilId },
      select: { id: true, code: true, ...COIL_SALE_IDENTITY_SELECT },
    });
    const product = (await findCoilSaleProducts(tx, [coil])).get(coilSaleSkus(coil).canonical);
    if (!product) {
      throw new NotFoundException(`${coil.code}: no existe el producto de venta de la bobina`);
    }

    // cc30: las reservas de la línea por la puerta, detrás del pedido (ya tomado).
    const lineReservations = await tx.reservation.findMany({
      where: { salesOrderItemId: item.id },
      select: { id: true },
    });
    await lockDocuments(tx, { reservations: lineReservations.map((r) => r.id) });
    await tx.reservation.updateMany({
      where: { salesOrderItemId: item.id, status: ReservationStatus.ACTIVE },
      data: {
        qty: '0',
        shortfallQty: '0', // D-341: al liberar, lo que faltaba reservar se cierra con ella.
        status: ReservationStatus.RELEASED,
        releasedAt: new Date(),
        releasedById: actor.id,
      },
    });
    const updated = await tx.salesOrderItem.update({
      where: { id: item.id },
      data: {
        productId: product.id,
        unit: Unit.KGM,
        reserveItemType: InventoryItemType.COIL,
        reserveItemId: coil.id,
        reserveQty: qty,
        reserveUnit: Unit.KGM,
      },
    });
    await this.orders.createReservations(tx, actor, orderId, [updated]);

    await this.audit.write(tx, {
      actorId: actor.id,
      action: 'sales.order.item-coil',
      entity: 'sales_orders',
      entityId: orderId,
      before: {
        code: salesOrderCode(order.seq),
        lineNumber: item.lineNumber,
        productSku: item.product.sku,
        reserveItemType: item.reserveItemType,
        reserveItemId: item.reserveItemId,
      },
      after: {
        productSku: product.sku,
        coilCode: coil.code,
        reserveQty: qty,
        reason: input.reason,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Cliente (razón social) del pedido (solo ADMINISTRADOR)
  // -------------------------------------------------------------------------

  async changeCustomer(
    actor: RequestUser,
    orderId: string,
    input: ChangeSalesOrderCustomerInput,
  ): Promise<SalesOrderDto> {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockEditable(tx, orderId, 'cambiar el cliente');
      const current = await tx.salesOrder.findUniqueOrThrow({
        where: { id: orderId },
        select: { customer: { select: { id: true, name: true, docNumber: true } } },
      });
      if (current.customer.id === input.customerId) return;
      const customer = await tx.customer.findUnique({
        where: { id: input.customerId },
        select: { id: true, name: true, docNumber: true, isActive: true },
      });
      if (!customer) throw new NotFoundException('Cliente no encontrado');
      if (!customer.isActive) {
        throw new BadRequestException(`El cliente ${customer.name} está desactivado`);
      }
      await tx.salesOrder.update({ where: { id: orderId }, data: { customerId: customer.id } });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.order.customer',
        entity: 'sales_orders',
        entityId: orderId,
        before: {
          code: salesOrderCode(order.seq),
          customerId: current.customer.id,
          customer: `${current.customer.docNumber} ${current.customer.name}`,
        },
        after: {
          customerId: customer.id,
          customer: `${customer.docNumber} ${customer.name}`,
          reason: input.reason,
        },
      });
    });
    return this.orders.findOne(orderId);
  }

  // -------------------------------------------------------------------------
  // Agregar ítems a un pedido confirmado
  // -------------------------------------------------------------------------

  async addItems(
    actor: RequestUser,
    orderId: string,
    input: AddSalesOrderItemsInput,
  ): Promise<SalesOrderDto> {
    await this.prisma.$transaction(
      async (tx) => {
        const order = await this.lockEditable(tx, orderId, 'agregar ítems');
        this.assertOwner(actor, order, 'agregarle ítems');
        // F8-S1/M2: agregar es una creación repetible. El mismo envío (doble clic, reintento de
        // red) no agrega dos veces; el lock del pedido de arriba serializa los reintentos.
        const claim = await claimIdempotencyKey(tx, 'sales-order-add-items', input.idempotencyKey);
        if (!claim.claimed) return;

        const existing = await tx.salesOrderItem.aggregate({
          where: { salesOrderId: orderId },
          _max: { lineNumber: true },
          _count: true,
        });
        if (existing._count + input.items.length > MAX_SALES_ITEMS) {
          throw new BadRequestException(
            `El pedido tiene ${existing._count} líneas: con ${input.items.length} más pasaría del máximo de ${MAX_SALES_ITEMS}`,
          );
        }
        const lines = await resolveSalesLines(tx, input.items, {
          priceFloor: { toleranceMm: roofingToleranceMm(this.env) },
          firstLineNumber: (existing._max.lineNumber ?? 0) + 1,
          // D-320: una bobina entera atada a una cotización abierta no se agrega a un pedido por
          // el lado (la misma regla que el alta de cotización, D-310).
          coilTies: { viewer: actor },
        });

        const created = [];
        for (const l of lines) {
          created.push(
            await tx.salesOrderItem.create({
              data: {
                salesOrderId: orderId,
                lineNumber: l.lineNumber,
                productId: l.productId,
                description: l.description,
                qty: l.qty,
                unit: l.unit,
                listPricePen: l.listPricePen,
                unitPricePen: l.unitPricePen,
                valuePerMeterPen: l.valuePerMeterPen,
                piecesHint: l.piecesHint,
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
              },
            }),
          );
        }

        await this.orders.createReservations(tx, actor, orderId, created);
        const productionOrders = await this.createProductionOrders(
          tx,
          actor,
          created.map((c) => c.id),
        );

        // Un pedido ya despachado entero vuelve a tener algo pendiente si lo que se agregó se
        // despacha (D-167: un servicio no espera despacho y no lo reabre).
        if (order.status === SalesOrderStatus.FULFILLED) {
          const businessLines = await tx.product.findMany({
            where: { id: { in: lines.map((l) => l.productId) } },
            select: { businessLine: { select: { inventoryStrategy: true } } },
          });
          if (businessLines.some((p) => carriesInventory(p.businessLine))) {
            await tx.salesOrder.update({
              where: { id: orderId },
              data: { status: SalesOrderStatus.PARTIALLY_FULFILLED },
            });
          }
        }
        const totals = await this.refreshTotals(tx, orderId);

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'sales.order.add-items',
          entity: 'sales_orders',
          entityId: orderId,
          after: {
            code: salesOrderCode(order.seq),
            lines: lines.map((l) => ({ lineNumber: l.lineNumber, sku: l.productSku, qty: l.qty })),
            productionOrders,
            totalPen: totals.totalPen,
          },
        });
      },
      // Mismo presupuesto que confirmar (D-186): un lock por línea y una OP por línea a fabricar.
      { timeout: 60_000, maxWait: 15_000 },
    );
    return this.orders.findOne(orderId);
  }

  // -------------------------------------------------------------------------
  // Cantidad de una línea confirmada (D-187; con producción o despachos, D-603/D-604)
  // -------------------------------------------------------------------------

  /**
   * Cambia la cantidad (y, en una línea a medida, sus largos) de una línea confirmada.
   *
   * **Sin producción registrada ni despachos** sigue siendo D-187: dueño o ADMINISTRADOR; libera
   * la reserva de la línea y reserva la cantidad nueva por la puerta de siempre, y la OP viva pasa
   * a colgar de la reserva nueva con el plan de corte por defecto (D-084).
   *
   * **Con producción registrada o despachos** (cc45, D-603/D-604): solo ADMINISTRADOR, con
   * motivo y antes del comprobante. Nunca por debajo de lo registrado (por largo en una línea a
   * medida) ni de lo despachado. La reserva queda en lo que falta fabricar (o despachar): bajar
   * libera, subir reserva lo nuevo por la puerta de confirmar y, si no alcanza, el administrador
   * confirma con faltante (D-341). El plan de la OP viva sigue a la cantidad nueva; con la OP
   * cerrada, al subir nace una OP nueva por la diferencia. Todo en esta transacción, con el orden
   * de bloqueos de D-471: pedido → OP → reserva → bobinas → saldos.
   */
  async updateItemQty(
    actor: RequestUser,
    orderId: string,
    itemId: string,
    input: UpdateSalesOrderItemQtyInput,
  ): Promise<SalesOrderDto> {
    await this.prisma.$transaction(
      (tx) => this.changeItemQtyInTx(tx, actor, orderId, itemId, input, false),
      // Como agregar ítems: puede reservar y crear una OP.
      { timeout: 60_000, maxWait: 15_000 },
    );
    return this.orders.findOne(orderId);
  }

  /**
   * cc45 (D-603): lo que el diálogo necesita para abrirse —lo pedido, lo registrado y lo
   * despachado de la línea, sus órdenes— y, con una cantidad, lo que `updateItemQty` haría. Corre
   * el mismo servicio, bajo los mismos locks, y deshace siempre: la pantalla no puede prometer
   * algo distinto de lo que el guardado hace. Un rechazo viaja como `outcome.message`.
   */
  async previewItemQty(
    actor: RequestUser,
    orderId: string,
    itemId: string,
    input: SalesOrderItemQtyPreviewInput,
  ): Promise<SalesOrderItemQtyPreviewDto> {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const context = await this.qtyContextInTx(tx, actor, orderId, itemId);
          let outcome: SalesOrderItemQtyOutcomeDto | null = null;
          if (context.blocked === null && input.qty !== undefined) {
            try {
              const result = await this.changeItemQtyInTx(
                tx,
                actor,
                orderId,
                itemId,
                {
                  qty: input.qty,
                  ...(input.pieces !== undefined ? { pieces: input.pieces } : {}),
                  confirmShortfall: true,
                },
                true,
              );
              outcome = { ok: true, message: null, ...result };
            } catch (error) {
              if (!(error instanceof HttpException) || error.getStatus() >= 500) throw error;
              outcome = {
                ok: false,
                message: httpMessage(error),
                qty: null,
                meters: null,
                pieces: null,
                totalPen: null,
                orderTotalPen: null,
                effects: [],
                shortfallQty: null,
              };
            }
          }
          throw new QtyPreviewRollback({ ...context, outcome });
        },
        { timeout: 60_000, maxWait: 15_000 },
      );
    } catch (error) {
      if (error instanceof QtyPreviewRollback) return error.result;
      throw error;
    }
    throw new Error('La vista previa de la cantidad no devolvió resultado');
  }

  /** El contexto de la línea para el diálogo, sin cambiar nada (bajo los locks de la acción). */
  private async qtyContextInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    orderId: string,
    itemId: string,
  ): Promise<Omit<SalesOrderItemQtyPreviewDto, 'outcome'>> {
    let blocked: string | null = null;
    try {
      const order = await this.lockEditable(tx, orderId, 'cambiar cantidades');
      this.assertOwner(actor, order, 'cambiarle cantidades');
    } catch (error) {
      if (!(error instanceof BadRequestException)) throw error;
      blocked = httpMessage(error);
    }
    const item = await this.requireItem(tx, orderId, itemId);
    if (blocked === null && item.reserveItemType === InventoryItemType.COIL) {
      blocked = 'La venta de una bobina entera vende su saldo completo; la cantidad no se edita';
    }
    const facts = await this.readQtyFacts(tx, item);
    const adminOnly = facts.hasProduction || facts.hasDispatches;
    if (blocked === null && adminOnly && actor.role !== Role.ADMINISTRADOR) {
      blocked =
        'La línea ya tiene producción registrada o despachos: solo un administrador cambia su cantidad';
    }
    const order = await tx.salesOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { totalPen: true },
    });
    const minQty = Decimal.max(facts.registeredQty, facts.dispatchedQty);
    return {
      itemId: item.id,
      lineNumber: item.lineNumber,
      productSku: item.product.sku,
      kind: facts.kind,
      unit: item.unit,
      qty: item.qty.toFixed(3),
      meters: lineMeters(facts.kind, item),
      pieces: linePieces(facts.kind, item),
      totalPen: item.totalPen.toFixed(2),
      orderTotalPen: order.totalPen.toFixed(2),
      rows:
        facts.kind === 'PIECES'
          ? lengthRows(item.pieces.map(toPieceLike), facts.registeredPieces)
          : [],
      registeredQty: facts.registeredQty.toFixed(3),
      dispatchedQty: facts.dispatchedQty.toFixed(3),
      minQty: minQty.toFixed(3),
      hasProduction: facts.hasProduction,
      hasDispatches: facts.hasDispatches,
      adminOnly,
      blocked,
      productionOrders: facts.orders.map((o) => ({
        id: o.id,
        code: productionOrderCode(o.seq),
        status: o.status,
        planMeters: o.planMeters.toFixed(3),
        registeredMeters: o.registeredMeters.toFixed(3),
      })),
    };
  }

  /** La acción y su vista previa: el mismo camino. `preview` solo relaja el motivo. */
  private async changeItemQtyInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    orderId: string,
    itemId: string,
    input: UpdateSalesOrderItemQtyInput,
    preview: boolean,
  ): Promise<QtyOutcome> {
    const order = await this.lockEditable(tx, orderId, 'cambiar cantidades');
    this.assertOwner(actor, order, 'cambiarle cantidades');
    const item = await this.requireItem(tx, orderId, itemId);
    const at = `Línea ${item.lineNumber}`;
    if (item.reserveItemType === InventoryItemType.COIL) {
      throw new BadRequestException(
        `${at}: la venta de una bobina entera vende su saldo completo; la cantidad no se edita`,
      );
    }
    // cc30 (grupo C, cruce c): las OP de la línea y sus reservas, juntas, detrás del pedido y
    // antes del inventario.
    const facts = await this.readQtyFacts(tx, item);
    const orderTotalBefore = (
      await tx.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { totalPen: true } })
    ).totalPen;
    return facts.hasProduction || facts.hasDispatches
      ? this.resizeStartedInTx(tx, actor, order, item, facts, input, preview, orderTotalBefore)
      : this.resizeUnstartedInTx(tx, actor, order, item, facts, input, preview, orderTotalBefore);
  }

  /**
   * Lo que la línea tiene hoy, leído **después** de bloquear sus OP y sus reservas: lo registrado
   * por todas sus órdenes no anuladas (vivas y cerradas, D-603: el piso es la suma) y lo
   * despachado.
   */
  private async readQtyFacts(tx: Prisma.TransactionClient, item: QtyItem): Promise<QtyFacts> {
    const linked = await tx.reservation.findMany({
      where: { salesOrderItemId: item.id },
      select: { id: true, productionOrders: { select: { id: true } } },
    });
    await lockDocuments(tx, {
      productionOrders: linked.flatMap((r) => r.productionOrders.map((o) => o.id)),
      reservations: linked.map((r) => r.id),
    });
    const reservations = await tx.reservation.findMany({
      where: { salesOrderItemId: item.id },
      select: {
        id: true,
        status: true,
        itemType: true,
        itemId: true,
        qty: true,
        shortfallQty: true,
        productionOrders: {
          where: { status: { not: ProductionOrderStatus.CANCELLED } },
          select: {
            id: true,
            seq: true,
            kind: true,
            status: true,
            reservationId: true,
            items: { select: { lengthMm: true, qty: true } },
            reports: {
              where: { status: ProductionReportStatus.ACTIVE },
              select: { metersM: true, piecesDetail: { select: { lengthMm: true, qty: true } } },
            },
          },
          orderBy: { seq: 'asc' },
        },
      },
    });
    const dispatched = await tx.dispatchItem.aggregate({
      where: { salesOrderItemId: item.id, dispatch: { status: DispatchStatus.ISSUED } },
      _sum: { qty: true },
    });
    const rawOrders = reservations.flatMap((r) => r.productionOrders);
    const produced =
      rawOrders.length > 0 || item.reserveItemType === InventoryItemType.RAW_MATERIAL;
    const kind = qtyKindOf(
      {
        unit: item.unit,
        roofingKind: item.product.roofingKind,
        lengthMm: item.product.lengthMm === null ? null : item.product.lengthMm.toFixed(2),
      },
      produced,
    );
    const lineQty = toDecimal(item.qty.toString());
    const live = (o: { status: ProductionOrderStatus }) =>
      o.status === ProductionOrderStatus.DRAFT || o.status === ProductionOrderStatus.IN_PROGRESS;
    const registeredMetersOf = (o: (typeof rawOrders)[number]) =>
      sumReportedMeters(o.reports) ?? new Decimal(0);
    const piecesOf = (orders: readonly (typeof rawOrders)[number][]): PieceLike[] =>
      orders.flatMap((o) => o.reports.flatMap((r) => r.piecesDetail.map(toPieceLike)));
    const qtyOf = (orders: readonly (typeof rawOrders)[number][]): Decimal => {
      if (kind === 'UNITS') return new Decimal(piecesCount(piecesOf(orders)));
      if (kind === 'PIECES' || kind === 'METERS') {
        return orders.reduce((acc, o) => acc.plus(registeredMetersOf(o)), new Decimal(0));
      }
      return new Decimal(0);
    };
    const closedOrders = rawOrders.filter((o) => !live(o));
    const registeredQty = qtyOf(rawOrders);
    const registeredClosedQty = qtyOf(closedOrders);
    const dispatchedQty = toDecimal((dispatched._sum.qty ?? 0).toString());
    return {
      kind,
      reservations: reservations.map((r) => ({
        id: r.id,
        status: r.status,
        itemType: r.itemType,
        itemId: r.itemId,
        qty: toDecimal(r.qty.toString()),
        shortfallQty: toDecimal(r.shortfallQty.toString()),
      })),
      orders: rawOrders.map((o) => {
        const registeredMeters = registeredMetersOf(o);
        return {
          id: o.id,
          seq: o.seq,
          status: o.status,
          reservationId: o.reservationId,
          live: live(o),
          planPieces: o.items.map(toPieceLike),
          planMeters:
            kind === 'METERS'
              ? // D-605: los metros de la línea menos lo que registraron las otras órdenes; una
                // cerrada, no más de lo que fabricó (`accessoryPlans`).
                Decimal.min(
                  Decimal.max(lineQty.minus(registeredQty.minus(registeredMeters)), 0),
                  live(o) ? lineQty : registeredMeters,
                )
              : piecesMeters(o.items.map(toPieceLike)),
          registeredMeters,
        };
      }),
      registeredPieces: kind === 'METERS' ? [] : piecesOf(rawOrders),
      registeredClosedPieces: kind === 'METERS' ? [] : piecesOf(closedOrders),
      registeredQty,
      registeredClosedQty,
      dispatchedQty,
      // Cualquier parte vigente cuenta, aunque no deje metros ni planchas (revisión cc45).
      hasProduction:
        registeredQty.gt(0) ||
        closedOrders.length > 0 ||
        rawOrders.some((o) => o.reports.length > 0),
      hasDispatches: dispatchedQty.gt(0),
      drywallOrders: rawOrders
        .filter((o) => o.kind === ProductionOrderKind.DRYWALL)
        .map((o) => productionOrderCode(o.seq)),
    };
  }

  /** D-187: la línea todavía no produjo ni despachó nada. Se reescribe entera, como siempre. */
  private async resizeUnstartedInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    order: LockedOrder,
    item: QtyItem,
    facts: QtyFacts,
    input: UpdateSalesOrderItemQtyInput,
    preview: boolean,
    orderTotalBefore: Prisma.Decimal,
  ): Promise<QtyOutcome> {
    const at = `Línea ${item.lineNumber}`;
    const addInstead = 'Agrega un ítem nuevo con la diferencia.';
    // D-088: producir traslada la promesa a una reserva del producto fabricado. Si la línea
    // tiene una reserva viva de otro tipo que el suyo, ya hay producción detrás.
    if (
      facts.reservations.some(
        (r) => r.status === ReservationStatus.ACTIVE && r.itemType !== item.reserveItemType,
      )
    ) {
      throw new BadRequestException(
        `${at}: ya tiene material fabricado reservado, así que la cantidad no se cambia. ${addInstead}`,
      );
    }
    // D-341: cambiar la cantidad libera y vuelve a reservar la línea completa, y eso borraría en
    // silencio el faltante que el administrador aceptó al confirmar. Se rechaza, también con la
    // reserva ya consumida: completar la reserva la admite (y la revive).
    if (
      facts.reservations.some(
        (r) => r.status !== ReservationStatus.RELEASED && r.shortfallQty.greaterThan(0),
      )
    ) {
      throw new BadRequestException(
        `${at}: Esta línea tiene faltante de material: completá la reserva o anulá antes de cambiar la cantidad`,
      );
    }
    if (facts.reservations.some((r) => r.status === ReservationStatus.CONSUMED)) {
      throw new BadRequestException(
        `${at}: su material ya se consumió en producción, así que la cantidad no se cambia. ${addInstead}`,
      );
    }

    const [line] = await resolveSalesLines(
      tx,
      [this.lineInput(item, { qty: input.qty, pieces: input.pieces })],
      // Sin piso: el precio no cambia y ya pasó el piso cuando se fijó. Cambiar una
      // cantidad no es la ocasión de rechazar un precio que nadie tocó.
      // D-256 (aclaración): salvo en un pedido **importado**, cuyo precio nunca pasó por el
      // piso. Cambiarle la cantidad deja de representar al comprobante, y fuera del
      // ADMINISTRADOR eso pasa por el piso como cualquier línea.
      {
        firstLineNumber: item.lineNumber,
        ...(order.imported && actor.role !== Role.ADMINISTRADOR
          ? { priceFloor: { toleranceMm: roofingToleranceMm(this.env) } }
          : {}),
      },
    );
    if (!line) throw new NotFoundException(`${at}: no se pudo recalcular`);

    const active = facts.reservations.filter((r) => r.status === ReservationStatus.ACTIVE);
    const reservedBefore = active.reduce((acc, r) => acc.plus(r.qty), new Decimal(0));
    if (active.length > 0) {
      await tx.reservation.updateMany({
        where: { id: { in: active.map((r) => r.id) }, status: ReservationStatus.ACTIVE },
        data: {
          qty: '0',
          shortfallQty: '0', // D-341: ídem.
          status: ReservationStatus.RELEASED,
          releasedAt: new Date(),
          releasedById: actor.id,
        },
      });
    }

    await tx.salesOrderItemPiece.deleteMany({ where: { salesOrderItemId: item.id } });
    const updated = await tx.salesOrderItem.update({
      where: { id: item.id },
      data: {
        description: line.description,
        qty: line.qty,
        subtotalPen: line.subtotalPen,
        igvPen: line.igvPen,
        totalPen: line.totalPen,
        reserveItemType: line.reserveItemType,
        reserveItemId: line.reserveItemId,
        reserveQty: line.reserveQty,
        reserveUnit: line.reserveUnit,
        ...(line.pieces.length > 0
          ? {
              pieces: {
                create: line.pieces.map((p) => ({
                  lineNumber: p.lineNumber,
                  lengthMm: p.lengthMm,
                  qty: p.qty,
                })),
              },
            }
          : {}),
      },
    });
    // D-341 (cc45): el administrador también puede subir sin material, con faltante y motivo.
    const shortfalls: ShortfallLine[] = [];
    const allowShortfall =
      actor.role === Role.ADMINISTRADOR && (preview || input.confirmShortfall === true);
    await this.orders.createReservations(tx, actor, order.id, [updated], {
      allowShortfall,
      shortfalls,
    });

    // La OP viva sigue siendo la misma orden —puede tener la bobina montada, y montar es
    // decisión de planta (D-086)—; lo que cambia es la promesa de la que cuelga y el plan.
    const newReservation = await tx.reservation.findFirst({
      where: {
        salesOrderItemId: item.id,
        status: ReservationStatus.ACTIVE,
        itemType: InventoryItemType.RAW_MATERIAL,
      },
      select: { id: true },
    });
    const plan =
      newReservation !== null
        ? derivePiecesPlan(
            line.pieces.map((p) => ({ lengthMm: p.lengthMm, qty: p.qty })),
            item.product.lengthMm === null ? null : item.product.lengthMm.toFixed(2),
            line.qty,
          )
        : [];
    const effects: string[] = [];
    const adjustedOrders: string[] = [];
    for (const op of facts.orders) {
      // Si el catálogo movió la especificación, la reserva nueva es otra fila: una OP en curso
      // tiene una bobina montada elegida para la especificación vieja y no se reasigna sola.
      if (
        newReservation &&
        op.status === ProductionOrderStatus.IN_PROGRESS &&
        op.reservationId !== newReservation.id
      ) {
        throw new BadRequestException(
          `${at}: la materia prima de la línea cambió en el catálogo y la orden ${productionOrderCode(op.seq)} ya tiene bobina montada: libera la bobina antes de cambiar la cantidad`,
        );
      }
      if (!newReservation) {
        // La línea dejó de fabricarse (el catálogo cambió entre confirmar y hoy): la OP no
        // tiene de qué colgar. Que planta la anule a mano con su motivo.
        throw new BadRequestException(
          `${at}: ya no reserva materia prima y la orden ${productionOrderCode(op.seq)} depende de ella: anula la orden antes de cambiar la cantidad`,
        );
      }
      await tx.productionOrder.update({
        where: { id: op.id },
        data: { reservationId: newReservation.id },
      });
      await tx.productionOrderItem.deleteMany({ where: { productionOrderId: op.id } });
      await tx.productionOrderItem.createMany({
        data: plan.map((p) => ({ productionOrderId: op.id, ...p })),
      });
      adjustedOrders.push(productionOrderCode(op.seq));
      const planMetersAfter = facts.kind === 'METERS' ? toDecimal(line.qty) : piecesMeters(plan);
      effects.push(
        facts.kind === 'METERS'
          ? `El plan de ${productionOrderCode(op.seq)} pasa a ${planMetersAfter.toFixed(3)} m.`
          : `El plan de ${productionOrderCode(op.seq)} pasa de ${op.planMeters.toFixed(3)} m a ${planMetersAfter.toFixed(3)} m.`,
      );
      await this.auditOrderPlan(tx, actor, order, item, op, planMetersAfter, input.reason);
    }

    const reservedAfter = await tx.reservation.aggregate({
      where: { salesOrderItemId: item.id, status: ReservationStatus.ACTIVE },
      _sum: { qty: true },
    });
    const unit = unitSymbol(line.reserveUnit);
    const reservedNow = toDecimal((reservedAfter._sum.qty ?? 0).toString());
    if (!reservedNow.equals(reservedBefore)) {
      effects.push(
        `La reserva de material de la línea pasa de ${reservedBefore.toFixed(3)} ${unit} a ${reservedNow.toFixed(3)} ${unit}.`,
      );
    }
    const missing = shortfalls.reduce((acc, s) => acc.plus(s.missingQty), new Decimal(0));
    if (missing.gt(0)) {
      effects.push(
        `Faltan ${missing.toFixed(3)} ${unit} de material: se confirma con faltante y motivo (D-341).`,
      );
    }

    const totals = await this.refreshTotals(tx, order.id);
    await this.audit.write(tx, {
      actorId: actor.id,
      action: 'sales.order.item-qty',
      entity: 'sales_orders',
      entityId: order.id,
      before: {
        code: salesOrderCode(order.seq),
        lineNumber: item.lineNumber,
        qty: item.qty.toString(),
        reserveQty: item.reserveQty.toString(),
      },
      after: {
        qty: line.qty,
        reserveQty: line.reserveQty,
        productionOrders: adjustedOrders,
        totalPen: totals.totalPen,
        ...(missing.gt(0) ? { shortfallQty: missing.toFixed(3) } : {}),
      },
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    return this.outcome(
      item,
      facts.kind,
      line,
      totals.totalPen,
      orderTotalBefore,
      effects,
      missing,
    );
  }

  /** D-603/D-604: la línea ya tiene producción registrada o despachos. */
  private async resizeStartedInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    order: LockedOrder,
    item: QtyItem,
    facts: QtyFacts,
    input: UpdateSalesOrderItemQtyInput,
    preview: boolean,
    orderTotalBefore: Prisma.Decimal,
  ): Promise<QtyOutcome> {
    const at = `Línea ${item.lineNumber}`;
    // Autorrevisión cc45 (P1-1): una OP de perfiles atada a la línea (anterior a D-599) consume la
    // reserva de otra forma (D-048) y no deja metros ni planchas: este camino no la sabe medir.
    if (facts.drywallOrders.length > 0) {
      throw new BadRequestException(
        `${at}: tiene la orden de perfiles ${facts.drywallOrders.join(', ')}, así que su cantidad no se cambia desde acá`,
      );
    }
    if (actor.role !== Role.ADMINISTRADOR) {
      throw new ForbiddenException(
        `${at}: ya tiene producción registrada o despachos, así que solo un administrador cambia su cantidad`,
      );
    }
    if (!preview && input.reason === undefined) {
      throw new BadRequestException(
        `${at}: el motivo es obligatorio para cambiar la cantidad de una línea con producción o despachos`,
      );
    }
    // El precio no cambia (D-603): no pasa por el piso de D-163. Solo un administrador llega acá.
    const [line] = await resolveSalesLines(
      tx,
      [this.lineInput(item, { qty: input.qty, pieces: input.pieces })],
      { firstLineNumber: item.lineNumber },
    );
    if (!line) throw new NotFoundException(`${at}: no se pudo recalcular`);
    if (
      line.reserveItemType !== item.reserveItemType ||
      line.reserveItemId !== item.reserveItemId
    ) {
      throw new BadRequestException(
        `${at}: el material que reserva la línea cambió en el catálogo desde que se confirmó, así que su cantidad no se cambia desde acá`,
      );
    }
    const nextQty = toDecimal(line.qty);
    const nextPieces: PieceLike[] = line.pieces.map((p) => ({
      lengthMm: toDecimal(p.lengthMm).toFixed(2),
      qty: p.qty,
    }));
    const violation = qtyFloorViolation({
      kind: facts.kind,
      unitLabel: unitSymbol(item.unit),
      qty: nextQty,
      pieces: nextPieces,
      registeredPieces: facts.registeredPieces,
      registeredQty: facts.registeredQty,
      dispatchedQty: facts.dispatchedQty,
    });
    if (violation !== null) throw new BadRequestException(`${at}: ${violation}`);
    if (
      nextQty.equals(item.qty.toString()) &&
      samePieces(nextPieces, item.pieces.map(toPieceLike))
    ) {
      throw new BadRequestException(`${at}: la cantidad nueva es la misma de ahora`);
    }

    const effects: string[] = [];
    // D-604: la reserva queda en lo que falta fabricar —o despachar, en una línea que sale de
    // stock—: lo nuevo menos lo ya hecho, en la proporción de la promesa de la línea entera.
    const done = facts.kind === 'QTY' ? facts.dispatchedQty : facts.registeredQty;
    // Segundo modelo cc45 (P2-1): con todas las órdenes cerradas, solo subir pide material (y una
    // OP nueva). Bajar una línea que una OP cerró corta (antes de D-573) no reabre producción.
    const rising = nextQty.gt(item.qty.toString());
    const allClosed = facts.orders.length > 0 && !facts.orders.some((o) => o.live);
    const pending =
      allClosed && !rising ? new Decimal(0) : Decimal.max(nextQty.minus(done), new Decimal(0));
    const target = toDecimal(
      toFixedString(toDecimal(line.reserveQty).times(pending).div(nextQty), 'KG'),
    );
    const row = facts.reservations.find(
      (r) => r.itemType === item.reserveItemType && r.itemId === item.reserveItemId,
    );
    const current = row?.status === ReservationStatus.ACTIVE ? row.qty : new Decimal(0);
    const currentShortfall =
      row && row.status !== ReservationStatus.RELEASED ? row.shortfallQty : new Decimal(0);
    const promised = current.plus(currentShortfall);
    const unit = unitSymbol(line.reserveUnit);
    const label = await this.reserveLabel(tx, item);
    let shortfall = new Decimal(0);
    let reservationId = row?.id ?? null;
    let released = new Decimal(0);
    let reserved = new Decimal(0);
    if (row && target.lt(promised)) {
      const split = releaseSplit({
        delta: target.minus(promised),
        qty: current,
        shortfall: currentShortfall,
      });
      released = split.released;
      const emptied = split.qty.lte(0) && split.shortfall.lte(0);
      await tx.reservation.update({
        where: { id: row.id },
        // Autorrevisión cc45 (P1-1): de una fila que no está activa solo baja el faltante; su
        // `qty` es la cifra que una reversa necesita.
        data:
          row.status !== ReservationStatus.ACTIVE
            ? { shortfallQty: split.shortfall.toFixed(3) }
            : emptied
              ? {
                  qty: '0',
                  shortfallQty: '0',
                  status: ReservationStatus.RELEASED,
                  releasedAt: new Date(),
                  releasedById: actor.id,
                }
              : { qty: split.qty.toFixed(3), shortfallQty: split.shortfall.toFixed(3) },
      });
      if (released.gt(0)) {
        effects.push(
          rising
            ? `La reserva de ${label} se ajusta a lo que falta fabricar: se liberan ${released.toFixed(3)} ${unit} (lo consumido fue menos que lo teórico).`
            : `Se libera ${released.toFixed(3)} ${unit} de ${label}: lo que ya no se ${facts.kind === 'QTY' ? 'despacha' : 'produce'}.`,
        );
      }
    } else if (target.gt(promised)) {
      const result = await this.orders.reserveExtra(
        tx,
        actor,
        order.id,
        {
          id: item.id,
          lineNumber: item.lineNumber,
          productId: item.productId,
          reserveItemType: line.reserveItemType,
          reserveItemId: line.reserveItemId,
          reserveQty: line.reserveQty,
          reserveUnit: line.reserveUnit,
        },
        target.minus(promised).toFixed(3),
        { allowShortfall: preview || input.confirmShortfall === true },
      );
      reserved = result.reserved;
      shortfall = result.shortfall;
      reservationId =
        reservationId ??
        (
          await tx.reservation.findUnique({
            where: {
              salesOrderItemId_itemType_itemId: {
                salesOrderItemId: item.id,
                itemType: line.reserveItemType,
                itemId: line.reserveItemId,
              },
            },
            select: { id: true },
          })
        )?.id ??
        null;
      if (reserved.gt(0) || shortfall.gt(0))
        effects.push(
          shortfall.gt(0)
            ? `Se reserva ${reserved.toFixed(3)} ${unit} más de ${label} y faltan ${shortfall.toFixed(3)} ${unit}: se confirma con faltante y motivo (D-341).`
            : `Se reserva ${reserved.toFixed(3)} ${unit} más de ${label}: hay disponible.`,
        );
      if (
        reserved.gt(0) &&
        shortfall.lte(0) &&
        line.reserveItemType === InventoryItemType.RAW_MATERIAL
      ) {
        effects.push(
          'Si no hubiera material suficiente, se confirma con faltante y motivo (D-341).',
        );
      }
    }

    const orderEffects = await this.followPlan(
      tx,
      actor,
      item,
      facts,
      nextQty,
      nextPieces,
      reservationId,
      rising,
      preview,
      order,
      input.reason,
    );
    effects.unshift(...orderEffects.effects);

    await tx.salesOrderItemPiece.deleteMany({ where: { salesOrderItemId: item.id } });
    await tx.salesOrderItem.update({
      where: { id: item.id },
      data: {
        description: line.description,
        qty: line.qty,
        subtotalPen: line.subtotalPen,
        igvPen: line.igvPen,
        totalPen: line.totalPen,
        reserveQty: line.reserveQty,
        ...(line.pieces.length > 0
          ? {
              pieces: {
                create: line.pieces.map((p) => ({
                  lineNumber: p.lineNumber,
                  lengthMm: p.lengthMm,
                  qty: p.qty,
                })),
              },
            }
          : {}),
      },
    });
    const totals = await this.refreshTotals(tx, order.id);
    await this.refreshFulfillment(tx, order.id);

    await this.audit.write(tx, {
      actorId: actor.id,
      action: 'sales.order.item-qty',
      entity: 'sales_orders',
      entityId: order.id,
      before: {
        code: salesOrderCode(order.seq),
        lineNumber: item.lineNumber,
        qty: item.qty.toString(),
        pieces: describePieces(item.pieces.map(toPieceLike)),
        totalPen: item.totalPen.toFixed(4),
        orderTotalPen: orderTotalBefore.toFixed(2),
        reserveQty: item.reserveQty.toString(),
        reservation: { qty: current.toFixed(3), shortfallQty: currentShortfall.toFixed(3) },
      },
      after: {
        qty: line.qty,
        pieces: describePieces(nextPieces),
        totalPen: line.totalPen,
        orderTotalPen: totals.totalPen,
        reserveQty: line.reserveQty,
        registeredQty: facts.registeredQty.toFixed(3),
        dispatchedQty: facts.dispatchedQty.toFixed(3),
        reservation: {
          releasedQty: released.toFixed(3),
          reservedQty: reserved.toFixed(3),
          shortfallQty: shortfall.toFixed(3),
          unit: line.reserveUnit,
        },
        productionOrders: orderEffects.audit,
      },
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    return this.outcome(
      item,
      facts.kind,
      line,
      totals.totalPen,
      orderTotalBefore,
      effects,
      shortfall,
      facts.kind === 'QTY' ? null : facts.registeredQty,
    );
  }

  /**
   * D-604: el plan de la OP viva sigue a la cantidad nueva —lo nuevo menos lo que registraron las
   * órdenes cerradas de la línea—; sin OP viva y con lo registrado por debajo de lo nuevo, nace
   * una orden por la diferencia por el camino de siempre (D-084/D-186). Las bobinas montadas no
   * cambian.
   */
  private async followPlan(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    item: QtyItem,
    facts: QtyFacts,
    nextQty: Decimal,
    nextPieces: PieceLike[],
    reservationId: string | null,
    rising: boolean,
    preview: boolean,
    order: LockedOrder,
    reason: string | undefined,
  ): Promise<{ effects: string[]; audit: Record<string, string>[] }> {
    if (facts.kind === 'QTY') return { effects: [], audit: [] };
    const at = `Línea ${item.lineNumber}`;
    const lengthMm = item.product.lengthMm === null ? null : item.product.lengthMm.toFixed(2);
    const live = facts.orders.filter((o) => o.live);
    if (live.length > 1) {
      throw new BadRequestException(
        `${at}: tiene más de una orden viva (${live.map((o) => productionOrderCode(o.seq)).join(', ')}): deja una sola antes de cambiar la cantidad`,
      );
    }
    const planFor = (minus: PieceLike[], minusQty: Decimal): PieceLike[] => {
      if (facts.kind === 'PIECES') return piecesMinus(nextPieces, minus);
      if (facts.kind === 'UNITS') {
        return derivePiecesPlan([], lengthMm, Decimal.max(nextQty.minus(minusQty), 0).toString());
      }
      return [];
    };
    const op = live[0];
    if (op) {
      const code = productionOrderCode(op.seq);
      let planAfter: Decimal;
      if (facts.kind === 'METERS') {
        planAfter = Decimal.max(nextQty.minus(facts.registeredClosedQty), new Decimal(0));
      } else {
        const plan = planFor(facts.registeredClosedPieces, facts.registeredClosedQty);
        planAfter = piecesMeters(plan);
        if (planAfter.gt(0)) {
          await tx.productionOrderItem.deleteMany({ where: { productionOrderId: op.id } });
          await tx.productionOrderItem.createMany({
            data: plan.map((p, i) => ({
              productionOrderId: op.id,
              lineNumber: i + 1,
              lengthMm: p.lengthMm,
              qty: p.qty,
            })),
          });
        }
      }
      if (planAfter.lte(0)) {
        throw new BadRequestException(
          `${at}: la orden ${code} quedaría sin nada que fabricar: anúlala antes de bajar la cantidad`,
        );
      }
      const ready = planAfter.equals(op.registeredMeters);
      await this.auditOrderPlan(tx, actor, order, item, op, planAfter, reason);
      return {
        effects: [
          `El plan de ${code} pasa de ${op.planMeters.toFixed(3)} m a ${planAfter.toFixed(3)} m${
            ready ? ': igual a lo registrado, la orden queda lista para «Registrar y cerrar».' : '.'
          }`,
        ],
        audit: [
          {
            code,
            action: 'PLAN',
            planMetersBefore: op.planMeters.toFixed(3),
            planMetersAfter: planAfter.toFixed(3),
          },
        ],
      };
    }
    // Solo subir abre una orden nueva (segundo modelo cc45, P2-1).
    if (facts.orders.length === 0 || !rising || nextQty.lte(facts.registeredQty))
      return { effects: [], audit: [] };
    // Todas las órdenes de la línea están cerradas y lo nuevo pasa lo registrado.
    const plan = planFor(facts.registeredPieces, facts.registeredQty);
    if (facts.kind !== 'METERS' && piecesCount(plan) === 0) return { effects: [], audit: [] };
    if (reservationId === null) {
      throw new BadRequestException(
        `${at}: no tiene reserva de materia prima de la que colgar una orden nueva`,
      );
    }
    const meters =
      facts.kind === 'METERS' ? nextQty.minus(facts.registeredQty) : piecesMeters(plan);
    // Autorrevisión cc45 (P2-1): la vista previa no crea la orden —el correlativo de una OP no
    // vuelve con el rollback—; dice que nace una, sin código.
    let code = 'una orden nueva';
    if (!preview) {
      const id = await this.roofing.createFromReservationInTx(tx, actor, {
        reservationId,
        operationDate: businessToday(),
        notes: `Diferencia del cambio de cantidad de la línea ${String(item.lineNumber)}`,
        plan,
      });
      const created = await tx.productionOrder.findUniqueOrThrow({
        where: { id },
        select: { seq: true },
      });
      code = productionOrderCode(created.seq);
    }
    return {
      effects: [
        facts.kind === 'METERS'
          ? `Nace ${code} por la diferencia: ${meters.toFixed(3)} m.`
          : `Nace ${code} por la diferencia: ${String(piecesCount(plan))} planchas, ${meters.toFixed(3)} m.`,
      ],
      audit: [{ code, action: 'CREATED', planMeters: meters.toFixed(3) }],
    };
  }

  /**
   * cc50 (D-638): el cambio de cantidad de la línea, en el «Historial» de la OP cuyo plan sigue a
   * la línea (el pedido ya tiene su `sales.order.item-qty`). Misma transacción que el cambio.
   */
  private async auditOrderPlan(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    order: { seq: number },
    item: QtyItem,
    op: { id: string; seq: number; planMeters: Prisma.Decimal },
    planMetersAfter: Decimal,
    reason: string | undefined,
  ): Promise<void> {
    await this.audit.write(tx, {
      actorId: actor.id,
      action: 'production.plan-by-sales-order',
      entity: 'production_orders',
      entityId: op.id,
      before: { code: productionOrderCode(op.seq), planMeters: op.planMeters.toFixed(3) },
      after: {
        planMeters: planMetersAfter.toFixed(3),
        salesOrderId: item.salesOrderId,
        salesOrder: salesOrderCode(order.seq),
        lineNumber: item.lineNumber,
      },
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /** Qué reserva la línea, en palabras: el agregado de materia prima o el SKU. */
  private async reserveLabel(tx: Prisma.TransactionClient, item: QtyItem): Promise<string> {
    if (item.reserveItemType === InventoryItemType.RAW_MATERIAL) {
      const labels = await rawMaterialSpecLabels(tx, [item.reserveItemId]);
      return labels.get(item.reserveItemId) ?? 'la materia prima';
    }
    return item.product.sku;
  }

  /**
   * Con algo despachado, el estado del pedido se recalcula con la cantidad nueva: bajar hasta lo
   * despachado lo atiende entero, subir lo reabre. La misma regla que `recomputeOrderStatus` de
   * los despachos (D-167: una línea de servicio no espera despacho). Sin despachos no se toca.
   */
  private async refreshFulfillment(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
    const order = await tx.salesOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        status: true,
        items: {
          select: {
            id: true,
            qty: true,
            product: { select: { businessLine: { select: { inventoryStrategy: true } } } },
          },
        },
      },
    });
    const rows = await tx.dispatchItem.groupBy({
      by: ['salesOrderItemId'],
      where: {
        salesOrderItemId: { in: order.items.map((i) => i.id) },
        dispatch: { status: DispatchStatus.ISSUED },
      },
      _sum: { qty: true },
    });
    const dispatched = new Map(
      rows.map((r) => [r.salesOrderItemId, toDecimal((r._sum.qty ?? 0).toString())]),
    );
    if (![...dispatched.values()].some((q) => q.gt(0))) return;
    const complete = order.items
      .filter((i) => carriesInventory(i.product.businessLine))
      .every((i) => (dispatched.get(i.id) ?? new Decimal(0)).gte(i.qty.toString()));
    const next = complete ? SalesOrderStatus.FULFILLED : SalesOrderStatus.PARTIALLY_FULFILLED;
    if (next !== order.status) {
      await tx.salesOrder.update({ where: { id: orderId }, data: { status: next } });
    }
  }

  /** Lo que la acción devuelve y la vista previa muestra. */
  private outcome(
    item: QtyItem,
    kind: QtyChangeKind,
    line: { qty: string; totalPen: string; pieces: readonly PieceLike[] },
    orderTotalAfter: string,
    orderTotalBefore: Prisma.Decimal,
    effects: string[],
    shortfall: Decimal,
    /** Lo registrado, en la unidad de la línea; `null` si la línea no se produce. */
    registered: Decimal | null = null,
  ): QtyOutcome {
    const qty = toDecimal(line.qty);
    const before = toDecimal(item.qty.toString());
    const unit = unitSymbol(item.unit);
    const piecesNow = piecesCount(line.pieces);
    const lineText =
      kind === 'PIECES'
        ? `${qty.toFixed(3)} m, ${String(piecesNow)} planchas`
        : kind === 'UNITS'
          ? `${qty.toFixed(0)} planchas`
          : `${qty.toFixed(3)} ${unit}`;
    const atRegistered = registered !== null && registered.gt(0) && qty.equals(registered);
    // Como en el tablero: «se agregan 6 planchas de 3.00 m», «se quitan 10 planchas de 2.40 m».
    const changes =
      kind === 'PIECES' ? piecesChanges(item.pieces.map(toPieceLike), line.pieces) : [];
    const lineEffect = atRegistered
      ? `La línea queda en ${lineText}: igual a lo registrado.`
      : `La línea ${qty.gt(before) ? 'sube' : 'baja'} a ${lineText}${changes.length > 0 ? `: ${changes.join(', ')}` : ''}.`;
    const totalBefore = toDecimal(orderTotalBefore.toString());
    const totalAfter = toDecimal(orderTotalAfter);
    const per = kind === 'PIECES' || kind === 'METERS' ? 'metro' : 'unidad';
    return {
      qty: qty.toFixed(3),
      meters: kind === 'PIECES' || kind === 'METERS' ? qty.toFixed(3) : null,
      pieces: kind === 'PIECES' ? piecesNow : kind === 'UNITS' ? qty.toNumber() : null,
      totalPen: toDecimal(line.totalPen).toFixed(2),
      orderTotalPen: totalAfter.toFixed(2),
      effects: [
        lineEffect,
        ...effects,
        `El total del pedido ${totalAfter.gt(totalBefore) ? 'sube' : 'baja'} de S/ ${formatPen(totalBefore)} a S/ ${formatPen(totalAfter)}. El precio por ${per} no cambia.`,
      ],
      shortfallQty: shortfall.gt(0) ? shortfall.toFixed(3) : null,
    };
  }

  // -------------------------------------------------------------------------
  // Interno
  // -------------------------------------------------------------------------

  /**
   * Bloquea el pedido y comprueba que todavía se edita: no anulado y sin comprobante (factura
   * o boleta en borrador o vivo; una anulada ya no cuenta). Una venta de mostrador nace con su
   * comprobante (D-099), así que queda fuera por esta misma regla.
   */
  private async lockEditable(
    tx: Prisma.TransactionClient,
    orderId: string,
    _what: string,
  ): Promise<LockedOrder> {
    await lockDocuments(tx, { salesOrders: [orderId] });
    const found = await tx.salesOrder.findUnique({
      where: { id: orderId },
      select: { id: true, seq: true, status: true, createdById: true, sellerId: true, notes: true },
    });
    if (!found) throw new NotFoundException('Pedido no encontrado');
    const head = {
      id: found.id,
      seq: found.seq,
      status: found.status,
      created_by_id: found.createdById,
      seller_id: found.sellerId,
      notes: found.notes,
    };
    if (head.status === SalesOrderStatus.CANCELLED) {
      throw new BadRequestException(`El pedido está anulado: no se puede ${_what}`);
    }
    const document = await tx.fiscalDocument.findFirst({
      where: {
        salesOrderId: orderId,
        docType: { in: [FiscalDocType.FACTURA, FiscalDocType.BOLETA] },
        status: { in: [...STANDING_DOCUMENT_STATUSES] },
        archivedAt: null,
      },
      select: { docType: true, number: true },
    });
    if (document) {
      // Un borrador todavía no tiene número: se nombra por su tipo.
      const label = document.number ?? `${document.docType.toLowerCase()} en borrador`;
      throw new BadRequestException(
        `El pedido ya tiene comprobante (${label}): no se puede ${_what}. Corrige con una nota de crédito.`,
      );
    }
    return {
      id: head.id,
      seq: head.seq,
      status: head.status,
      createdById: head.created_by_id,
      sellerId: head.seller_id,
      // D-152: confirmar una cotización importada copia sus observaciones al pedido.
      imported: isImportedQuotation(head.notes),
    };
  }

  private assertOwner(actor: RequestUser, order: LockedOrder, _what: string): void {
    assertSellerAccess(actor, order.sellerId, 'Pedido');
  }

  private async requireItem(tx: Prisma.TransactionClient, orderId: string, itemId: string) {
    const item = await tx.salesOrderItem.findFirst({
      where: { id: itemId, salesOrderId: orderId },
      include: ITEM_INCLUDE,
    });
    if (!item) throw new NotFoundException('Línea del pedido no encontrada');
    return item;
  }

  /**
   * La línea guardada como entrada de `resolveSalesLines`, con lo que se cambia encima.
   *
   * El precio va **en una sola de sus dos formas** (D-161): el nuevo si viene, el guardado si
   * no. Con largos nuevos la descripción se vuelve a armar, porque una línea a medida describe
   * sus largos (D-083); en cualquier otro caso se conserva la que tenía.
   */
  private lineInput(
    item: {
      productId: string;
      qty: Prisma.Decimal;
      unitPricePen: Prisma.Decimal;
      valuePerMeterPen: Prisma.Decimal | null;
      subtotalPen: Prisma.Decimal;
      description: string;
      pieces: { lengthMm: Prisma.Decimal; qty: number }[];
    },
    change: {
      price?: UpdateSalesOrderItemPriceInput;
      qty?: string;
      pieces?: UpdateSalesOrderItemQtyInput['pieces'];
    },
  ): SalesItemInput {
    // D-255 (R2): sin precio nuevo, el de la línea **derivado de su importe** con diez
    // decimales, nunca los cuatro guardados: cambiar la cantidad de una línea de 3840 kg por
    // S/ 11 715.254 con 3.0508 se iba 18 céntimos.
    const price: UpdateSalesOrderItemPriceInput = change.price ?? {
      ...(item.valuePerMeterPen !== null
        ? { valuePerMeterPen: item.valuePerMeterPen.toFixed(4) }
        : {
            unitPricePen: derivedUnitValue(
              item.qty.toString(),
              item.subtotalPen.toString(),
            ).toFixed(DERIVED_UNIT_VALUE_DECIMALS),
          }),
    };
    const pieces =
      change.pieces ??
      (item.pieces.length > 0
        ? item.pieces.map((p) => ({ lengthMm: p.lengthMm.toFixed(2), qty: p.qty }))
        : undefined);
    return {
      productId: item.productId,
      qty: change.qty ?? item.qty.toString(),
      ...(change.pieces === undefined ? { description: item.description } : {}),
      ...(price.valuePerMeterPen !== undefined
        ? { valuePerMeterPen: price.valuePerMeterPen }
        : price.netAmountPen !== undefined
          ? { netAmountPen: price.netAmountPen }
          : price.unitPriceWithIgvPen !== undefined
            ? { unitPriceWithIgvPen: price.unitPriceWithIgvPen }
            : price.unitPricePen !== undefined
              ? { unitPricePen: price.unitPricePen }
              : {}),
      ...(pieces !== undefined ? { pieces } : {}),
    };
  }

  /** Genera la OP de cada línea nueva que reserva materia prima (D-186). */
  private async createProductionOrders(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    itemIds: string[],
  ): Promise<string[]> {
    const reservations = await tx.reservation.findMany({
      where: {
        salesOrderItemId: { in: itemIds },
        status: ReservationStatus.ACTIVE,
        itemType: InventoryItemType.RAW_MATERIAL,
      },
      select: { id: true },
      orderBy: { salesOrderItem: { lineNumber: 'asc' } },
    });
    const ids: string[] = [];
    for (const reservation of reservations) {
      ids.push(
        await this.roofing.createFromReservationInTx(tx, actor, {
          reservationId: reservation.id,
          operationDate: businessToday(),
          notes: null,
        }),
      );
    }
    return ids;
  }

  /**
   * Totales del pedido desde sus líneas: Σ subtotales + Σ IGV, como `documentTotals`, y desde
   * D-377 (R2) redondeados al céntimo en el documento.
   */
  private async refreshTotals(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<{ subtotalPen: string; igvPen: string; totalPen: string }> {
    const sums = await tx.salesOrderItem.aggregate({
      where: { salesOrderId: orderId },
      _sum: { subtotalPen: true, igvPen: true },
    });
    const { subtotal, igv, total } = roundDocumentTotals(
      (sums._sum.subtotalPen ?? 0).toString(),
      (sums._sum.igvPen ?? 0).toString(),
    );
    const totals = {
      subtotalPen: toFixedString(subtotal, 'MONEY'),
      igvPen: toFixedString(igv, 'MONEY'),
      totalPen: toFixedString(total, 'MONEY'),
    };
    await tx.salesOrder.update({ where: { id: orderId }, data: totals });
    return totals;
  }
}
