import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FiscalDocType,
  FiscalDocumentOrigin,
  FiscalDocumentStatus,
  Role,
  SalesOrderStatus,
  type Prisma,
} from '@prisma/client';
import {
  Decimal,
  GENERIC_CUSTOMER_MAX_TOTAL_PEN,
  LIVE_DOCUMENT_STATUSES as SHARED_LIVE_DOCUMENT_STATUSES,
  salesOrderCode,
  toDecimal,
  type OrderAnnulledDocumentDto,
  type ReactivationAvailabilityDto,
  type ReactivationPreviewDto,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { invoicedByOrderItem } from './invoicing-net';
import { paperTotalDifference, planOrderLines } from './reactivate-order-lines';

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
    assertCanReactivate(actor);
    if (!input.confirmStillValid) {
      throw new BadRequestException(
        'Confirma que el comprobante sigue vigente en Nubefact/SUNAT (que no se comunicó su baja) antes de reactivarlo',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const checked = await this.checkReactivateExternal(tx, id);
      return this.writeReactivateExternal(tx, actor, id, input, checked);
    });
  }

  /**
   * UAT de cc13: los comprobantes anulados de un pedido, cada uno con si aplican sus dos
   * reactivaciones (D-373 y D-378) y, si no, el motivo —el mismo mensaje que daría intentarla—.
   *
   * **Sin bloqueos y sin transacción** (pedido del dueño): es lectura simple para pintar la
   * sección del pedido. Corre las mismas comprobaciones con `lock = false`; el modal de D-378 y
   * las dos ejecuciones las vuelven a correr con sus `FOR UPDATE`. La parte común (comprobante,
   * auditoría, cobros, notas de crédito) se lee una vez por comprobante y la usan las dos.
   *
   * Presupuesto (llamadas a Prisma, verificado por test): 2 fijas (anulados y nombres de quien
   * anuló) y, por anulado, 4 comunes + hasta 5 de D-378 + hasta 7 de D-373 (más 1 si hay
   * refacturadas que nombrar). En SQL reales son 2 más por anulado: la lectura del comprobante
   * trae `salesOrder` e `items` en consultas aparte. Medido en demo el 2026-10-02: 19 SQL para un
   * pedido con un anulado (17 por el anulado, con D-378 bloqueada por «sin cambios»; hasta 18 si
   * aplican las dos), 0 `FOR UPDATE`. El detalle de un pedido **sin** anulados no llama a esto:
   * lo decide `annulledDocumentCount` del pedido, que sale de la consulta que el detalle ya hacía.
   */
  async annulledOfOrder(
    actor: RequestUser,
    salesOrderId: string,
  ): Promise<OrderAnnulledDocumentDto[]> {
    assertCanReactivate(actor);
    const docs = await this.prisma.fiscalDocument.findMany({
      // El mismo corte que `annulledDocumentCount` del pedido (`orderDocuments`): la sección
      // muestra exactamente los que ese número cuenta.
      where: {
        salesOrderId,
        status: FiscalDocumentStatus.ANNULLED,
        archivedAt: null,
        docType: {
          in: [FiscalDocType.FACTURA, FiscalDocType.BOLETA, FiscalDocType.NOTA_CREDITO],
        },
      },
      select: {
        id: true,
        number: true,
        docType: true,
        origin: true,
        status: true,
        issueDate: true,
        totalPen: true,
        salesOrderId: true,
        archivedAt: true,
        annulledAt: true,
        annulledById: true,
        annulReason: true,
      },
      orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
    });
    if (docs.length === 0) return [];
    const annulledByIds = [
      ...new Set(docs.flatMap((d) => (d.annulledById ? [d.annulledById] : []))),
    ];
    const users =
      annulledByIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: annulledByIds } },
            select: { id: true, name: true },
          })
        : [];
    const names = new Map(users.map((u) => [u.id, u.name]));

    // Lecturas simples, una por vez: sin transacción, el cliente de Prisma vale como `tx`.
    const reader: Prisma.TransactionClient = this.prisma;
    const out: OrderAnnulledDocumentDto[] = [];
    for (const d of docs) {
      let common: AnnulledForReactivation | null = null;
      let commonBlock: string | null = null;
      try {
        common = await lockAnnulledForReactivation(reader, d.id, false);
      } catch (error) {
        commonBlock = blockReason(error);
      }
      const withOrderLines = common
        ? await availability(() => this.planReactivationWithOrderLines(reader, d.id, false, common))
        : { ok: false, reason: commonBlock };
      const simple = common
        ? await availability(() => this.checkReactivateExternal(reader, d.id, false, common))
        : { ok: false, reason: commonBlock };
      out.push({
        id: d.id,
        number: d.number,
        docType: d.docType,
        origin: d.origin,
        status: d.status,
        issueDate: d.issueDate.toISOString().slice(0, 10),
        totalPen: d.totalPen.toFixed(4),
        salesOrderId: d.salesOrderId,
        archivedAt: d.archivedAt?.toISOString() ?? null,
        annulledAt: d.annulledAt?.toISOString() ?? null,
        annulledByName: d.annulledById ? (names.get(d.annulledById) ?? null) : null,
        annulReason: d.annulReason,
        withOrderLines,
        simple,
      });
    }
    return out;
  }

  /**
   * D-373: el lock y todos los bloqueos de la reactivación simple; no escribe nada. Sin `lock`, la
   * misma comprobación como lectura simple (la sección del pedido); `common` reutiliza la parte
   * común ya leída para no repetir sus consultas.
   */
  private async checkReactivateExternal(
    tx: Prisma.TransactionClient,
    id: string,
    lock = true,
    common?: AnnulledForReactivation,
  ) {
    const checked = common ?? (await lockAnnulledForReactivation(tx, id, lock));
    const { document, label, annulledAt } = checked;
    const orderItemIds = [
      ...new Set(document.items.flatMap((i) => (i.salesOrderItemId ? [i.salesOrderItemId] : []))),
    ];
    if (orderItemIds.length > 0) {
      // Revisiones cc07 (carrera con el reingreso). Dos locks más, en este orden —comprobante,
      // pedido, borradores— y ningún camino los toma al revés:
      // - el **pedido**, el mismo que toman la creación de un borrador y las ediciones del
      //   pedido (D-187): no puede nacer un borrador nuevo sobre estas líneas hasta el commit;
      // - los **borradores** que ya existen sobre estas líneas, en orden de id: si uno se está
      //   registrando o emitiendo ahora (que bloquean solo su propia fila), esto espera a su
      //   commit, y los chequeos de abajo —sentencias nuevas en READ COMMITTED— ya lo ven
      //   aceptado.
      if (document.salesOrderId !== null) {
        // Con `lock`, el SQL de siempre; sin él, la misma lectura sin `FOR UPDATE`.
        const [order] = lock
          ? await tx.$queryRaw<{ status: string }[]>`
            SELECT "status" FROM "sales_orders" WHERE "id" = ${document.salesOrderId}::uuid FOR UPDATE
          `
          : await tx.$queryRaw<{ status: string }[]>`
            SELECT "status" FROM "sales_orders" WHERE "id" = ${document.salesOrderId}::uuid
          `;
        // D-373 (decisión del dueño): el pedido no pudo cambiar mientras el comprobante estuvo
        // anulado. Se lee con el pedido ya bloqueado, así que una edición no puede colarse.
        const orderLabel = document.salesOrder
          ? `El pedido ${salesOrderCode(document.salesOrder.seq)}`
          : 'El pedido';
        if (order?.status === SalesOrderStatus.CANCELLED) {
          throw new ConflictException(
            `${orderLabel} está anulado: no se reactiva un comprobante de un pedido anulado`,
          );
        }
        await assertOrderLinesUnchanged(
          tx,
          document.salesOrderId,
          orderItemIds,
          annulledAt,
          label,
          orderLabel,
        );
      }
      if (lock) {
        await tx.$queryRaw`
          SELECT d."id" FROM "fiscal_documents" d
          WHERE d."status" = 'DRAFT' AND d."id" <> ${id}::uuid
            AND EXISTS (
              SELECT 1 FROM "fiscal_document_items" i
              WHERE i."document_id" = d."id" AND i."sales_order_item_id" = ANY(${orderItemIds}::uuid[])
            )
          ORDER BY d."id"
          FOR UPDATE
        `;
      }
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
    return checked;
  }

  /** D-373: la escritura de la reactivación simple, después de `checkReactivateExternal`. */
  private async writeReactivateExternal(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    id: string,
    input: { reason: string },
    checked: Awaited<ReturnType<typeof lockAnnulledForReactivation>>,
  ): Promise<{ id: string; number: string | null }> {
    const { document, label, statusBeforeAnnul, annulledAt } = checked;
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
  }

  /**
   * D-378: la vista previa de «Reactivar con las líneas actuales del pedido». Pasa por los mismos
   * bloqueos que la reactivación —con sus locks, en una transacción que no escribe— y devuelve el
   * antes y el después. Si algo bloquea, responde el mismo error que daría reactivar.
   */
  async previewReactivationWithOrderLines(
    actor: RequestUser,
    id: string,
  ): Promise<ReactivationPreviewDto> {
    assertCanReactivate(actor);
    // Revisión cc13 (P2-3, aceptado): la vista previa toma los mismos locks que la reactivación.
    // Es una transacción corta y sin escrituras, y así no puede haber un bloqueo que la vista
    // previa no muestre y la reactivación sí; la reactivación vuelve a comprobar todo igual.
    return this.prisma.$transaction(
      async (tx) => {
        const { document, plan, orderCode } = await this.planReactivationWithOrderLines(tx, id);
        return {
          id,
          number: document.number,
          salesOrderCode: orderCode,
          before: plan.before,
          after: plan.after,
        };
      },
      { timeout: REACTIVATION_TX_TIMEOUT_MS },
    );
  }

  /**
   * D-378: reactiva un comprobante **manual** anulado reemplazando sus líneas por las del pedido
   * entero, conservando número, serie, correlativo, fecha de emisión y cliente. El caso de uso:
   * el papel está bien y al pedido le faltaron ítems; con el comprobante anulado se agregan al
   * pedido y se reactiva.
   *
   * Solo reactiva si el **total del papel tipeado** coincide al céntimo con el de las líneas
   * nuevas. Como D-373, no escribe kardex, reservas, cobros ni despachos: las líneas agregadas
   * quedan pendientes de despacho y las originales conservan el suyo (el despacho se enlaza al
   * comprobante, cuyo id no cambia, y lo pendiente se cuenta por línea de pedido).
   */
  async reactivateWithOrderLines(
    actor: RequestUser,
    id: string,
    input: { reason: string; confirmMatchesPaper: boolean; paperTotalPen: string },
  ): Promise<{ id: string; number: string | null }> {
    assertCanReactivate(actor);
    if (!input.confirmMatchesPaper) {
      throw new BadRequestException(
        'Confirma que el comprobante, con estas líneas, coincide con el papel vigente antes de reactivarlo',
      );
    }

    return this.prisma.$transaction(
      async (tx) => {
        const { document, plan, label, statusBeforeAnnul, annulledAt } =
          await this.planReactivationWithOrderLines(tx, id);

        // El control del dueño: el papel manda. Al céntimo, que es la escala del papel (D-377).
        const difference = paperTotalDifference(input.paperTotalPen, plan.after.totalPen);
        if (difference !== null) {
          throw new BadRequestException(
            `El total del papel (S/ ${toDecimal(input.paperTotalPen).toFixed(2)}) no coincide con el de estas líneas (S/ ${toDecimal(plan.after.totalPen).toFixed(2)}): diferencia S/ ${difference}. Revisa el pedido o el papel; no se reactivó`,
          );
        }

        // Primero el estado, condicionado: si otra transacción lo cambió, no se toca ninguna línea.
        const changed = await tx.fiscalDocument.updateMany({
          where: { id, status: FiscalDocumentStatus.ANNULLED },
          data: {
            status: FiscalDocumentStatus.ACCEPTED,
            annulledAt: null,
            annulledById: null,
            annulReason: null,
            subtotalPen: plan.after.subtotalPen,
            igvPen: plan.after.igvPen,
            totalPen: plan.after.totalPen,
          },
        });
        if (changed.count !== 1) {
          throw new ConflictException(
            `${label} cambió mientras se reactivaba: vuelve a intentarlo`,
          );
        }
        for (const u of plan.updates) {
          await tx.fiscalDocumentItem.update({
            where: { id: u.id },
            data: {
              productId: u.productId,
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

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'invoicing.document.reactivate-with-order-lines',
          entity: 'fiscal_documents',
          entityId: id,
          reason: input.reason,
          // Las líneas y la cabecera de antes son lo único que la fila deja de guardar: el
          // cliente compara contra el papel, y la historia es append-only (RF-95).
          before: {
            status: FiscalDocumentStatus.ANNULLED,
            statusBeforeAnnul,
            annulledAt: annulledAt.toISOString(),
            annulledById: document.annulledById,
            annulReason: document.annulReason,
            lines: plan.before.lines,
            // Autorrevisión cc13 (P3-10): qué fila es cada una y a qué producto apuntaba.
            rows: document.items.map((i) => ({
              id: i.id,
              lineNumber: i.lineNumber,
              productId: i.productId,
            })),
            subtotalPen: plan.before.subtotalPen,
            igvPen: plan.before.igvPen,
            totalPen: plan.before.totalPen,
          },
          after: {
            status: FiscalDocumentStatus.ACCEPTED,
            reason: input.reason,
            number: document.number,
            confirmedMatchesPaper: true,
            paperTotalPen: toDecimal(input.paperTotalPen).toFixed(2),
            lines: plan.after.lines,
            rows: [
              ...plan.updates.map((u) => ({ id: u.id, productId: u.productId })),
              ...plan.creates.map((c) => ({ lineNumber: c.lineNumber, productId: c.productId })),
            ],
            subtotalPen: plan.after.subtotalPen,
            igvPen: plan.after.igvPen,
            totalPen: plan.after.totalPen,
          },
        });
        return { id, number: document.number };
      },
      { timeout: REACTIVATION_TX_TIMEOUT_MS },
    );
  }

  /**
   * D-378: los bloqueos y el plan, comunes a la vista previa y a la reactivación. Locks en el
   * mismo orden que D-373 —comprobante, pedido, borradores— y ningún camino los toma al revés.
   */
  private async planReactivationWithOrderLines(
    tx: Prisma.TransactionClient,
    id: string,
    lock = true,
    common?: AnnulledForReactivation,
  ) {
    const { document, label, statusBeforeAnnul, annulledAt } =
      common ?? (await lockAnnulledForReactivation(tx, id, lock));

    // Solo manual: un importado es la copia de otro sistema y su contenido no se reescribe
    // desde acá; un `ISSUED_HERE` ya lo frenó el lock común.
    if (document.origin !== FiscalDocumentOrigin.MANUAL) {
      throw new BadRequestException(
        `${label} no es un comprobante manual: con las líneas del pedido solo se reactiva un manual`,
      );
    }
    if (document.salesOrderId === null) {
      throw new BadRequestException(
        `${label} no es de un pedido: no hay líneas de pedido con las que reactivarlo`,
      );
    }
    if (document.items.some((i) => i.salesOrderItemId === null)) {
      throw new BadRequestException(
        `${label} tiene líneas que no vienen del pedido: reescribirlo con las del pedido las perdería`,
      );
    }
    const itemIds = document.items.map((i) => i.salesOrderItemId);
    if (new Set(itemIds).size !== itemIds.length) {
      throw new BadRequestException(
        `${label} factura una misma línea del pedido en más de una línea: no se reescribe automáticamente`,
      );
    }
    // Decisión 4 del dueño: el monto de la detracción es del total viejo, y no se inventa uno.
    if (document.detractionCode !== null) {
      throw new BadRequestException(
        `${label} tiene detracción: su monto depende del total y no se recalcula al reactivar con las líneas del pedido`,
      );
    }

    const salesOrderId = document.salesOrderId;
    interface OrderRow {
      status: string;
      customer_id: string;
      seq: number;
    }
    const [order] = lock
      ? await tx.$queryRaw<OrderRow[]>`
          SELECT "status", "customer_id", "seq" FROM "sales_orders"
          WHERE "id" = ${salesOrderId}::uuid FOR UPDATE
        `
      : await tx.$queryRaw<OrderRow[]>`
          SELECT "status", "customer_id", "seq" FROM "sales_orders"
          WHERE "id" = ${salesOrderId}::uuid
        `;
    if (!order) throw new NotFoundException('Pedido no encontrado');
    const orderCode = salesOrderCode(order.seq);
    if (order.status === SalesOrderStatus.CANCELLED) {
      throw new ConflictException(
        `El pedido ${orderCode} está anulado: no se reactiva un comprobante de un pedido anulado`,
      );
    }
    // D-378: el cliente del comprobante es el del papel, y se conserva. Si el pedido cambió de
    // cliente mientras estuvo anulado, las líneas del pedido ya son de otra venta.
    if (order.customer_id !== document.customerId) {
      throw new ConflictException(
        `El pedido ${orderCode} cambió de cliente después de anular ${label}: no se reactiva con sus líneas`,
      );
    }

    const orderLines = await tx.salesOrderItem.findMany({
      where: { salesOrderId },
      select: {
        id: true,
        lineNumber: true,
        productId: true,
        description: true,
        qty: true,
        unit: true,
        subtotalPen: true,
        igvPen: true,
        totalPen: true,
      },
      orderBy: { lineNumber: 'asc' },
    });
    const orderLineIds = orderLines.map((o) => o.id);
    const orderLineSet = new Set(orderLineIds);
    if (itemIds.some((i) => i === null || !orderLineSet.has(i))) {
      throw new ConflictException(
        `${label} factura líneas que ya no están en el pedido ${orderCode}: no se reactiva con sus líneas`,
      );
    }

    // Los borradores del pedido, con lock en orden de id: uno que se esté registrando espera a
    // este commit, y los chequeos de abajo ya lo ven aceptado (revisiones cc07).
    if (lock) {
      await tx.$queryRaw`
        SELECT d."id" FROM "fiscal_documents" d
        WHERE d."status" = 'DRAFT' AND d."id" <> ${id}::uuid
          AND (
            d."sales_order_id" = ${salesOrderId}::uuid
            OR EXISTS (
              SELECT 1 FROM "fiscal_document_items" i
              WHERE i."document_id" = d."id" AND i."sales_order_item_id" = ANY(${orderLineIds}::uuid[])
            )
          )
        ORDER BY d."id"
        FOR UPDATE
      `;
    }
    const onOrder = {
      id: { not: id },
      archivedAt: null,
      docType: { in: [...REACTIVATABLE_DOC_TYPES] },
      OR: [{ salesOrderId }, { items: { some: { salesOrderItemId: { in: orderLineIds } } } }],
    } satisfies Prisma.FiscalDocumentWhereInput;
    // Decisión 1 del dueño: el comprobante pasa a facturar el pedido entero. Otra factura o
    // boleta viva del pedido haría que alguna línea quedara facturada dos veces.
    const others = await tx.fiscalDocument.findMany({
      where: { ...onOrder, status: { in: [...SHARED_LIVE_DOCUMENT_STATUSES] } },
      select: { number: true },
      orderBy: { number: 'asc' },
    });
    if (others.length > 0) {
      throw new ConflictException(
        `El pedido ${orderCode} tiene otro comprobante vivo (${others
          .map((o) => o.number ?? 'sin número')
          .join(
            ', ',
          )}): con las líneas del pedido, ${label} facturaría dos veces lo que ese ya factura. Decide cuál queda antes de reactivar`,
      );
    }
    const drafts = await tx.fiscalDocument.count({
      where: { ...onOrder, status: FiscalDocumentStatus.DRAFT },
    });
    if (drafts > 0) {
      throw new ConflictException(
        `El pedido ${orderCode} tiene ${String(drafts)} borrador(es) de comprobante: elimínalo(s) primero y vuelve a reactivar`,
      );
    }

    const plan = planOrderLines(document.items, orderLines, document);
    // Revisión cc13 (P2-4): si el pedido describe exactamente lo que el comprobante ya tenía, no
    // hay líneas que cambiar y la auditoría diría «con las líneas del pedido» sobre un antes igual
    // al después. Eso es la reactivación simple de D-373.
    if (!plan.changed) {
      throw new BadRequestException(
        `Las líneas del pedido ${orderCode} son las mismas de ${label}: no hay nada que cambiar. Usa «Reactivar»`,
      );
    }

    // D-077: una boleta a «público en general» por encima del tope solo existe si un
    // administrador lo forzó explícitamente al crearla. Reactivar no es ese gesto: si las líneas
    // nuevas cruzan el tope, no se reactiva (se registra el papel como corresponda).
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
        `Con las líneas del pedido, ${label} pasaría de S/ ${cap.toFixed(2)}, el tope de una boleta a «público en general»: no se reactiva así`,
      );
    }

    return { document, plan, label, statusBeforeAnnul, annulledAt, orderCode };
  }
}

