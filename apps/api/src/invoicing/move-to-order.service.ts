import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DispatchStatus,
  FiscalDocumentOrigin,
  FiscalDocumentStatus,
  SalesOrderStatus,
  type Prisma,
} from '@prisma/client';
import {
  GENERIC_CUSTOMER_MAX_TOTAL_PEN,
  LIVE_DOCUMENT_STATUSES as SHARED_LIVE_DOCUMENT_STATUSES,
  dispatchCode,
  salesOrderCode,
  toDecimal,
  type MovableAnnulledDocumentDto,
  type MoveDocumentToOrderInput,
  type MoveToOrderPreviewDto,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  REACTIVATABLE_DOC_TYPES,
  REACTIVATION_TX_TIMEOUT_MS,
  assertCanReactivate,
  availability,
  lockAnnulledForReactivation,
} from './fiscal-import.service';
import { pairRowsToOrder } from './move-to-order-lines';
import { paperTotalDifference, planOrderLines } from './reactivate-order-lines';

/** D-381: cuántos anulados del cliente lista el diálogo, los más recientes primero. */
export const MOVABLE_CANDIDATES_LIMIT = 20;

interface OrderRow {
  id: string;
  status: string;
  customer_id: string;
  seq: number;
  issue_date: Date;
  seller_id: string | null;
}

/** `2026-08-20` → `20/08/2026`. */
function dayLabel(date: Date): string {
  const [y, m, d] = date.toISOString().slice(0, 10).split('-');
  return `${d ?? ''}/${m ?? ''}/${y ?? ''}`;
}

/**
 * D-381: **traer un comprobante manual anulado a otro pedido**.
 *
 * El caso del dueño (FFA1-00001389): anuló el comprobante y también su pedido, que tenía datos
 * erróneos, y creó el pedido correcto. El número de un anulado sigue ocupado, las dos
 * reactivaciones (D-373, D-378) bloquean por pedido anulado y un pedido anulado no se reabre.
 *
 * La acción, desde el pedido destino: conserva número, serie, fecha, condición y vencimiento (los
 * del papel), pasa el comprobante al pedido destino con **las líneas de ese pedido** —emparejado
 * previo con `pairRowsToOrder` y después el mismo plan de D-378— y lo vuelve a `ACCEPTED`. Los
 * controles son los de D-378: solo administrador, motivo, casilla y total del papel al céntimo.
 *
 * Decisiones del dueño (2026-10-03): el cliente no cambia; solo si el pedido de origen está
 * anulado; se permite aunque el pedido destino sea posterior a la fecha del papel, con aviso; el
 * vendedor del comprobante pasa a ser el del pedido destino y queda en el antes y el después.
 *
 * No toca kardex, reservas, cobros ni despachos: el comprobante vuelve sin despacho declarado y
 * se despacha aparte (D-364), a la fecha del papel.
 */
