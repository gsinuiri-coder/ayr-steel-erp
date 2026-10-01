import { ForbiddenException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Role, type CoilDto, type CoilRestorePlanDto } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { OperationDateService } from '../common/operation-date.service';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { CoilsService } from './coils.service';
import {
  classifyCoilRestore,
  loadRestoreContext,
  restoreCoilInTx,
  toPlanDto,
} from './coil-restore';

/** D-375: restaurar desde la pantalla una bobina anulada que vino de una compra. */
@Injectable()
export class CoilRestoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
    private readonly operationDate: OperationDateService,
    private readonly coils: CoilsService,
  ) {}

  /** Lo que haría la restauración, sin escribir: el modal lo muestra antes de confirmar. */
  async plan(coilId: string): Promise<CoilRestorePlanDto> {
    const { ctx, coil } = await loadRestoreContext(
      this.prisma,
      coilId,
      this.operationDate.historicalLoadStart,
      false,
    );
    return toPlanDto(coil, classifyCoilRestore(ctx));
  }

  async restore(actor: RequestUser, coilId: string, reason: string): Promise<CoilDto> {
    if (actor.role !== Role.ADMINISTRADOR) {
      throw new ForbiddenException('Solo un administrador puede restaurar una bobina anulada');
    }
    await this.prisma.$transaction(
      (tx) =>
        restoreCoilInTx(tx, this.inventory, this.audit, {
          actorId: actor.id,
          coilId,
          reason,
          batchId: randomUUID(),
          historicalFloor: this.operationDate.historicalLoadStart,
        }),
      { timeout: 30_000 },
    );
    return this.coils.findOne(coilId);
  }
}