/**
 * D-378 (revisión cc13, P2-2): un `update` por línea dentro de la transacción. Contra Neon, los
 * 5 s por defecto de Prisma no alcanzan con un pedido grande; el mismo margen que `create`.
 */
const REACTIVATION_TX_TIMEOUT_MS = 30_000;

/** Lo que deja leído `lockAnnulledForReactivation`: la parte común de las dos reactivaciones. */
type AnnulledForReactivation = Awaited<ReturnType<typeof lockAnnulledForReactivation>>;

/**
 * UAT de cc13: el motivo que se muestra para una acción deshabilitada es el mensaje del error de
 * dominio que daría intentarla. Cualquier otro error (base caída, un bug) no es un «motivo» y se
 * deja subir.
 */
function blockReason(error: unknown): string {
  if (error instanceof HttpException) return error.message;
  throw error;
}

async function availability(check: () => Promise<unknown>): Promise<ReactivationAvailabilityDto> {
  try {
    await check();
    return { ok: true, reason: null };
  } catch (error) {
    return { ok: false, reason: blockReason(error) };
  }
}

/** D-373/D-378: las dos reactivaciones son solo de administrador. */
function assertCanReactivate(actor: RequestUser): void {
  if (actor.role !== Role.ADMINISTRADOR) {
    throw new ForbiddenException('Solo un administrador puede reactivar un comprobante anulado');
  }
}

