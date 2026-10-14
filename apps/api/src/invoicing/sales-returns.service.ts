import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CoilStatus,
  Role,
  DispatchStatus,
  InventoryItemType,
  Prisma,
  SalesReturnStatus,
} from '@prisma/client';
import {
  Decimal,
  dispatchCode,
  fromDateOnly,
  isReturnCreditNoteReason,
  salesOrderCode,
  salesReturnCode,
  toDecimal,
  toFixedString,
  type SalesReturnDto,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  planReturnAllocation,
  type DispatchLineStock,
  type ReturnAllocation,
} from './sales-return-allocation';

/**
 * cc52 (D-646) — **devolución de mercadería** de una nota de crédito con motivo SUNAT 06/07.
 *
 * Se crea al **registrar** la NC (cuando queda aceptada), nunca en el borrador: un borrador se
 * descarta. Reingresa cada línea al kardex por la puerta de la regla dura 8
 * (`InventoryService.record`, IN, `SALES_RETURN`), con la fecha de la NC y **al costo con que salió**
 * esa mercadería: el del movimiento de su despacho, del más reciente hacia atrás, nunca más de lo
 * despachado menos lo ya devuelto. No vuelve a reservar ni cambia el estado del pedido: la venta
 * de esa cantidad se deshizo (D-646). Una bobina se devuelve entera, vuelve con su peso y, si
 * estaba terminada, se reabre. Un producto a medida reingresa como producto terminado sobrante,
 * sin pedido (hoy ningún otro pedido ni el mostrador toma ese stock).
 *
 * Anular la NC la revierte con `InventoryService.reverse` (movimiento inverso al mismo costo); si
 * esa mercadería ya se volvió a vender, 409. Las NC no se reactivan.
 */
