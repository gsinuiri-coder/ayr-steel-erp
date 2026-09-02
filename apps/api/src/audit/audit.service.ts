import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  actorId: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
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
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        before: entry.before ?? undefined,
        after: entry.after ?? undefined,
      },
    });
  }
}
