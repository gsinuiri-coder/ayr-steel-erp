import { Injectable, Logger } from '@nestjs/common';
import { AuditActorKind, type Prisma } from '@prisma/client';
import { sanitizeAuditJson } from './audit-redact';
import { currentRequestId } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  actorId: string | null;
  /** `SYSTEM` cuando el evento lo generó un job o un proceso, no una persona (D-218). Por
   *  defecto `USER` — que es lo que todo el código de hoy escribe. */
  actorKind?: AuditActorKind;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
  /** D-218: motivo, cuando la operación lo pide (una reversa, una anulación con texto libre). */
  reason?: string | null;
  /** D-218: por defecto se toma del contexto ambiental de la petición (`requestIdMiddleware`).
   *  Pasarlo explícito solo hace falta fuera de una petición HTTP (un job) si se quiere
   *  correlacionar con algo puntual. */
  requestId?: string | null;
}

/** Cliente Prisma o transacción: lo mínimo que necesita la auditoría para escribir. */
export type AuditWriter = Pick<Prisma.TransactionClient, 'auditLog'>;

/** Auditoría append-only (RF-95). */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registro informativo (login, logout, intentos fallidos): nunca hace fallar la
   * operación principal si la escritura de auditoría falla.
   */
  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.write(this.prisma, entry);
    } catch (err) {
      this.logger.error(`No se pudo registrar auditoría ${entry.action}`, err);
    }
  }

  /**
   * Registro de una mutación crítica dentro de la misma transacción que la mutación:
   * si la auditoría falla, la transacción se revierte (RF-95).
   */
  write(tx: AuditWriter, entry: AuditEntry): Promise<unknown> {
    return tx.auditLog.create({
      data: {
        actorId: entry.actorId,
        actorKind: entry.actorKind ?? AuditActorKind.USER,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        before: sanitizeAuditJson(entry.before ?? null) ?? undefined,
        after: sanitizeAuditJson(entry.after ?? null) ?? undefined,
        reason: entry.reason ?? null,
        requestId: entry.requestId !== undefined ? entry.requestId : (currentRequestId() ?? null),
      },
    });
  }
}