@Injectable()
export class MoveDocumentToOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Los manuales anulados del cliente del pedido que se podrían traer, con el motivo si no se
   * puede. **Sin bloqueos**: corre las mismas comprobaciones con `lock = false`, como la sección
   * de anulados de cc13; la vista previa y la ejecución vuelven a comprobar todo con sus locks.
   *
   * Presupuesto (llamadas a Prisma, verificado por test en `move-to-order.service.spec.ts`): 2
   * fijas (pedido y anulados) y, por candidato que pasa todos los bloqueos, 4 comunes
   * (`lockAnnulledForReactivation`) + 10 propias = 14 (sin lock no corre el de borradores); uno
   * bloqueado corta antes. En SQL reales
   * son algunas más: la lectura del comprobante trae `salesOrder` e `items` aparte. Tope de
   * `MOVABLE_CANDIDATES_LIMIT` candidatos, y se pide al abrir el diálogo, no al pintar el pedido.
   * En la práctica un cliente tiene uno o dos anulados de pedidos anulados.
   */
  async candidates(
    actor: RequestUser,
    targetOrderId: string,
  ): Promise<MovableAnnulledDocumentDto[]> {
    assertCanReactivate(actor);
    const target = await this.prisma.salesOrder.findUnique({
      where: { id: targetOrderId },
      select: { customerId: true },
    });
    if (!target) throw new NotFoundException('Pedido no encontrado');
    const docs = await this.prisma.fiscalDocument.findMany({
      where: {
        customerId: target.customerId,
        status: FiscalDocumentStatus.ANNULLED,
        origin: FiscalDocumentOrigin.MANUAL,
        docType: { in: [...REACTIVATABLE_DOC_TYPES] },
        archivedAt: null,
        salesOrderId: { not: targetOrderId },
        // Decisión 2 del dueño, antes del tope: un anulado de un pedido vivo nunca se trae, y
        // no tiene que quitarle lugar en la lista a uno que sí (autorrevisión del diseño, P3).
        salesOrder: { status: SalesOrderStatus.CANCELLED },
      },
      select: {
        id: true,
        number: true,
        docType: true,
        issueDate: true,
        totalPen: true,
        salesOrderId: true,
        salesOrder: { select: { seq: true } },
        annulledAt: true,
        annulReason: true,
      },
      orderBy: [{ annulledAt: 'desc' }, { id: 'asc' }],
      take: MOVABLE_CANDIDATES_LIMIT,
    });

    // Lecturas simples, una por vez: sin transacción, el cliente de Prisma vale como `tx`.
    const reader: Prisma.TransactionClient = this.prisma;
    const out: MovableAnnulledDocumentDto[] = [];
    for (const d of docs) {
      out.push({
        id: d.id,
        number: d.number,
        docType: d.docType,
        issueDate: d.issueDate.toISOString().slice(0, 10),
        totalPen: d.totalPen.toFixed(4),
        sourceOrderId: d.salesOrderId,
        sourceOrderCode: d.salesOrder ? salesOrderCode(d.salesOrder.seq) : null,
        annulledAt: d.annulledAt?.toISOString() ?? null,
        annulReason: d.annulReason,
        availability: await availability(() => this.plan(reader, d.id, targetOrderId, false)),
      });
    }
    return out;
  }

  /**
   * La vista previa del modal: los mismos bloqueos y locks que la ejecución, en una transacción
   * que no escribe (el mismo criterio que D-378, revisión cc13 P2-3).
   */
  async preview(
    actor: RequestUser,
    id: string,
    targetOrderId: string,
  ): Promise<MoveToOrderPreviewDto> {
    assertCanReactivate(actor);
    return this.prisma.$transaction(
      async (tx) => {
        const p = await this.plan(tx, id, targetOrderId);
        return {
          id,
          number: p.document.number,
          issueDate: p.document.issueDate.toISOString().slice(0, 10),
          sourceOrderCode: p.sourceCode,
          targetOrderCode: p.targetCode,
          targetOrderIssueDate: p.target.issue_date.toISOString().slice(0, 10),
          sellerBefore: p.sellerBefore,
          sellerAfter: p.sellerAfter,
          before: p.plan.before,
          after: p.plan.after,
          warnings: p.warnings,
        };
      },
      { timeout: REACTIVATION_TX_TIMEOUT_MS },
    );
  }

  /** Trae el comprobante al pedido destino. Solo si el total del papel coincide al céntimo. */
  async move(
    actor: RequestUser,
    id: string,
    input: MoveDocumentToOrderInput,
  ): Promise<{ id: string; number: string | null }> {
    assertCanReactivate(actor);
    if (!input.confirmMatchesPaper) {
      throw new BadRequestException(
        'Confirma que el comprobante, con estas líneas y en este pedido, coincide con el papel vigente antes de traerlo',
      );
    }

    return this.prisma.$transaction(
      async (tx) => {
        const p = await this.plan(tx, id, input.targetSalesOrderId);
        const { document, plan, label } = p;

        const difference = paperTotalDifference(input.paperTotalPen, plan.after.totalPen);
        if (difference !== null) {
          throw new BadRequestException(
            `El total del papel (S/ ${toDecimal(input.paperTotalPen).toFixed(2)}) no coincide con el de estas líneas (S/ ${toDecimal(plan.after.totalPen).toFixed(2)}): diferencia S/ ${difference}. Revisa el pedido o el papel; no se trajo el comprobante`,
          );
        }

        // Primero el estado y el pedido, condicionados: si otra transacción cambió cualquiera de
        // los dos, no se toca ninguna línea.
        const changed = await tx.fiscalDocument.updateMany({
          where: { id, status: FiscalDocumentStatus.ANNULLED, salesOrderId: p.source.id },
          data: {
            status: FiscalDocumentStatus.ACCEPTED,
            annulledAt: null,
            annulledById: null,
            annulReason: null,
            salesOrderId: p.target.id,
            subtotalPen: plan.after.subtotalPen,
            igvPen: plan.after.igvPen,
            totalPen: plan.after.totalPen,
          },
        });
        if (changed.count !== 1) {
          throw new ConflictException(`${label} cambió mientras se traía: vuelve a intentarlo`);
        }
        for (const u of plan.updates) {
          await tx.fiscalDocumentItem.update({
            where: { id: u.id },
            data: {
              productId: u.productId,
              // La fila pasa a facturar la línea del pedido destino (P1 de la revisión del
              // diseño): de esto leen la facturación por línea, el despacho y los reportes.
              salesOrderItemId: u.salesOrderItemId,
              description: u.description,
              unit: u.unit,
              qty: u.qty,
              unitPricePen: u.unitPricePen,
              subtotalPen: u.subtotalPen,
              igvPen: u.igvPen,
              totalPen: u.totalPen,
            },
          });
        }
        if (plan.creates.length > 0) {
          await tx.fiscalDocumentItem.createMany({
            data: plan.creates.map((c) => ({ documentId: id, ...c })),
          });
        }

        const from = { salesOrderId: p.source.id, salesOrderCode: p.sourceCode };
        const to = { salesOrderId: p.target.id, salesOrderCode: p.targetCode };
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'invoicing.document.move-to-order',
          entity: 'fiscal_documents',
          entityId: id,
          reason: input.reason,
          before: {
            status: FiscalDocumentStatus.ANNULLED,
            statusBeforeAnnul: p.statusBeforeAnnul,
            annulledAt: p.annulledAt.toISOString(),
            annulledById: document.annulledById,
            annulReason: document.annulReason,
            ...from,
            seller: p.sellerBefore,
            lines: plan.before.lines,
            // Qué fila era cada una y qué línea del pedido de origen facturaba.
            rows: document.items.map((i) => ({
              id: i.id,
              lineNumber: i.lineNumber,
              productId: i.productId,
              salesOrderItemId: i.salesOrderItemId,
            })),
            subtotalPen: plan.before.subtotalPen,
            igvPen: plan.before.igvPen,
            totalPen: plan.before.totalPen,
          },
          after: {
            status: FiscalDocumentStatus.ACCEPTED,
            reason: input.reason,
            number: document.number,
            issueDate: document.issueDate.toISOString().slice(0, 10),
            orderIssueDate: p.target.issue_date.toISOString().slice(0, 10),
            ...to,
            seller: p.sellerAfter,
            confirmedMatchesPaper: true,
            paperTotalPen: toDecimal(input.paperTotalPen).toFixed(2),
            lines: plan.after.lines,
            rows: [
              ...plan.updates.map((u) => ({
                id: u.id,
                productId: u.productId,
                salesOrderItemId: u.salesOrderItemId,
              })),
              ...plan.creates.map((c) => ({
                lineNumber: c.lineNumber,
                productId: c.productId,
                salesOrderItemId: c.salesOrderItemId,
              })),
            ],
            subtotalPen: plan.after.subtotalPen,
            igvPen: plan.after.igvPen,
            totalPen: plan.after.totalPen,
          },
        });
        // El historial de cada pedido cuenta qué pasó sin buscarlo en el comprobante.
        const moved = { documentId: id, number: document.number };
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'sales.order.document-moved-out',
          entity: 'sales_orders',
          entityId: p.source.id,
          reason: input.reason,
          before: { ...moved, ...from },
          after: { ...moved, ...to },
        });
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'sales.order.document-moved-in',
          entity: 'sales_orders',
          entityId: p.target.id,
          reason: input.reason,
          before: { ...moved, ...from },
          after: { ...moved, ...to },
        });
        return { id, number: document.number };
      },
      { timeout: REACTIVATION_TX_TIMEOUT_MS },
    );
  }

  /**
   * Los bloqueos y el plan, comunes a candidatos, vista previa y ejecución. Locks: comprobante
   * (`lockAnnulledForReactivation`), los dos pedidos **ordenados por id** (dos acciones cruzadas
   * no se esperan en orden inverso) y los borradores del destino; el mismo orden que D-378.
   */
  private async plan(tx: Prisma.TransactionClient, id: string, targetOrderId: string, lock = true) {
    const { document, label, statusBeforeAnnul, annulledAt } = await lockAnnulledForReactivation(
      tx,
      id,
      lock,
    );

    if (document.origin !== FiscalDocumentOrigin.MANUAL) {
      throw new BadRequestException(
        `${label} no es un comprobante manual: solo un manual se trae a otro pedido`,
      );
    }
    if (document.salesOrderId === null) {
      throw new BadRequestException(
        `${label} no es de un pedido: no hay un pedido de origen del que traerlo`,
      );
    }
    if (document.items.some((i) => i.salesOrderItemId === null)) {
      throw new BadRequestException(
        `${label} tiene líneas que no vienen del pedido: reescribirlo con las del pedido destino las perdería`,
      );
    }
    if (document.detractionCode !== null) {
      throw new BadRequestException(
        `${label} tiene detracción: su monto depende del total y no se recalcula al traerlo a otro pedido`,
      );
    }
    // El lock común frena las notas de crédito vivas o posteriores a la anulación. Una anterior,
    // ya anulada o rechazada, acredita líneas del pedido de origen: con el comprobante en otro
    // pedido quedaría un enlace cruzado entre los dos. Por prudencia, ninguna (autorrevisión del
    // diseño, P3).
    const anyCreditNote = await tx.fiscalDocument.count({ where: { affectedDocumentId: id } });
    if (anyCreditNote > 0) {
      throw new ConflictException(
        `${label} tiene notas de crédito (aunque no estén vivas): no se trae a otro pedido`,
      );
    }
    const sourceOrderId = document.salesOrderId;
    if (sourceOrderId === targetOrderId) {
      throw new BadRequestException(
        `${label} ya es de este pedido: usa «Reactivar» o «Reactivar con las líneas del pedido»`,
      );
    }

    const ids = [sourceOrderId, targetOrderId];
    const orders = lock
      ? await tx.$queryRaw<OrderRow[]>`
          SELECT "id", "status", "customer_id", "seq", "issue_date", "seller_id" FROM "sales_orders"
          WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR UPDATE
        `
      : await tx.$queryRaw<OrderRow[]>`
          SELECT "id", "status", "customer_id", "seq", "issue_date", "seller_id" FROM "sales_orders"
          WHERE "id" = ANY(${ids}::uuid[])
        `;
    const source = orders.find((o) => o.id === sourceOrderId);
    const target = orders.find((o) => o.id === targetOrderId);
    if (!source || !target) throw new NotFoundException('Pedido no encontrado');
    const sourceCode = salesOrderCode(source.seq);
    const targetCode = salesOrderCode(target.seq);

    // Decisión 2 del dueño: solo si el pedido de origen está anulado. Con el origen vivo, el
    // contenido se corrige en ese pedido y se reactiva con sus líneas (D-378).
    if (source.status !== SalesOrderStatus.CANCELLED) {
      throw new ConflictException(
        `El pedido de origen ${sourceCode} no está anulado: ${label} se trae a otro pedido solo si su pedido está anulado. Si el problema es el contenido, corrige ${sourceCode} y usa «Reactivar con las líneas del pedido»`,
      );
    }
    if (target.status === SalesOrderStatus.CANCELLED) {
      throw new ConflictException(
        `El pedido ${targetCode} está anulado: no se le trae un comprobante`,
      );
    }
    // Decisión 1 del dueño: el cliente es el RUC del papel y no se corrige.
    if (target.customer_id !== document.customerId) {
      throw new ConflictException(
        `El pedido ${targetCode} es de otro cliente: ${label} conserva el cliente del papel y no se trae a un pedido de otro cliente`,
      );
    }

    // Un despacho enlazado al comprobante (D-205/D-364) es de una línea del pedido de origen: con
    // el comprobante en otro pedido quedaría apuntando a una venta ajena, aunque esté revertido.
    const linked = await tx.dispatch.findMany({
      where: { invoiceId: id },
      select: { seq: true },
      orderBy: { seq: 'asc' },
    });
    if (linked.length > 0) {
      throw new ConflictException(
        `${label} tiene despachos enlazados (${linked.map((d) => dispatchCode(d.seq)).join(', ')}): no se trae a otro pedido`,
      );
    }
    // La anulación del pedido no revierte sus despachos: la mercadería salió por ese pedido.
    const liveSource = await tx.dispatch.findMany({
      where: { salesOrderId: sourceOrderId, status: DispatchStatus.ISSUED },
      select: { seq: true },
      orderBy: { seq: 'asc' },
    });
    if (liveSource.length > 0) {
      throw new ConflictException(
        `El pedido de origen ${sourceCode} tiene despachos vigentes (${liveSource.map((d) => dispatchCode(d.seq)).join(', ')}): la mercadería salió por ese pedido; revierte los despachos antes de traer ${label}`,
      );
    }

    const lineSelect = {
      id: true,
      lineNumber: true,
      productId: true,
      description: true,
      qty: true,
      unit: true,
      subtotalPen: true,
      igvPen: true,
      totalPen: true,
    } as const;
    const [targetLines, sourceLines] = await Promise.all([
      tx.salesOrderItem.findMany({
        where: { salesOrderId: targetOrderId },
        select: lineSelect,
        orderBy: { lineNumber: 'asc' },
      }),
      tx.salesOrderItem.findMany({
        where: { salesOrderId: sourceOrderId },
        select: { id: true, lineNumber: true },
      }),
    ]);
    const targetLineIds = targetLines.map((o) => o.id);

    // Los borradores del destino, con lock en orden de id (el mismo criterio que D-378).
    if (lock) {
      await tx.$queryRaw`
        SELECT d."id" FROM "fiscal_documents" d
        WHERE d."status" = 'DRAFT' AND d."id" <> ${id}::uuid
          AND (
            d."sales_order_id" = ${targetOrderId}::uuid
            OR EXISTS (
              SELECT 1 FROM "fiscal_document_items" i
              WHERE i."document_id" = d."id" AND i."sales_order_item_id" = ANY(${targetLineIds}::uuid[])
            )
          )
        ORDER BY d."id"
        FOR UPDATE
      `;
    }
    const onTarget = {
      id: { not: id },
      archivedAt: null,
      docType: { in: [...REACTIVATABLE_DOC_TYPES] },
      OR: [
        { salesOrderId: targetOrderId },
        { items: { some: { salesOrderItemId: { in: targetLineIds } } } },
      ],
    } satisfies Prisma.FiscalDocumentWhereInput;
    const others = await tx.fiscalDocument.findMany({
      where: { ...onTarget, status: { in: [...SHARED_LIVE_DOCUMENT_STATUSES] } },
      select: { number: true },
      orderBy: { number: 'asc' },
    });
    if (others.length > 0) {
      throw new ConflictException(
        `El pedido ${targetCode} tiene otro comprobante vivo (${others
          .map((o) => o.number ?? 'sin número')
          .join(
            ', ',
          )}): con las líneas del pedido, ${label} facturaría dos veces lo que ese ya factura. Decide cuál queda antes de traerlo`,
      );
    }
    const drafts = await tx.fiscalDocument.count({
      where: { ...onTarget, status: FiscalDocumentStatus.DRAFT },
    });
    if (drafts > 0) {
      throw new ConflictException(
        `El pedido ${targetCode} tiene ${String(drafts)} borrador(es) de comprobante: elimínalo(s) primero y vuelve a intentarlo`,
      );
    }

    const { pairing, unpaired } = pairRowsToOrder(document.items, targetLines);
    if (unpaired.length > 0) {
      throw new ConflictException(
        `El pedido ${targetCode} tiene ${String(targetLines.length)} línea(s) y ${label} tiene ${String(document.items.length)}: no se borra ninguna línea del comprobante. Agrega al pedido lo que falta`,
      );
    }
    const plan = planOrderLines(document.items, targetLines, document, {
      pairing,
      sourceOrderLines: sourceLines,
    });

    // D-077, como en D-378: traer el comprobante no es el gesto de forzar el tope.
    const customer = await tx.customer.findUnique({
      where: { id: document.customerId },
      select: { isSystem: true },
    });
    const cap = toDecimal(GENERIC_CUSTOMER_MAX_TOTAL_PEN);
    if (
      customer?.isSystem === true &&
      toDecimal(plan.after.totalPen).gt(cap) &&
      !toDecimal(plan.before.totalPen).gt(cap)
    ) {
      throw new BadRequestException(
        `Con las líneas del pedido ${targetCode}, ${label} pasaría de S/ ${cap.toFixed(2)}, el tope de una boleta a «público en general»: no se trae así`,
      );
    }

    const sellerIds = [
      ...new Set([source.seller_id, target.seller_id].filter((s): s is string => s !== null)),
    ];
    const sellers =
      sellerIds.length > 0
        ? await tx.user.findMany({
            where: { id: { in: sellerIds } },
            select: { id: true, name: true },
          })
        : [];
    const sellerOf = (sellerId: string | null) => ({
      id: sellerId,
      name: sellerId ? (sellers.find((s) => s.id === sellerId)?.name ?? null) : null,
    });

    const paperDay = dayLabel(document.issueDate);
    const warnings: string[] = [];
    // Decisión 3 del dueño: se permite, con aviso, y se conserva la fecha del papel.
    if (document.issueDate.getTime() < target.issue_date.getTime()) {
      warnings.push(
        `El comprobante (${paperDay}) es anterior al pedido ${targetCode} (${dayLabel(target.issue_date)}): se conserva la fecha del papel`,
      );
    }
    warnings.push(
      `Despachar desde el comprobante usa la fecha del papel (${paperDay}). Si a esa fecha no había stock, el despacho no se fuerza en negativo: se sigue D-374 (corregir la fecha de recepción de la compra o despachar en la primera fecha válida posterior)`,
    );

    return {
      document,
      plan,
      label,
      statusBeforeAnnul,
      annulledAt,
      source,
      target,
      sourceCode,
      targetCode,
      sellerBefore: sellerOf(source.seller_id),
      sellerAfter: sellerOf(target.seller_id),
      warnings,
    };
  }
}