@Injectable()
export class SalesReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
  ) {}

  /** Lo despachado y aún no devuelto de cada línea de pedido, por línea de despacho. */
  async stockByOrderItem(
    tx: Prisma.TransactionClient,
    orderItemIds: readonly string[],
  ): Promise<Map<string, DispatchLineStock[]>> {
    const out = new Map<string, DispatchLineStock[]>();
    if (orderItemIds.length === 0) return out;
    const rows = await tx.dispatchItem.findMany({
      where: {
        salesOrderItemId: { in: [...new Set(orderItemIds)] },
        movementId: { not: null },
        dispatch: { status: DispatchStatus.ISSUED },
      },
      select: {
        id: true,
        dispatchId: true,
        salesOrderItemId: true,
        itemType: true,
        itemId: true,
        qty: true,
        reserveQty: true,
        movementId: true,
        dispatch: { select: { seq: true, dispatchDate: true, invoiceId: true } },
        salesReturnItems: {
          where: { salesReturn: { status: SalesReturnStatus.ACTIVE } },
          select: { qty: true, reserveQty: true, totalCost: true, movementId: true },
        },
      },
    });
    const movements = await tx.inventoryMovement.findMany({
      where: { id: { in: rows.flatMap((r) => (r.movementId === null ? [] : [r.movementId])) } },
      select: {
        id: true,
        qty: true,
        unitCost: true,
        totalCost: true,
        unit: true,
        businessLineId: true,
      },
    });
    const movementById = new Map(movements.map((m) => [m.id.toString(), m]));
    // cc53 (D-649): la devolución sale al costo **efectivo** de la salida (con sus recosteos por
    // fecha). Un recosteo de una salida saca valor del saldo: su total negativo es más costo.
    const recosts =
      movements.length === 0
        ? []
        : await tx.inventoryMovement.groupBy({
            by: ['recostOfId'],
            where: {
              recostOfId: {
                in: [
                  ...movements.map((m) => m.id),
                  ...rows.flatMap((r) => r.salesReturnItems.map((x) => x.movementId)),
                ],
              },
            },
            _sum: { totalCost: true },
          });
    const recostById = new Map(
      recosts.map((g) => [String(g.recostOfId), toDecimal(g._sum.totalCost?.toString() ?? '0')]),
    );
    for (const r of rows) {
      const movement =
        r.movementId === null ? undefined : movementById.get(r.movementId.toString());
      if (!movement) continue;
      const sum = (pick: (x: (typeof r.salesReturnItems)[number]) => Prisma.Decimal) =>
        r.salesReturnItems.reduce((acc, x) => acc.plus(pick(x).toString()), new Decimal(0));
      const list = out.get(r.salesOrderItemId) ?? [];
      list.push({
        dispatchItemId: r.id,
        dispatchId: r.dispatchId,
        dispatchCode: dispatchCode(r.dispatch.seq),
        dispatchDate: fromDateOnly(r.dispatch.dispatchDate),
        dispatchSeq: r.dispatch.seq,
        invoiceId: r.dispatch.invoiceId,
        itemType: r.itemType,
        itemId: r.itemId,
        qty: toDecimal(r.qty.toString()),
        reserveQty: toDecimal(r.reserveQty.toString()),
        returnedQty: sum((x) => x.qty),
        returnedReserveQty: sum((x) => x.reserveQty),
        // cc53 (D-649): lo ya devuelto, a su costo efectivo (una devolución también se recostea con
        // su salida); si no, la última devolución tomaría de más o de menos.
        returnedTotalCost: r.salesReturnItems.reduce(
          (acc, x) =>
            acc
              .plus(x.totalCost.toString())
              .plus(recostById.get(x.movementId.toString()) ?? new Decimal(0)),
          new Decimal(0),
        ),
        movementId: movement.id,
        ...effectiveOutCost(movement, recostById.get(movement.id.toString())),
        unit: movement.unit,
        businessLineId: movement.businessLineId,
      });
      out.set(r.salesOrderItemId, list);
    }
    return out;
  }

  /**
   * Comprueba, sin escribir, que cada línea pedida tiene despachado sin devolver lo suficiente.
   * La usa el alta de la NC (para fallar antes) y el registro (con todo ya bloqueado).
   */
  async planForLines(
    tx: Prisma.TransactionClient,
    lines: readonly { lineNumber: number; orderItemId: string | null; qty: string }[],
    options: { affectedInvoiceId?: string | null; asOf?: string } = {},
  ): Promise<ReturnAllocation[][]> {
    const stock = await this.stockByOrderItem(
      tx,
      lines.flatMap((l) => (l.orderItemId === null ? [] : [l.orderItemId])),
    );
    // Dos líneas de la NC sobre la misma línea de pedido consumen del mismo despachado.
    type Used = Map<string, { qty: Decimal; reserveQty: Decimal; cost: Decimal }>;
    const used = new Map<string, Used>();
    return lines.map((line) => {
      if (line.orderItemId === null) {
        throw new BadRequestException(
          `Línea ${String(line.lineNumber)}: no viene de un pedido, no hay despacho que devolver`,
        );
      }
      const usedHere: Used = used.get(line.orderItemId) ?? (new Map() as Used);
      used.set(line.orderItemId, usedHere);
      const available = (stock.get(line.orderItemId) ?? []).map((s) => {
        const u = usedHere.get(s.dispatchItemId);
        return u
          ? {
              ...s,
              returnedQty: s.returnedQty.plus(u.qty),
              returnedReserveQty: s.returnedReserveQty.plus(u.reserveQty),
              returnedTotalCost: s.returnedTotalCost.plus(u.cost),
            }
          : s;
      });
      const plan = planReturnAllocation(line.lineNumber, toDecimal(line.qty), available, options);
      for (const a of plan) {
        const prev = usedHere.get(a.stock.dispatchItemId);
        usedHere.set(a.stock.dispatchItemId, {
          qty: (prev?.qty ?? new Decimal(0)).plus(a.qty),
          reserveQty: (prev?.reserveQty ?? new Decimal(0)).plus(a.reserveQty),
          cost: (prev?.cost ?? new Decimal(0)).plus(a.totalCost),
        });
      }
      return plan;
    });
  }

  /** Los despachos de los que puede salir la devolución de una NC: para bloquearlos antes. */
  async dispatchIdsForCreditNote(tx: Prisma.TransactionClient, noteId: string): Promise<string[]> {
    const items = await tx.fiscalDocumentItem.findMany({
      where: { documentId: noteId },
      select: { salesOrderItemId: true },
    });
    const orderItemIds = items.flatMap((i) => (i.salesOrderItemId ? [i.salesOrderItemId] : []));
    if (orderItemIds.length === 0) return [];
    const rows = await tx.dispatchItem.findMany({
      where: {
        salesOrderItemId: { in: orderItemIds },
        dispatch: { status: DispatchStatus.ISSUED },
      },
      select: { dispatchId: true },
    });
    return [...new Set(rows.map((r) => r.dispatchId))].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Crea la devolución de una NC recién registrada, dentro de la transacción del registro (con
   * la NC, su afectado, los despachos y el pedido ya bloqueados, en ese orden). `null` si el
   * motivo no es de devolución.
   */
  async createForCreditNoteInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    noteId: string,
    /** Los despachos que el llamador bloqueó: el plan no puede salir de otro (P2 de cc52). */
    lockedDispatchIds: readonly string[],
  ): Promise<string | null> {
    const note = await tx.fiscalDocument.findUniqueOrThrow({
      where: { id: noteId },
      select: {
        id: true,
        number: true,
        issueDate: true,
        creditNoteReason: true,
        salesOrderId: true,
        affectedDocument: { select: { id: true, number: true } },
        items: {
          orderBy: { lineNumber: 'asc' },
          select: { id: true, lineNumber: true, qty: true, salesOrderItemId: true },
        },
      },
    });
    if (!isReturnCreditNoteReason(note.creditNoteReason)) return null;
    const salesOrderId = note.salesOrderId;
    if (salesOrderId === null) {
      throw new BadRequestException(
        'Este comprobante no viene de un pedido: no hay despacho que devolver. Usa «Descuento / corrección de precio».',
      );
    }
    const operationDate = fromDateOnly(note.issueDate);
    const plan = () =>
      this.planForLines(
        tx,
        note.items.map((i) => ({
          lineNumber: i.lineNumber,
          orderItemId: i.salesOrderItemId,
          qty: i.qty.toString(),
        })),
        { affectedInvoiceId: note.affectedDocument?.id ?? null, asOf: operationDate },
      );
    const locked = new Set(lockedDispatchIds);
    const assertLockedDispatches = (planned: Awaited<ReturnType<typeof plan>>) => {
      if (planned.flat().some((a) => !locked.has(a.stock.dispatchId))) {
        throw new ConflictException(
          'Entró un despacho nuevo de este pedido mientras se registraba la nota de crédito: vuelve a intentarlo',
        );
      }
    };
    const draft = await plan();
    assertLockedDispatches(draft);
    // Regla dura 17: bobinas y saldos de toda la operación, en orden, antes de escribir.
    await this.inventory.lockInOrder(tx, {
      items: draft.flat().map((a) => ({
        businessLineId: a.stock.businessLineId,
        itemType: a.stock.itemType,
        itemId: a.stock.itemId,
        unit: a.stock.unit,
      })),
    });
    // cc53 (D-474): el costo efectivo de la salida (con sus recosteos) se lee bajo el lock; un
    // recosteo concurrente que entró entre la primera lectura y el bloqueo ya está acá.
    const plans = await plan();
    assertLockedDispatches(plans);
    const lockedItems = new Set(draft.flat().map((a) => `${a.stock.itemType}:${a.stock.itemId}`));
    if (plans.flat().some((a) => !lockedItems.has(`${a.stock.itemType}:${a.stock.itemId}`))) {
      throw new ConflictException(
        'Cambió lo despachado de este pedido mientras se registraba la nota de crédito: vuelve a intentarlo',
      );
    }

    const created = await tx.salesReturn.create({
      data: {
        creditNoteId: note.id,
        salesOrderId,
        operationDate: note.issueDate,
        createdById: actor.id,
      },
      select: { id: true, seq: true },
    });
    const code = salesReturnCode(created.seq);
    const order = await tx.salesOrder.findUniqueOrThrow({
      where: { id: salesOrderId },
      select: { seq: true },
    });
    let lineNumber = 0;
    const lines: Record<string, string | number>[] = [];
    const coilIds: string[] = [];
    for (const [index, plan] of plans.entries()) {
      const noteItem = note.items[index];
      if (noteItem === undefined) continue;
      for (const a of plan) {
        lineNumber += 1;
        const movement = await this.inventory.record(tx, {
          businessLineId: a.stock.businessLineId,
          itemType: a.stock.itemType,
          itemId: a.stock.itemId,
          type: 'IN',
          qty: toFixedString(a.reserveQty, 'KG'),
          unit: a.stock.unit,
          unitCost: toFixedString(a.unitCost, 'MONEY'),
          totalCost: toFixedString(a.totalCost, 'MONEY'),
          refType: 'SALES_RETURN',
          refId: created.id,
          notes:
            `Devolución ${code} de la NC ${note.number ?? ''} (despacho ${a.stock.dispatchCode})`.slice(
              0,
              240,
            ),
          actorId: actor.id,
          operationDate,
          // La fecha de la NC es el propósito: el acuse de orden va implícito (D-645).
          confirmBackdate: true,
        });
        if (movement === null) {
          throw new BadRequestException(
            `Línea ${String(noteItem.lineNumber)}: la línea de negocio no lleva inventario`,
          );
        }
        await tx.salesReturnItem.create({
          data: {
            salesReturnId: created.id,
            lineNumber,
            creditNoteItemId: noteItem.id,
            dispatchItemId: a.stock.dispatchItemId,
            itemType: a.stock.itemType,
            itemId: a.stock.itemId,
            qty: toFixedString(a.qty, 'KG'),
            reserveQty: toFixedString(a.reserveQty, 'KG'),
            unitCost: toFixedString(a.unitCost, 'MONEY'),
            totalCost: toFixedString(a.totalCost, 'MONEY'),
            movementId: movement.id,
          },
        });
        if (a.stock.itemType === InventoryItemType.COIL) coilIds.push(a.stock.itemId);
        lines.push({
          line: noteItem.lineNumber,
          dispatch: a.stock.dispatchCode,
          qty: toFixedString(a.qty, 'KG'),
          reserveQty: toFixedString(a.reserveQty, 'KG'),
          unitCost: toFixedString(a.unitCost, 'MONEY'),
          totalCost: toFixedString(a.totalCost, 'MONEY'),
        });
      }
    }
    const reopened = await this.reopenReturnedCoils(tx, actor, coilIds, code);

    const detail = {
      salesReturnId: created.id,
      salesReturn: code,
      creditNoteId: note.id,
      creditNote: note.number,
      affects: note.affectedDocument?.number ?? null,
      salesOrder: salesOrderCode(order.seq),
      operationDate,
      totalCost: toFixedString(
        lines.reduce((acc, l) => acc.plus(String(l.totalCost)), new Decimal(0)),
        'MONEY',
      ),
      lines,
      ...(reopened.length > 0 ? { reopenedCoils: reopened } : {}),
    };
    // cc50 (D-638): en el «Historial» de la devolución, de la NC, del comprobante y del pedido,
    // en la misma transacción.
    for (const target of [
      { entity: 'sales_returns', entityId: created.id },
      { entity: 'fiscal_documents', entityId: note.id },
      ...(note.affectedDocument
        ? [{ entity: 'fiscal_documents', entityId: note.affectedDocument.id }]
        : []),
      { entity: 'sales_orders', entityId: salesOrderId },
    ]) {
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.return.create',
        ...target,
        after: detail,
      });
    }
    return created.id;
  }

  /**
   * Revierte la devolución de una NC que se anula: cada reingreso con su movimiento inverso, al
   * mismo costo, con la fecha de hoy. Si la mercadería ya se volvió a vender, 409. `null` si la NC
   * no tiene devolución vigente.
   */
  async reverseForCreditNoteInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    noteId: string,
    reason: string,
  ): Promise<string | null> {
    const found = await tx.salesReturn.findUnique({
      where: { creditNoteId: noteId },
      select: {
        id: true,
        seq: true,
        status: true,
        salesOrderId: true,
        creditNote: {
          select: {
            id: true,
            number: true,
            affectedDocument: { select: { id: true, number: true } },
          },
        },
        items: {
          orderBy: { lineNumber: 'asc' },
          select: {
            movementId: true,
            itemType: true,
            itemId: true,
            reserveQty: true,
            totalCost: true,
            movement: { select: { businessLineId: true, unit: true } },
            dispatchItem: { select: { dispatch: { select: { seq: true } } } },
          },
        },
      },
    });
    if (found?.status !== SalesReturnStatus.ACTIVE) return null;
    const code = salesReturnCode(found.seq);
    await this.inventory.lockInOrder(tx, {
      items: found.items.map((i) => ({
        businessLineId: i.movement.businessLineId,
        itemType: i.itemType,
        itemId: i.itemId,
        unit: i.movement.unit,
      })),
    });
    for (const item of found.items) {
      try {
        await this.inventory.reverse(
          tx,
          item.movementId,
          actor.id,
          `Anulación de la NC ${found.creditNote.number ?? ''}: se revierte la devolución ${code}. ${reason}`.slice(
            0,
            240,
          ),
        );
      } catch (err) {
        if (err instanceof BadRequestException) {
          throw new ConflictException(
            `No se puede anular la nota de crédito: la mercadería de la devolución ${code} ya no está en el almacén (${err.message}). Revierte primero lo que salió después.`,
          );
        }
        throw err;
      }
    }
    await tx.salesReturn.update({
      where: { id: found.id },
      data: {
        status: SalesReturnStatus.REVERSED,
        reversedAt: new Date(),
        reversedById: actor.id,
        reverseReason: reason.slice(0, 240),
      },
    });
    const closed = await this.closeReturnedCoils(
      tx,
      actor,
      new Map(
        found.items
          .filter((i) => i.itemType === InventoryItemType.COIL)
          .map((i) => [i.itemId, dispatchCode(i.dispatchItem.dispatch.seq)]),
      ),
      code,
    );
    const detail = {
      salesReturnId: found.id,
      salesReturn: code,
      creditNote: found.creditNote.number,
      reason,
      ...(closed.length > 0 ? { closedCoils: closed } : {}),
    };
    for (const target of [
      { entity: 'sales_returns', entityId: found.id },
      { entity: 'fiscal_documents', entityId: found.creditNote.id },
      ...(found.creditNote.affectedDocument
        ? [{ entity: 'fiscal_documents', entityId: found.creditNote.affectedDocument.id }]
        : []),
      { entity: 'sales_orders', entityId: found.salesOrderId },
    ]) {
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.return.reverse',
        ...target,
        after: detail,
        reason,
      });
    }
    return found.id;
  }

  /** Una bobina que vuelve con su peso y estaba terminada se reabre, con su auditoría. */
  private async reopenReturnedCoils(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    coilIds: string[],
    code: string,
  ): Promise<string[]> {
    if (coilIds.length === 0) return [];
    const coils = await tx.coil.findMany({
      where: { id: { in: coilIds }, status: CoilStatus.CLOSED },
      select: { id: true, code: true },
    });
    for (const coil of coils) {
      await tx.coil.update({ where: { id: coil.id }, data: { status: CoilStatus.OPEN } });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'coils.open',
        entity: 'coils',
        entityId: coil.id,
        before: { status: CoilStatus.CLOSED },
        after: {
          status: CoilStatus.OPEN,
          reason: `Devuelta por la devolución ${code} (D-646)`,
          adjustment: null,
          reopenedBySalesReturn: code,
        },
      });
    }
    return coils.map((c) => c.code);
  }

  /**
   * Al revertir la devolución, la bobina que esa devolución reabrió y quedó en cero se cierra. El
   * cierre lleva `closedByDispatch` (el despacho que la había vendido entera): vuelve a estar
   * vendida por ese despacho, y si después se revierte el despacho, `reopenRevertedCoils` la
   * reabre (D-170) en vez de dejarla cerrada con saldo.
   */
  private async closeReturnedCoils(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    dispatchByCoil: Map<string, string>,
    code: string,
  ): Promise<string[]> {
    const coilIds = [...dispatchByCoil.keys()];
    if (coilIds.length === 0) return [];
    const balances = await tx.inventoryBalance.findMany({
      where: { itemType: 'COIL', itemId: { in: coilIds } },
      select: { itemId: true, qty: true },
    });
    const empty = balances.filter((b) => toDecimal(b.qty.toString()).lte(0)).map((b) => b.itemId);
    if (empty.length === 0) return [];
    const reopenedHere = await tx.auditLog.findMany({
      where: { entity: 'coils', entityId: { in: empty }, action: 'coils.open' },
      select: { entityId: true, after: true },
    });
    const ids = reopenedHere
      .filter((r) => (r.after as Record<string, unknown> | null)?.reopenedBySalesReturn === code)
      .flatMap((r) => (r.entityId ? [r.entityId] : []));
    const coils = await tx.coil.findMany({
      where: { id: { in: ids }, status: CoilStatus.OPEN },
      select: { id: true, code: true },
    });
    for (const coil of coils) {
      await tx.coil.update({ where: { id: coil.id }, data: { status: CoilStatus.CLOSED } });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'coils.close',
        entity: 'coils',
        entityId: coil.id,
        before: { status: CoilStatus.OPEN },
        after: {
          status: CoilStatus.CLOSED,
          reason: `Se revirtió la devolución ${code} que la había reabierto (D-646)`,
          adjustment: null,
          closedBySalesReturnReversal: code,
          ...(dispatchByCoil.get(coil.id) ? { closedByDispatch: dispatchByCoil.get(coil.id) } : {}),
        },
      });
    }
    return coils.map((c) => c.code);
  }

  /** RF-S3c (revisión de cc52, P3): el vendedor solo ve las devoluciones de sus pedidos. */
  async assertSellerAccessTo(actor: RequestUser, id: string): Promise<void> {
    const found = await this.prisma.salesReturn.findUnique({
      where: { id },
      select: { salesOrder: { select: { sellerId: true } } },
    });
    // Como `assertSellerAccess`: a otro vendedor, como si no existiera (sin revelar que existe).
    if (
      found === null ||
      (actor.role === Role.VENDEDOR && found.salesOrder.sellerId !== actor.id)
    ) {
      throw new NotFoundException('Devolución no encontrada');
    }
  }

  /** El documento de devolución, para su pantalla. */
  async findOne(id: string): Promise<SalesReturnDto> {
    const r = await this.prisma.salesReturn.findUnique({
      where: { id },
      include: {
        creditNote: {
          select: {
            id: true,
            number: true,
            creditNoteReason: true,
            affectedDocument: { select: { id: true, number: true } },
          },
        },
        salesOrder: { select: { id: true, seq: true } },
        createdBy: { select: { name: true } },
        reversedBy: { select: { name: true } },
        items: {
          orderBy: { lineNumber: 'asc' },
          include: {
            creditNoteItem: { select: { lineNumber: true, description: true, unit: true } },
            dispatchItem: { select: { dispatchId: true, dispatch: { select: { seq: true } } } },
            movement: { select: { unit: true } },
          },
        },
      },
    });
    if (r === null) throw new NotFoundException('Devolución no encontrada');
    return toSalesReturnDto(r);
  }
}

