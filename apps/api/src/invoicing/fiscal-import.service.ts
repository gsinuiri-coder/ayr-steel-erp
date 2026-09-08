import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FiscalDocumentOrigin, FiscalDocumentStatus } from '@prisma/client';
import { LIVE_DOCUMENT_STATUSES as SHARED_LIVE_DOCUMENT_STATUSES } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

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
}
