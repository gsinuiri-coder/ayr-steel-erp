import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { CoilStatus } from '@prisma/client';
import {
  COIL_STATUS_LABELS,
  CoilFilmEventType,
  CoilFilmSource,
  type CoilDto,
  type CoilFilmActionInput,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { OperationDateService } from '../common/operation-date.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertCanReseal, recordFilmEvent } from './coil-film';
import { CoilsService } from './coils.service';

/**
 * D-328 — las dos acciones **manuales** sobre el film: «Abrir bobina» y «Volver a sellar».
 *
 * Abrir por dentro de otra operación (montar, merma, partir, enviar a corte) y resellar al
 * deshacerla viven en `coil-film.ts`, dentro de la transacción de cada una. Acá solo está lo que
 * el usuario hace desde la ficha de la bobina. Ninguna toca el kardex ni `coils.status`.
 */
@Injectable()
export class CoilFilmService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly coils: CoilsService,
    private readonly operationDate: OperationDateService,
  ) {}

  /** «Abrir bobina»: quitarle el film para empezar a usarla. Motivo opcional. */
  async open(actor: RequestUser, coilId: string, input: CoilFilmActionInput): Promise<CoilDto> {
    const operationDate = this.operationDate.resolve(actor, input.operationDate);
    await this.prisma.$transaction(async (tx) => {
      const coil = await this.coils.lockCoil(tx, coilId);
      if (coil.status !== CoilStatus.OPEN) {
        throw new BadRequestException(
          `La bobina está ${COIL_STATUS_LABELS[coil.status].toLowerCase()}: solo se abre el film de una bobina vigente`,
        );
      }
      if (!coil.filmSealed) throw new ConflictException('La bobina ya está abierta');
      await recordFilmEvent(
        tx,
        {
          coilId: coil.id,
          type: CoilFilmEventType.OPENED,
          source: CoilFilmSource.MANUAL,
          operationDate,
          actorId: actor.id,
          reason: input.reason ?? null,
        },
        { strictDate: true },
      );
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'coils.film_open',
        entity: 'coils',
        entityId: coil.id,
        before: { film: 'SEALED' },
        after: { film: 'OPENED', operationDate, reason: input.reason ?? null },
      });
    });
    return this.coils.findOne(coilId);
  }

  /**
   * «Volver a sellar»: la bobina se abrió por error y no se usó. Solo si no hubo salida viva
   * (producción, merma, partido, corte) desde la última apertura y no está montada en una OP
   * viva; el error nombra el movimiento o la OP que lo impide.
   */
  async reseal(actor: RequestUser, coilId: string, input: CoilFilmActionInput): Promise<CoilDto> {
    const operationDate = this.operationDate.resolve(actor, input.operationDate);
    await this.prisma.$transaction(async (tx) => {
      const coil = await this.coils.lockCoil(tx, coilId);
      await assertCanReseal(tx, coil);
      await recordFilmEvent(
        tx,
        {
          coilId: coil.id,
          type: CoilFilmEventType.RESEALED,
          source: CoilFilmSource.MANUAL,
          operationDate,
          actorId: actor.id,
          reason: input.reason ?? null,
        },
        { strictDate: true },
      );
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'coils.film_reseal',
        entity: 'coils',
        entityId: coil.id,
        before: { film: 'OPENED' },
        after: { film: 'SEALED', operationDate, reason: input.reason ?? null },
      });
    });
    return this.coils.findOne(coilId);
  }
}