type SalesReturnRow = Prisma.SalesReturnGetPayload<{
  include: {
    creditNote: {
      select: {
        id: true;
        number: true;
        creditNoteReason: true;
        affectedDocument: { select: { id: true; number: true } };
      };
    };
    salesOrder: { select: { id: true; seq: true } };
    createdBy: { select: { name: true } };
    reversedBy: { select: { name: true } };
    items: {
      include: {
        creditNoteItem: { select: { lineNumber: true; description: true; unit: true } };
        dispatchItem: { select: { dispatchId: true; dispatch: { select: { seq: true } } } };
        movement: { select: { unit: true } };
      };
    };
  };
}>;

export function toSalesReturnDto(r: SalesReturnRow): SalesReturnDto {
  return {
    id: r.id,
    code: salesReturnCode(r.seq),
    status: r.status,
    operationDate: fromDateOnly(r.operationDate),
    creditNoteId: r.creditNote.id,
    creditNoteNumber: r.creditNote.number,
    creditNoteReason: r.creditNote.creditNoteReason,
    affectedDocumentId: r.creditNote.affectedDocument?.id ?? null,
    affectedDocumentNumber: r.creditNote.affectedDocument?.number ?? null,
    salesOrderId: r.salesOrder.id,
    salesOrderCode: salesOrderCode(r.salesOrder.seq),
    createdAt: r.createdAt.toISOString(),
    createdByName: r.createdBy.name,
    reversedAt: r.reversedAt?.toISOString() ?? null,
    reversedByName: r.reversedBy?.name ?? null,
    reverseReason: r.reverseReason,
    totalCostPen: toFixedString(
      r.items.reduce((acc, i) => acc.plus(i.totalCost.toString()), new Decimal(0)),
      'MONEY',
    ),
    items: r.items.map((i) => ({
      lineNumber: i.lineNumber,
      creditNoteLine: i.creditNoteItem.lineNumber,
      description: i.creditNoteItem.description,
      qty: i.qty.toFixed(3),
      unit: i.creditNoteItem.unit,
      itemType: i.itemType,
      itemId: i.itemId,
      reserveQty: i.reserveQty.toFixed(3),
      kardexUnit: i.movement.unit,
      unitCostPen: i.unitCost.toFixed(4),
      totalCostPen: i.totalCost.toFixed(4),
      dispatchId: i.dispatchItem.dispatchId,
      dispatchCode: dispatchCode(i.dispatchItem.dispatch.seq),
      movementId: i.movementId.toString(),
    })),
  };
}

/**
 * cc53 (D-649): el costo de una salida con sus recosteos. Sin recosteo, el grabado tal cual (el
 * unitario del kardex); con recosteo, el total corregido y su unitario.
 */
export function effectiveOutCost(
  movement: {
    qty: { toString(): string };
    unitCost: { toString(): string };
    totalCost: { toString(): string };
  },
  recostTotal: Decimal | undefined,
): { unitCost: Decimal; totalCost: Decimal } {
  const totalCost = toDecimal(movement.totalCost.toString());
  if (!recostTotal || recostTotal.isZero()) {
    return { unitCost: toDecimal(movement.unitCost.toString()), totalCost };
  }
  const corrected = totalCost.minus(recostTotal);
  return { unitCost: corrected.div(movement.qty.toString()), totalCost: corrected };
}