/**
 * D-373 (decisión del dueño): las ediciones de una línea de pedido que hacen que el comprobante
 * ya no la describa —precio, importes del papel, producto (atar a otra bobina) y cantidad—.
 * Todas se auditan sobre el pedido (`entity = sales_orders`) con el `lineNumber` en `before`.
 *
 * Se lee la **auditoría** y no `updatedAt`: `sales_order_items` no tiene esa columna, y aunque
 * la tuviera la tocan también la reserva y el despacho, que no cambian lo facturado.
 */
const ORDER_LINE_EDIT_ACTIONS = [
  'sales.order.item-price',
  'sales.order.item-paper-amounts',
  'sales.order.item-coil',
  'sales.order.item-qty',
] as const;

async function assertOrderLinesUnchanged(
  tx: Prisma.TransactionClient,
  salesOrderId: string,
  orderItemIds: readonly string[],
  annulledAt: Date,
  label: string,
  orderLabel: string,
): Promise<void> {
  const [lines, edits] = await Promise.all([
    tx.salesOrderItem.findMany({
      where: { id: { in: [...orderItemIds] } },
      select: { lineNumber: true },
    }),
    tx.auditLog.findMany({
      where: {
        entity: 'sales_orders',
        entityId: salesOrderId,
        action: { in: [...ORDER_LINE_EDIT_ACTIONS] },
        at: { gt: annulledAt },
      },
      select: { before: true },
    }),
  ]);
  const covered = new Set(lines.map((l) => l.lineNumber));
  const changed = [
    ...new Set(
      edits.flatMap((e) => {
        const n = lineNumberOf(e.before);
        return n !== null && covered.has(n) ? [n] : [];
      }),
    ),
  ].sort((a, b) => a - b);
  if (changed.length === 0) return;
  const which =
    changed.length === 1
      ? `la línea ${String(changed[0])} se modificó`
      : `las líneas ${changed.join(', ')} se modificaron`;
  throw new ConflictException(
    `${orderLabel}: ${which} (precio, producto o cantidad) después de anular ${label}. Reactivarlo dejaría el comprobante distinto del pedido: revisa el pedido y, si corresponde, factúralo de nuevo`,
  );
}

