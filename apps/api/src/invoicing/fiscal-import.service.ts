import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FiscalDocType,
  FiscalDocumentOrigin,
  FiscalDocumentStatus,
  Role,
  type Prisma,
} from '@prisma/client';
import {
  Decimal,
  LIVE_DOCUMENT_STATUSES as SHARED_LIVE_DOCUMENT_STATUSES,
  salesOrderCode,
  toDecimal,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { invoicedByOrderItem } from './invoicing-net';

/**
 * La anulación **interna** de un comprobante que el ERP no emitió electrónicamente
 * (D-110, ampliada por D-153).
 *
 * Este servicio nació con la importación de comprobantes ya emitidos y quedó reducido a su
 * salida cuando D-150 borró esa puerta. D-153 le devolvió un segundo usuario y con él su razón
 * de ser permanente: mientras dure la migración desde la otra app, **todos los días entran
 * comprobantes manuales**, y uno mal registrado necesita vuelta.
 *
 * La regla es una sola y se lee en el guardrail: alcanza a todo lo que el ERP **no** emitió
 * —`MANUAL` e `IMPORTED`— y a nada de lo que sí. Un comprobante que el ERP mandó a SUNAT se
 * deshace ante SUNAT, por la baja o por una nota de crédito; uno que salió de otro sistema no
 * tiene ese camino desde acá, y sin este método su cuenta por cobrar sería deuda falsa
 * permanente.
 *
 * El estado es `ANNULLED` y no `VOIDED` a propósito: `VOIDED` afirmaría ante una auditoría
 * que SUNAT aceptó una baja que nunca ocurrió.
 */
@Injectable()
export class FiscalImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Anula internamente un comprobante que el ERP no emitió (D-110/D-153): deja de deber en las
   * tres lecturas de deuda —su propio saldo, el listado y las cuentas por cobrar— sin decir
   * que SUNAT intervino.
   */
  async annulExternal(
    actor: RequestUser,
    id: string,
    reason: string,
  ): Promise<{ id: string; number: string | null }> {
    return this.prisma.$transaction(async (tx) => {
      // El lock va antes de leer, igual que en `addPayment` y en la nota de crédito: sin él,
      // un cobro que entra mientras se decide la anulación queda colgado de un comprobante
      // que dejó de deber, y el guardrail de abajo no lo habría visto.
      await tx.$queryRaw`
        SELECT "id" FROM "fiscal_documents" WHERE "id" = ${id}::uuid FOR UPDATE
      `;
      const document = await tx.fiscalDocument.findUnique({
        where: { id },
        select: {
          id: true,
          number: true,
          origin: true,
          status: true,
          totalPen: true,
          archivedAt: true,
        },
      });
      if (!document) throw new NotFoundException('Comprobante no encontrado');

      // D-153: la anulación interna cubre **todo lo que el ERP no emitió electrónicamente** —
      // lo importado y lo manual—, y sigue sin alcanzar a lo que sí emitió: eso se deshace ante
      // SUNAT, por la baja o por una nota de crédito, que es lo único que SUNAT reconoce.
      if (document.origin === FiscalDocumentOrigin.ISSUED_HERE) {
        throw new BadRequestException(
          'Este comprobante lo emitió el ERP: se deshace con una baja o una nota de crédito ante SUNAT, no con una anulación interna',
        );
      }
      // Idempotencia explícita (D-052): un segundo intento no vuelve a anular ni finge que
      // hizo algo. 409 y no 400 porque el estado del recurso es el que impide la operación.
      if (document.status === FiscalDocumentStatus.ANNULLED) {
        throw new ConflictException(`El comprobante ${document.number ?? ''} ya está anulado`);
      }
      if (document.status !== FiscalDocumentStatus.ACCEPTED) {
        throw new BadRequestException(
          `Solo se anula un comprobante vigente; este está ${document.status}`,
        );
      }
      // Una versión archivada (RF-72) ya salió de todas las cuentas: anularla no cambiaría
      // ningún saldo y solo agregaría un estado terminal a una fila que es historial.
      if (document.archivedAt !== null) {
        throw new BadRequestException(
          'Esta versión ya fue reemplazada por una reimportación posterior: anula la vigente',
        );
      }

      // Los dos guardrails de `voidDocument`, por el mismo motivo y en el mismo orden: un
      // cobro vigente es dinero recibido —anular el comprobante lo dejaría sin causa— y una
      // nota de crédito viva ya ajustó este saldo por el otro camino.
      const payments = await tx.customerPayment.count({
        where: { documentId: id, reversedAt: null },
      });
      if (payments > 0) {
        throw new BadRequestException(
          'El comprobante tiene cobros vigentes: revierte los cobros antes de anularlo',
        );
      }
      const creditNotes = await tx.fiscalDocument.findMany({
        where: {
          affectedDocumentId: id,
          status: { in: [...SHARED_LIVE_DOCUMENT_STATUSES] },
          archivedAt: null,
        },
        select: { number: true },
      });
      if (creditNotes.length > 0) {
        throw new BadRequestException(
          `El comprobante tiene notas de crédito vivas (${creditNotes
            .map((n) => n.number ?? 'sin número')
            .join(', ')}): anúlalas primero`,
        );
      }

      const updated = await tx.fiscalDocument.update({
        where: { id },
        data: {
          status: FiscalDocumentStatus.ANNULLED,
          annulledAt: new Date(),
          annulledById: actor.id,
          annulReason: reason,
        },
        select: { id: true, number: true },
      });

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'invoicing.import.annul',
        entity: 'fiscal_documents',
        entityId: id,
        before: { status: document.status, totalPen: document.totalPen.toFixed(4) },
        after: { status: FiscalDocumentStatus.ANNULLED, reason, number: document.number },
      });
      return updated;
    });
  }

  /**
   * D-373: deshace una anulación interna hecha **por error**. La anulación solo cambió el estado
   * (no tocó kardex, reservas, cobros ni despachos), así que reactivar es devolver el estado
   * `ACCEPTED`; lo que hay que comprobar es lo que otros pudieron hacer mientras estuvo anulado.
   *
   * Los `CHECK` de la fila obligan a vaciar `annulled_at`, `annulled_by_id` y `annul_reason` al
   * volver a `ACCEPTED`: la constancia de la anulación queda en la auditoría, que guarda una
   * copia de esos campos (sin migración).
   *
   * No despacha nada: el comprobante vuelve a «sin despacho declarado» y se despacha aparte
   * con D-364, a la fecha del comprobante.
   */
  async reactivateExternal(
    actor: RequestUser,
    id: string,
    input: { reason: string; confirmStillValid: boolean },
  ): Promise<{ id: string; number: string | null }> {
    if (actor.role !== Role.ADMINISTRADOR) {
      throw new ForbiddenException('Solo un administrador puede reactivar un comprobante anulado');
    }
    if (!input.confirmStillValid) {
      throw new BadRequestException(
        'Confirma que el comprobante sigue vigente en Nubefact/SUNAT (que no se comunicó su baja) antes de reactivarlo',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // El mismo lock que la anulación: una anulación, una reactivación o un cobro simultáneos
      // sobre esta fila esperan a que esta transacción termine y ven el estado ya cambiado.
      await tx.$queryRaw`
        SELECT "id" FROM "fiscal_documents" WHERE "id" = ${id}::uuid FOR UPDATE
      `;
      const document = await tx.fiscalDocument.findUnique({
        where: { id },
        select: {
          id: true,
          number: true,
          origin: true,
          status: true,
          archivedAt: true,
          annulledAt: true,
          annulledById: true,
          annulReason: true,
          sendAttempts: true,
          lastAttemptAt: true,
          providerTicket: true,
          providerResponse: true,
          sunatHash: true,
          xmlKey: true,
          cdrKey: true,
          voidRequestedAt: true,
          voidedAt: true,
          salesOrder: { select: { seq: true } },
          items: { select: { qty: true, salesOrderItemId: true } },
        },
      });
      if (!document) throw new NotFoundException('Comprobante no encontrado');
      const label = document.number ?? 'El comprobante';

      if (document.origin === FiscalDocumentOrigin.ISSUED_HERE) {
        throw new BadRequestException(
          'Este comprobante lo emitió el ERP: no se reactiva desde acá, se resuelve ante SUNAT',
        );
      }
      // Idempotencia de una transición de estado (D-182): el segundo intento ve el estado ya
      // cambiado y no repite nada.
      if (document.status === FiscalDocumentStatus.ACCEPTED) {
        throw new ConflictException(`${label} ya está vigente`);
      }
      if (document.status !== FiscalDocumentStatus.ANNULLED || document.annulledAt === null) {
        throw new BadRequestException(
          `Solo se reactiva un comprobante anulado; este está ${document.status}`,
        );
      }
      if (document.archivedAt !== null) {
        throw new BadRequestException(
          'Esta versión ya fue reemplazada por una reimportación posterior: no se reactiva',
        );
      }

      // Un manual o importado nunca habla con el PSE. Cualquier rastro de envío o de baja dice
      // que este documento tuvo otra vida fuera del ERP, y reactivarlo afirmaría algo que no
      // sabemos.
      if (
        document.sendAttempts > 0 ||
        document.lastAttemptAt !== null ||
        document.providerTicket !== null ||
        document.providerResponse !== null ||
        document.sunatHash !== null ||
        document.xmlKey !== null ||
        document.cdrKey !== null ||
        document.voidRequestedAt !== null ||
        document.voidedAt !== null
      ) {
        throw new BadRequestException(
          `${label} tiene rastro de envío al PSE o de comunicación de baja: no se reactiva desde acá`,
        );
      }

      // El estado anterior a la anulación sale de su auditoría. La anulación solo acepta
      // `ACCEPTED`, pero se lee igual: es la copia que la reactivación guarda.
      const annulEvent = await tx.auditLog.findFirst({
        where: { entity: 'fiscal_documents', entityId: id, action: 'invoicing.import.annul' },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        select: { before: true },
      });
      const statusBeforeAnnul = statusOf(annulEvent?.before);
      if (statusBeforeAnnul !== FiscalDocumentStatus.ACCEPTED) {
        throw new BadRequestException(
          `${label} no tiene en la auditoría una anulación desde «aceptado»: no se puede reactivar`,
        );
      }

      const annulledAt = document.annulledAt;
      const payments = await tx.customerPayment.count({
        where: {
          documentId: id,
          OR: [{ reversedAt: null }, { createdAt: { gt: annulledAt } }],
        },
      });
      if (payments > 0) {
        throw new BadRequestException(
          `${label} tiene cobros vigentes o registrados después de su anulación: revísalos antes de reactivarlo`,
        );
      }
      const creditNotes = await tx.fiscalDocument.findMany({
        where: {
          affectedDocumentId: id,
          archivedAt: null,
          OR: [
            { status: { in: [...SHARED_LIVE_DOCUMENT_STATUSES] } },
            { createdAt: { gt: annulledAt } },
          ],
        },
        select: { number: true },
      });
      if (creditNotes.length > 0) {
        throw new BadRequestException(
          `${label} tiene notas de crédito vivas o posteriores a su anulación (${creditNotes
            .map((n) => n.number ?? 'borrador')
            .join(', ')}): no se reactiva`,
        );
      }

      const orderItemIds = [
        ...new Set(document.items.flatMap((i) => (i.salesOrderItemId ? [i.salesOrderItemId] : []))),
      ];
      if (orderItemIds.length > 0) {
        await assertLinesNotReinvoiced(tx, id, label, document.items, orderItemIds);
        const drafts = await tx.fiscalDocument.count({
          where: {
            id: { not: id },
            status: FiscalDocumentStatus.DRAFT,
            items: { some: { salesOrderItemId: { in: orderItemIds } } },
          },
        });
        if (drafts > 0) {
          const order = document.salesOrder
            ? ` del pedido ${salesOrderCode(document.salesOrder.seq)}`
            : '';
          throw new ConflictException(
            `Hay ${String(drafts)} borrador(es) de comprobante sobre las mismas líneas${order}: elimínalo(s) primero y vuelve a reactivar`,
          );
        }
      }

      // Verificación de versión además del lock: solo cambia si sigue anulado.
      const changed = await tx.fiscalDocument.updateMany({
        where: { id, status: FiscalDocumentStatus.ANNULLED },
        data: {
          status: FiscalDocumentStatus.ACCEPTED,
          annulledAt: null,
          annulledById: null,
          annulReason: null,
        },
      });
      if (changed.count !== 1) {
        throw new ConflictException(`${label} cambió mientras se reactivaba: vuelve a intentarlo`);
      }

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'invoicing.document.reactivate',
        entity: 'fiscal_documents',
        entityId: id,
        reason: input.reason,
        // La copia de lo que la fila deja de guardar (D-373): sin esto, la anulación solo
        // quedaría en su propio evento y nada diría que se deshizo.
        before: {
          status: FiscalDocumentStatus.ANNULLED,
          statusBeforeAnnul,
          annulledAt: annulledAt.toISOString(),
          annulledById: document.annulledById,
          annulReason: document.annulReason,
        },
        after: {
          status: FiscalDocumentStatus.ACCEPTED,
          reason: input.reason,
          number: document.number,
          confirmedStillValid: true,
        },
      });
      return { id, number: document.number };
    });
  }
}

