import { assertSellerAccess } from '../auth/seller-scope';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  DispatchStatus,
  FiscalDocType,
  InventoryItemType,
  Prisma,
  ProductionOrderStatus,
  ProductionReportStatus,
  ReservationStatus,
  SalesOrderStatus,
} from '@prisma/client';
import {
  businessToday,
  carriesInventory,
  DERIVED_UNIT_VALUE_DECIMALS,
  derivedUnitValue,
  isImportedQuotation,
  lineAmounts,
  MAX_SALES_ITEMS,
  money,
  productionOrderCode,
  salesOrderCode,
  STANDING_DOCUMENT_STATUSES,
  toDecimal,
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
import { derivePiecesPlan } from '../production/roofing-math';
import { RoofingProductionService } from '../production/roofing-production.service';
import {
  COIL_SALE_IDENTITY_SELECT,
  coilPoolFor,
  coilSaleSkus,
  findCoilSaleProducts,
  lineCoilPool,
} from './coil-sale-product';
import { recordPriceChanges } from './price-changes';
import { assertPriceFloor } from './price-floor';
import { resolveSalesLines } from './sales-lines';
import { SalesOrdersService } from './sales-orders.service';

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

  /** La misma corrección dentro de la transacción del llamador (el barrido corrige el pedido entero). */
  async restorePaperAmountsInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    orderId: string,
    itemId: string,
    paper: { netAmountPen: string; igvAmountPen?: string; totalAmountPen?: string },
    reason: string,
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
    await recordPriceChanges(
      tx,
      { salesOrderId: orderId },
      [item],
      [{ lineNumber: item.lineNumber, productId: item.productId, ...next }],
      actor.id,
    );
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

    await tx.$queryRaw`
          SELECT "id" FROM "reservations" WHERE "sales_order_item_id" = ${item.id}::uuid
          ORDER BY "id" FOR UPDATE
        `;
    await tx.reservation.updateMany({
      where: { salesOrderItemId: item.id, status: ReservationStatus.ACTIVE },
      data: {
        qty: '0',
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
  // Cantidad de una línea confirmada
  // -------------------------------------------------------------------------

  /**
   * Cambia la cantidad (y, en una línea a medida, sus largos) de una línea confirmada.
   *
   * **Solo mientras nada de esa línea salió de su lugar.** Con un reporte de producción vigente
   * la reserva ya se consumió en parte y el material rolado existe; con un despacho, la reserva
   * ya bajó. Recalcular encima de cualquiera de las dos obligaría a adivinar qué parte de lo
   * nuevo ya está hecha. La salida en ese caso es agregar un ítem con la diferencia, y el
   * rechazo lo dice.
   *
   * Lo que sí hace: libera la reserva vigente de la línea y reserva la nueva cantidad por la
   * puerta de siempre (si no alcanza, no cambia nada); la OP viva, si la hay, pasa a colgar de
   * la reserva nueva con el plan de corte por defecto de la cantidad nueva (D-084).
   */
  async updateItemQty(
    actor: RequestUser,
    orderId: string,
    itemId: string,
    input: UpdateSalesOrderItemQtyInput,
  ): Promise<SalesOrderDto> {
    await this.prisma.$transaction(
      async (tx) => {
        const order = await this.lockEditable(tx, orderId, 'cambiar cantidades');
        this.assertOwner(actor, order, 'cambiarle cantidades');
        const item = await this.requireItem(tx, orderId, itemId);
        const at = `Línea ${item.lineNumber}`;
        const addInstead = 'Agrega un ítem nuevo con la diferencia.';

        if (item.reserveItemType === InventoryItemType.COIL) {
          throw new BadRequestException(
            `${at}: la venta de una bobina entera vende su saldo completo; la cantidad no se edita`,
          );
        }
        const dispatched = await tx.dispatchItem.findFirst({
          where: { salesOrderItemId: item.id, dispatch: { status: DispatchStatus.ISSUED } },
          select: { id: true },
        });
        if (dispatched) {
          throw new BadRequestException(
            `${at}: ya tiene despachos, así que su cantidad no se cambia. ${addInstead}`,
          );
        }

        await tx.$queryRaw`
          SELECT "id" FROM "reservations" WHERE "sales_order_item_id" = ${item.id}::uuid
          ORDER BY "id" FOR UPDATE
        `;
        const reservations = await tx.reservation.findMany({
          where: { salesOrderItemId: item.id },
          select: {
            id: true,
            status: true,
            itemType: true,
            // **Todas** las OP no anuladas, cerradas incluidas: una OP que reportó y se cerró
            // ya no está viva, pero dejó producto fabricado con su propia reserva y la de
            // materia prima liberada. Mirar solo las vivas dejaba recalcular encima de eso.
            productionOrders: {
              where: { status: { not: ProductionOrderStatus.CANCELLED } },
              select: { id: true, seq: true, status: true, reservationId: true },
            },
          },
        });
        const orders = reservations.flatMap((r) => r.productionOrders);
        const closed = orders.find(
          (o) =>
            o.status !== ProductionOrderStatus.DRAFT &&
            o.status !== ProductionOrderStatus.IN_PROGRESS,
        );
        if (closed) {
          throw new BadRequestException(
            `${at}: la orden ${productionOrderCode(closed.seq)} ya se cerró, así que la cantidad no se cambia. ${addInstead}`,
          );
        }
        const liveOrders = orders;
        if (liveOrders.length > 0) {
          const reported = await tx.productionReport.findFirst({
            where: {
              productionOrderId: { in: liveOrders.map((o) => o.id) },
              status: ProductionReportStatus.ACTIVE,
            },
            select: { productionOrder: { select: { seq: true } } },
          });
          if (reported) {
            throw new BadRequestException(
              `${at}: la orden ${productionOrderCode(reported.productionOrder.seq)} ya tiene reportes de producción, así que la cantidad no se cambia. ${addInstead}`,
            );
          }
        }
        // D-088: producir traslada la promesa a una reserva del producto fabricado. Si la línea
        // tiene una reserva viva de otro tipo que el suyo, ya hay producción detrás.
        if (
          reservations.some(
            (r) => r.status === ReservationStatus.ACTIVE && r.itemType !== item.reserveItemType,
          )
        ) {
          throw new BadRequestException(
            `${at}: ya tiene material fabricado reservado, así que la cantidad no se cambia. ${addInstead}`,
          );
        }
        if (reservations.some((r) => r.status === ReservationStatus.CONSUMED)) {
          throw new BadRequestException(
            `${at}: su material ya se consumió en producción, así que la cantidad no se cambia. ${addInstead}`,
          );
        }

        const [line] = await resolveSalesLines(
          tx,
          [this.lineInput(item, { qty: input.qty, pieces: input.pieces })],
          // Sin piso: el precio no cambia y ya pasó el piso cuando se fijó. Cambiar una
          // cantidad no es la ocasión de rechazar un precio que nadie tocó.
          { firstLineNumber: item.lineNumber },
        );
        if (!line) throw new NotFoundException(`${at}: no se pudo recalcular`);

        const active = reservations.filter((r) => r.status === ReservationStatus.ACTIVE);
        if (active.length > 0) {
          await tx.reservation.updateMany({
            where: { id: { in: active.map((r) => r.id) }, status: ReservationStatus.ACTIVE },
            data: {
              qty: '0',
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
        await this.orders.createReservations(tx, actor, orderId, [updated]);

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
        const adjustedOrders: string[] = [];
        for (const op of liveOrders) {
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
        }

        const totals = await this.refreshTotals(tx, orderId);
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'sales.order.item-qty',
          entity: 'sales_orders',
          entityId: orderId,
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
          },
        });
      },
      { timeout: 30_000 },
    );
    return this.orders.findOne(orderId);
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
    const rows = await tx.$queryRaw<
      {
        id: string;
        seq: number;
        status: SalesOrderStatus;
        created_by_id: string;
        seller_id: string | null;
        notes: string | null;
      }[]
    >`
      SELECT "id", "seq", "status", "created_by_id", "seller_id", "notes"
      FROM "sales_orders" WHERE "id" = ${orderId}::uuid FOR UPDATE
    `;
    const head = rows[0];
    if (!head) throw new NotFoundException('Pedido no encontrado');
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
      include: {
        product: {
          select: {
            businessLineId: true,
            lengthMm: true,
            sku: true,
            name: true,
            businessLine: { select: { code: true } },
          },
        },
        pieces: { orderBy: { lineNumber: 'asc' } },
      },
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

  /** Totales del pedido desde sus líneas: Σ subtotales + Σ IGV, como `documentTotals`. */
  private async refreshTotals(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<{ subtotalPen: string; igvPen: string; totalPen: string }> {
    const sums = await tx.salesOrderItem.aggregate({
      where: { salesOrderId: orderId },
      _sum: { subtotalPen: true, igvPen: true },
    });
    const subtotal = toDecimal((sums._sum.subtotalPen ?? 0).toString());
    const igv = toDecimal((sums._sum.igvPen ?? 0).toString());
    const totals = {
      subtotalPen: toFixedString(subtotal, 'MONEY'),
      igvPen: toFixedString(igv, 'MONEY'),
      totalPen: toFixedString(subtotal.plus(igv), 'MONEY'),
    };
    await tx.salesOrder.update({ where: { id: orderId }, data: totals });
    return totals;
  }
}