/** El `lineNumber` de un `before` de auditoría de pedido, si lo trae. */
function lineNumberOf(json: Prisma.JsonValue | undefined): number | null {
  if (json === null || json === undefined || typeof json !== 'object' || Array.isArray(json)) {
    return null;
  }
  const n = json.lineNumber;
  return typeof n === 'number' ? n : null;
}

/** D-373: lo único que se reactiva (revisión cc07, P1-1). */
const REACTIVATABLE_DOC_TYPES: readonly FiscalDocType[] = [
  FiscalDocType.FACTURA,
  FiscalDocType.BOLETA,
];

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

/**
 * D-373, compartido con D-378: el lock del comprobante y los bloqueos comunes a las dos
 * reactivaciones —origen, tipo, estado, versión, rastro de PSE, la anulación en la auditoría,
 * cobros y notas de crédito—. Lo que sigue (pedido, líneas, borradores) es propio de cada una.
 */
async function lockAnnulledForReactivation(tx: Prisma.TransactionClient, id: string, lock = true) {
  // El mismo lock que la anulación: una anulación, una reactivación o un cobro simultáneos
  // sobre esta fila esperan a que esta transacción termine y ven el estado ya cambiado.
  // Sin `lock` (la sección del pedido, cc13) es una lectura simple: solo informa, y el modal y
  // la ejecución vuelven a comprobar todo con sus locks.
  if (lock) {
    await tx.$queryRaw`
      SELECT "id" FROM "fiscal_documents" WHERE "id" = ${id}::uuid FOR UPDATE
    `;
  }
  const document = await tx.fiscalDocument.findUnique({
    where: { id },
    select: {
      id: true,
      docType: true,
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
      salesOrderId: true,
      salesOrder: { select: { seq: true } },
      // D-378 lee también la fila completa de cada línea y la cabecera: es lo que reescribe.
      customerId: true,
      detractionCode: true,
      subtotalPen: true,
      igvPen: true,
      totalPen: true,
      items: {
        select: {
          id: true,
          lineNumber: true,
          productId: true,
          description: true,
          qty: true,
          unit: true,
          unitPricePen: true,
          subtotalPen: true,
          igvPen: true,
          totalPen: true,
          salesOrderItemId: true,
        },
      },
    },
  });
  if (!document) throw new NotFoundException('Comprobante no encontrado');
  const label = document.number ?? 'El comprobante';

  if (document.origin === FiscalDocumentOrigin.ISSUED_HERE) {
    throw new BadRequestException(
      'Este comprobante lo emitió el ERP: no se reactiva desde acá, se resuelve ante SUNAT',
    );
  }
  // Revisión cc07 (P1-1): solo facturas y boletas. Una nota de crédito acredita contra un
  // afectado y tiene su propio tope por línea; reactivarla con esta cuenta, que es la de
  // facturar líneas de pedido, podía dejarla viva sobre un afectado ya anulado.
  if (!REACTIVATABLE_DOC_TYPES.includes(document.docType)) {
    throw new BadRequestException(
      'Solo se reactiva una factura o una boleta anulada; una nota de crédito o una guía no se reactivan desde acá',
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
  return { document, label, statusBeforeAnnul, annulledAt };
}
