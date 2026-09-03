import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CoilSplitStatus,
  CoilStatus,
  Prisma,
  type Coil,
  type InventoryMovement,
} from '@prisma/client';
import {
  Role,
  toDecimal,
  toFixedString,
  Unit,
  type CoilDto,
  type CoilSplitDto,
  type CreateCoilScrapInput,
  type CreateCoilSplitInput,
  type SetCoilStatusInput,
  type UpdateCoilInput,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { liveMovements } from '../inventory/live-movements';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { expandSplitWidths, planCoilSplit } from './coil-split-math';
import { CoilsService } from './coils.service';

/**
 * Operaciones de Fase 2b sobre una bobina ya dada de alta: partido (RF-15) y su
 * reversa (RF-16), merma (RF-17) y su anulación (RF-18), cierre/apertura (RF-19),
 * edición (RF-20, D-045) y anulación (RF-21).
 *
 * Todas comparten la misma forma: una transacción que bloquea la fila de la bobina,
 * mueve el kardex **solo** vía `InventoryService` (regla dura 2) y escribe auditoría
 * dentro de la misma transacción (RF-95).
 */
@Injectable()
export class CoilOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly coils: CoilsService,
  ) {}

  // -------------------------------------------------------------------------
  // RF-15 — partir una bobina en hijas por ancho
  // -------------------------------------------------------------------------

  async split(actor: RequestUser, coilId: string, input: CreateCoilSplitInput): Promise<CoilDto[]> {
    const created = await this.prisma.$transaction(
      async (tx) => {
        const coil = await this.coils.lockCoil(tx, coilId);
        if (coil.status !== CoilStatus.OPEN) {
          throw new BadRequestException(notOpenMessage(coil.status));
        }

        const balance = await tx.inventoryBalance.findUnique({
          where: { itemType_itemId: { itemType: 'COIL', itemId: coil.id } },
        });
        const availableKg = toDecimal(balance?.qty.toString() ?? '0');

        const plan = planCoilSplit({
          parentWidthMm: coil.widthMm.toString(),
          availableKg,
          splitWeightKg: input.splitWeightKg,
          kerfLossMm: input.kerfLossMm,
          widthsMm: expandSplitWidths(input.children),
        });

        const split = await tx.coilSplit.create({
          data: {
            parentCoilId: coil.id,
            splitWeightKg: toFixedString(plan.splitWeightKg, 'KG'),
            kerfLossMm: toFixedString(plan.kerfLossMm, 'MM'),
            kerfLossKg: toFixedString(plan.kerfLossKg, 'KG'),
            createdById: actor.id,
          },
        });

        // La salida sale al promedio ponderado vigente de la madre (D-028), que ya
        // puede incluir landed cost (D-043); ese mismo costo por kilo es el que
        // heredan las hijas, así que el valor del inventario solo pierde lo que se
        // lleva la merma de corte, que es una pérdida física real.
        const out = await this.inventory.record(tx, {
          businessLineId: coil.businessLineId,
          itemType: 'COIL',
          itemId: coil.id,
          type: 'OUT',
          qty: toFixedString(plan.splitWeightKg, 'KG'),
          unit: Unit.KGM,
          refType: 'SPLIT',
          refId: split.id,
          notes: `Partido en ${plan.children.length} bobinas hijas`,
          actorId: actor.id,
        });
        if (!out) {
          throw new BadRequestException('La línea de negocio de la bobina no lleva inventario');
        }
        const unitCostPen = out.unitCost.toFixed(4);

        // Proveedor, acabado, producto de catálogo y los N correlativos se resuelven una
        // sola vez para toda la tanda: con una hija por consulta, un partido de 20 tiras
        // eran cientos de viajes a la base sosteniendo el lock del proveedor.
        const batch = await this.coils.prepareBatch(tx, {
          supplierId: coil.supplierId,
          finishId: coil.finishId,
          thicknessMm: coil.thicknessMm.toFixed(2),
          count: plan.children.length,
        });

        const children: Coil[] = [];
        for (const [index, child] of plan.children.entries()) {
          children.push(
            await this.coils.create(
              tx,
              {
                businessLineId: coil.businessLineId,
                supplierId: coil.supplierId,
                purchaseId: coil.purchaseId ?? undefined,
                finishId: coil.finishId,
                weightKg: toFixedString(child.weightKg, 'KG'),
                widthMm: toFixedString(child.widthMm, 'MM'),
                thicknessMm: coil.thicknessMm.toFixed(2),
                currency: coil.currency,
                exchangeRate: coil.exchangeRate.toFixed(4),
                // El costo del documento se hereda tal cual (RF-15); el del kardex es el
                // promedio vigente de la madre, que es de donde salieron estos kilos.
                unitCostPerKg: coil.unitCostPerKg.toFixed(4),
                kardexUnitCostPen: unitCostPen,
                refType: 'SPLIT',
                refId: split.id,
                parentCoilId: coil.id,
                splitId: split.id,
                actorId: actor.id,
              },
              { ...batch, sequence: batch.sequence + index },
            ),
          );
        }

        // La madre se queda con lo que no entró al partido. Si no queda nada, cerrarla
        // evita que aparezca como disponible en producción con saldo cero (RF-19).
        const remaining = availableKg.minus(plan.splitWeightKg);
        if (remaining.lte(0)) {
          await tx.coil.update({
            where: { id: coil.id },
            data: { status: CoilStatus.CLOSED },
          });
        }

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'coils.split',
          entity: 'coils',
          entityId: coil.id,
          before: { availableKg: availableKg.toFixed(3), status: coil.status },
          after: {
            splitId: split.id,
            splitWeightKg: toFixedString(plan.splitWeightKg, 'KG'),
            kerfLossKg: toFixedString(plan.kerfLossKg, 'KG'),
            children: children.map((c) => c.code),
            remainingKg: remaining.toFixed(3),
            status: remaining.lte(0) ? CoilStatus.CLOSED : coil.status,
          },
        });

        return children.map((c) => c.id);
      },
      { timeout: 30_000 },
    );

    return Promise.all(created.map((id) => this.coils.findOne(id)));
  }

  // -------------------------------------------------------------------------
  // RF-16 — revertir un partido
  // -------------------------------------------------------------------------

  async revertSplit(actor: RequestUser, splitId: string, reason: string): Promise<CoilSplitDto[]> {
    const parentCoilId = await this.prisma.$transaction(
      async (tx) => {
        const split = await tx.coilSplit.findUnique({
          where: { id: splitId },
          include: { children: { select: { id: true, code: true } } },
        });
        if (!split) throw new NotFoundException('Partido no encontrado');
        if (split.status === CoilSplitStatus.REVERTED) {
          throw new ConflictException('Ese partido ya fue revertido');
        }
        const coil = await this.coils.lockCoil(tx, split.parentCoilId);
        // D-050: la madre puede haberse enviado a corte tercerizado después de este
        // partido (`send()` no deja rastro de kardex), así que revertir aquí devolvería
        // peso a una bobina que hoy es del tercero. Mismo guardrail que Fase 3 agregó a
        // `registerScrap`/`cancel`/`setStatus` para este estado.
        if (coil.status === CoilStatus.IN_THIRD_PARTY) {
          throw new BadRequestException(notOpenMessage(coil.status));
        }

        const all = await tx.inventoryMovement.findMany({
          where: { refType: 'SPLIT', refId: splitId },
          orderBy: { id: 'asc' },
          include: { reversals: { select: { id: true } } },
        });
        const movementIds = new Set(all.map((m) => m.id));
        // Los movimientos que ya se anularon entre sí (y sus reversas) no se vuelven a
        // tocar: un recosteo de una hija (D-045) deja tres filas bajo el mismo `refId` y
        // solo la última está viva. Sin este filtro la reversa del partido chocaría con
        // "un movimiento de anulación no se puede volver a anular".
        const movements = liveMovements(all);

        // Solo se revierte un partido intacto: si una hija ya se consumió, se mermó o
        // se volvió a partir, devolver su peso a la madre inventaría kilos que ya no
        // existen. Se nombra la bobina que bloquea para que el usuario sepa qué anular.
        for (const child of split.children) {
          const extra = await tx.inventoryMovement.findMany({
            where: {
              itemType: 'COIL',
              itemId: child.id,
              // Un partido siempre tiene movimientos; el guard evita un `NOT IN ()` si
              // alguna vez llegara vacío.
              ...(movementIds.size > 0 ? { id: { notIn: [...movementIds] } } : {}),
            },
            orderBy: { id: 'asc' },
            include: { reversals: { select: { id: true } } },
          });
          const blocking = liveMovements(extra)[0];
          if (blocking) {
            throw new BadRequestException(
              `La bobina hija ${child.code} ya tiene movimientos posteriores (${blocking.refType}): anúlalos antes de revertir el partido`,
            );
          }
        }

        // Primero las entradas de las hijas y al final la salida de la madre: al
        // revés, la madre recuperaría el peso antes de que las hijas lo devuelvan.
        for (const movement of movements.filter((m) => m.type === 'IN')) {
          await this.inventory.reverse(tx, movement.id, actor.id, reason);
        }
        for (const movement of movements.filter((m) => m.type === 'OUT')) {
          await this.inventory.reverse(tx, movement.id, actor.id, reason);
        }

        await tx.coil.updateMany({
          where: { splitId },
          data: { status: CoilStatus.CANCELLED },
        });
        await tx.coilSplit.update({
          where: { id: splitId },
          data: {
            status: CoilSplitStatus.REVERTED,
            revertedById: actor.id,
            revertedAt: new Date(),
          },
        });
        // La madre vuelve a estar disponible: el partido la había cerrado al dejarla en
        // cero, y ahora tiene otra vez su peso.
        if (coil.status === CoilStatus.CLOSED) {
          await tx.coil.update({ where: { id: coil.id }, data: { status: CoilStatus.OPEN } });
        }

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'coils.split-revert',
          entity: 'coil_splits',
          entityId: splitId,
          before: { status: CoilSplitStatus.ACTIVE, parentStatus: coil.status },
          after: {
            status: CoilSplitStatus.REVERTED,
            reason,
            children: split.children.map((c) => c.code),
          },
        });

        return split.parentCoilId;
      },
      { timeout: 30_000 },
    );

    return this.coils.findSplits(parentCoilId);
  }

  // -------------------------------------------------------------------------
  // RF-17 / RF-18 — merma y su anulación
  // -------------------------------------------------------------------------

  /** D-040: salida `SCRAP` valorizada al costo promedio vigente. */
  async registerScrap(
    actor: RequestUser,
    coilId: string,
    input: CreateCoilScrapInput,
  ): Promise<CoilDto> {
    await this.prisma.$transaction(async (tx) => {
      const coil = await this.coils.lockCoil(tx, coilId);
      if (coil.status === CoilStatus.CANCELLED || coil.status === CoilStatus.IN_THIRD_PARTY) {
        throw new BadRequestException(notOpenMessage(coil.status));
      }

      const movement = await this.inventory.record(tx, {
        businessLineId: coil.businessLineId,
        itemType: 'COIL',
        itemId: coil.id,
        type: 'OUT',
        qty: input.qtyKg,
        unit: Unit.KGM,
        refType: 'SCRAP',
        refId: coil.id,
        notes: input.reason,
        actorId: actor.id,
      });
      if (!movement) {
        throw new BadRequestException('La línea de negocio de la bobina no lleva inventario');
      }

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'coils.scrap',
        entity: 'coils',
        entityId: coil.id,
        after: {
          movementId: movement.id.toString(),
          qtyKg: movement.qty.toFixed(3),
          totalCostPen: movement.totalCost.toFixed(4),
          reason: input.reason,
        },
      });
    });
    return this.coils.findOne(coilId);
  }

  /** RF-18: anular una merma mal registrada. Reversa con motivo, nunca `DELETE`. */
  async cancelScrap(actor: RequestUser, movementId: bigint, reason: string): Promise<CoilDto> {
    const coilId = await this.prisma.$transaction(async (tx) => {
      const movement = await tx.inventoryMovement.findUnique({ where: { id: movementId } });
      if (!movement) throw new NotFoundException('Movimiento no encontrado');
      if (movement.refType !== 'SCRAP' || movement.itemType !== 'COIL') {
        throw new BadRequestException('Ese movimiento no es una merma de bobina');
      }
      await this.coils.lockCoil(tx, movement.itemId);
      const reversal = await this.inventory.reverse(tx, movementId, actor.id, reason);

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'coils.scrap-cancel',
        entity: 'coils',
        entityId: movement.itemId,
        before: { movementId: movementId.toString(), qtyKg: movement.qty.toFixed(3) },
        after: { reversalId: reversal.id.toString(), reason },
      });
      return movement.itemId;
    });
    return this.coils.findOne(coilId);
  }

  // -------------------------------------------------------------------------
  // RF-19 — abrir y cerrar
  // -------------------------------------------------------------------------

  async setStatus(actor: RequestUser, coilId: string, input: SetCoilStatusInput): Promise<CoilDto> {
    await this.prisma.$transaction(async (tx) => {
      const coil = await this.coils.lockCoil(tx, coilId);
      if (coil.status === CoilStatus.CANCELLED || coil.status === CoilStatus.IN_THIRD_PARTY) {
        throw new BadRequestException(notOpenMessage(coil.status));
      }
      if (coil.status === input.status) {
        throw new BadRequestException(
          input.status === CoilStatus.OPEN
            ? 'La bobina ya está abierta'
            : 'La bobina ya está cerrada',
        );
      }

      await tx.coil.update({ where: { id: coilId }, data: { status: input.status } });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: input.status === CoilStatus.OPEN ? 'coils.open' : 'coils.close',
        entity: 'coils',
        entityId: coilId,
        before: { status: coil.status },
        after: { status: input.status, reason: input.reason ?? null },
      });
    });
    return this.coils.findOne(coilId);
  }

  // -------------------------------------------------------------------------
  // RF-20 — editar (D-045)
  // -------------------------------------------------------------------------

  async update(actor: RequestUser, coilId: string, input: UpdateCoilInput): Promise<CoilDto> {
    const touchesCost =
      input.currency !== undefined ||
      input.exchangeRate !== undefined ||
      input.unitCostPerKg !== undefined;
    if (touchesCost && actor.role !== Role.ADMINISTRADOR) {
      throw new ForbiddenException(
        'Solo un administrador puede cambiar la moneda, el tipo de cambio o el costo de una bobina',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const coil = await this.coils.lockCoil(tx, coilId);
      if (coil.status === CoilStatus.CANCELLED) {
        throw new BadRequestException('La bobina está anulada: no se puede editar');
      }
      if (input.widthMm !== undefined && coil.status !== CoilStatus.OPEN) {
        throw new BadRequestException('El ancho solo se edita con la bobina abierta');
      }

      const data: Prisma.CoilUpdateInput = {};
      if (input.widthMm !== undefined) data.widthMm = input.widthMm;
      if (input.notes !== undefined) data.notes = input.notes || null;

      if (touchesCost) {
        const initial = await this.initialMovement(tx, coilId);
        const currency = input.currency ?? coil.currency;
        const exchangeRate = toDecimal(
          input.exchangeRate ?? (currency === 'PEN' ? '1.0000' : coil.exchangeRate.toFixed(4)),
        );
        const unitCostPerKg = toDecimal(input.unitCostPerKg ?? coil.unitCostPerKg.toFixed(4));
        const weightKg = toDecimal(initial.qty.toString());
        const totalCost = weightKg.times(unitCostPerKg);

        // D-045: el kardex es append-only, así que recostear es reversar el ingreso y
        // volver a ingresar al costo corregido, no reescribir el movimiento original.
        await this.inventory.reverse(
          tx,
          initial.id,
          actor.id,
          input.reason ?? 'Corrección de costo de la bobina',
        );
        await this.inventory.record(tx, {
          businessLineId: coil.businessLineId,
          itemType: 'COIL',
          itemId: coil.id,
          type: 'IN',
          qty: initial.qty.toFixed(3),
          unit: initial.unit,
          unitCost: toFixedString(unitCostPerKg.times(exchangeRate), 'MONEY'),
          refType: initial.refType,
          refId: initial.refId ?? undefined,
          notes: input.reason,
          actorId: actor.id,
        });

        data.currency = currency;
        data.exchangeRate = toFixedString(exchangeRate, 'RATE');
        data.unitCostPerKg = toFixedString(unitCostPerKg, 'MONEY');
        data.totalCost = toFixedString(totalCost, 'MONEY');
        data.totalCostPen = toFixedString(totalCost.times(exchangeRate), 'MONEY');
      }

      const updated = await tx.coil.update({ where: { id: coilId }, data });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'coils.update',
        entity: 'coils',
        entityId: coilId,
        before: {
          widthMm: coil.widthMm.toFixed(2),
          currency: coil.currency,
          exchangeRate: coil.exchangeRate.toFixed(4),
          unitCostPerKg: coil.unitCostPerKg.toFixed(4),
          notes: coil.notes,
        },
        // Se construye campo por campo en vez de volcar el `CoilUpdateInput`: ese objeto
        // puede llevar formas relacionales de Prisma que no son JSON serializable.
        after: {
          widthMm: updated.widthMm.toFixed(2),
          currency: updated.currency,
          exchangeRate: updated.exchangeRate.toFixed(4),
          unitCostPerKg: updated.unitCostPerKg.toFixed(4),
          notes: updated.notes,
          recosted: touchesCost,
          reason: input.reason ?? null,
        },
      });
    });
    return this.coils.findOne(coilId);
  }

  // -------------------------------------------------------------------------
  // RF-21 — anular una bobina
  // -------------------------------------------------------------------------

  /** Solo si no tiene ningún movimiento aparte del ingreso inicial. Reversa ese ingreso. */
  async cancel(actor: RequestUser, coilId: string, reason: string): Promise<CoilDto> {
    await this.prisma.$transaction(async (tx) => {
      const coil = await this.coils.lockCoil(tx, coilId);
      if (coil.status === CoilStatus.CANCELLED) {
        throw new BadRequestException('La bobina ya está anulada');
      }
      if (coil.status === CoilStatus.IN_THIRD_PARTY) {
        throw new BadRequestException(notOpenMessage(coil.status));
      }
      if (coil.splitId) {
        throw new BadRequestException(
          'Es una bobina hija de un partido: revierte el partido en vez de anularla (RF-16)',
        );
      }

      const initial = await this.initialMovement(tx, coilId);
      await this.inventory.reverse(tx, initial.id, actor.id, reason);
      await tx.coil.update({ where: { id: coilId }, data: { status: CoilStatus.CANCELLED } });

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'coils.cancel',
        entity: 'coils',
        entityId: coilId,
        before: { status: coil.status, code: coil.code },
        after: { status: CoilStatus.CANCELLED, reason },
      });
    });
    return this.coils.findOne(coilId);
  }

  // -------------------------------------------------------------------------
  // Utilidades comunes
  // -------------------------------------------------------------------------

  /**
   * El ingreso inicial de la bobina, exigiendo que sea el **único** movimiento vivo
   * (D-045, RF-21). Lo que bloquea se nombra explícitamente: un mensaje que solo diga
   * "tiene movimientos" obliga al usuario a ir a buscar cuál.
   */
  private async initialMovement(
    tx: Prisma.TransactionClient,
    coilId: string,
  ): Promise<InventoryMovement> {
    const movements = await tx.inventoryMovement.findMany({
      where: { itemType: 'COIL', itemId: coilId },
      orderBy: { id: 'asc' },
      include: { reversals: { select: { id: true } } },
    });
    // Lo que ya se anuló no cuenta: una merma registrada y después anulada (RF-17 →
    // RF-18) deja el saldo como estaba, y bloquear por ella dejaría la bobina sin poder
    // anularse ni corregirse nunca, pidiendo anular algo que el usuario ya anuló.
    const live = liveMovements(movements);
    const first = live[0];
    if (first?.type !== 'IN') {
      throw new BadRequestException('La bobina no tiene un ingreso de kardex que corregir');
    }
    const blocking = live.filter((m) => m.id !== first.id);
    if (blocking.length > 0) {
      const kinds = [...new Set(blocking.map((m) => m.refType))].join(', ');
      throw new BadRequestException(
        `La bobina tiene ${blocking.length} movimiento(s) posterior(es) al ingreso (${kinds}): anúlalos primero`,
      );
    }
    return first;
  }
}

/**
 * Mensaje para una bobina que no está `OPEN`, distinguiendo por qué: cerrada (RF-19),
 * anulada (RF-21) o en poder de un tercero de corte (D-050, Fase 3). Antes de D-050 solo
 * existían las dos primeras razones; sin distinguir la tercera, una bobina enviada a
 * corte —que no tiene nada de anulado— se reportaba como "anulada".
 */
function notOpenMessage(status: CoilStatus): string {
  if (status === CoilStatus.CLOSED)
    return 'La bobina está cerrada: ábrela antes de operarla (RF-19)';
  if (status === CoilStatus.IN_THIRD_PARTY) {
    return 'La bobina está enviada a corte tercerizado: recíbela o cancela la orden antes de operarla';
  }
  return 'La bobina está anulada';
}