/** El `status` de un `before` de auditoría, si lo trae. */
function statusOf(json: Prisma.JsonValue | undefined): string | null {
  if (json === null || json === undefined || typeof json !== 'object' || Array.isArray(json)) {
    return null;
  }
  const status = json.status;
  return typeof status === 'string' ? status : null;
}

/**
 * D-373: si otro comprobante vivo facturó las líneas mientras este estuvo anulado, reactivarlo
 * las facturaría dos veces. La misma cuenta que `assertStillAvailable` al emitir, con un mensaje
 * que nombra a los comprobantes que las tomaron.
 */
async function assertLinesNotReinvoiced(
  tx: Prisma.TransactionClient,
  id: string,
  label: string,
  items: readonly { qty: Prisma.Decimal; salesOrderItemId: string | null }[],
  orderItemIds: readonly string[],
): Promise<void> {
  const [orderItems, invoiced] = await Promise.all([
    tx.salesOrderItem.findMany({
      where: { id: { in: [...orderItemIds] } },
      select: { id: true, lineNumber: true, qty: true },
    }),
    invoicedByOrderItem(tx, orderItemIds, { excludeDocumentId: id }),
  ]);
  const requested = new Map<string, Decimal>();
  for (const item of items) {
    if (!item.salesOrderItemId) continue;
    requested.set(
      item.salesOrderItemId,
      (requested.get(item.salesOrderItemId) ?? new Decimal(0)).plus(toDecimal(item.qty.toString())),
    );
  }
  const overflowing = orderItems.filter((o) => {
    const available = toDecimal(o.qty.toString()).minus(invoiced.get(o.id)?.qty ?? new Decimal(0));
    return (requested.get(o.id) ?? new Decimal(0)).gt(available);
  });
  if (overflowing.length === 0) return;

  const others = await tx.fiscalDocument.findMany({
    where: {
      id: { not: id },
      archivedAt: null,
      status: { in: [...SHARED_LIVE_DOCUMENT_STATUSES] },
      docType: { not: FiscalDocType.NOTA_CREDITO },
      items: { some: { salesOrderItemId: { in: overflowing.map((o) => o.id) } } },
    },
    select: { number: true },
  });
  const lines = overflowing.map((o) => String(o.lineNumber)).join(', ');
  const names = others.map((o) => o.number ?? 'sin número').join(', ');
  const where = names ? ` en ${names}` : '';
  throw new ConflictException(
    overflowing.length === 1
      ? `La línea ${lines} del pedido ya se volvió a facturar${where}: reactivar ${label} la facturaría dos veces`
      : `Las líneas ${lines} del pedido ya se volvieron a facturar${where}: reactivar ${label} las facturaría dos veces`,
  );
}
