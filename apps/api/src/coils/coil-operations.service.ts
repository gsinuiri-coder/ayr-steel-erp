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
  InventoryItemType,
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
import { ColorsService } from '../colors/colors.service';
import { liveMovements } from '../inventory/live-movements';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertStripsNotAssigned } from '../production/production-assignments';
import { assertNotReserved } from '../sales/reservation-guard';
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
    private readonly colors: ColorsService,
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
        // D-060: un fleje tomado por una OP no deja rastro de kardex, así que nada más
        // acá lo detectaría; partirlo mientras la orden lo tiene montado le sacaría el
        // material por debajo.
        await assertStripsNotAssigned(tx, [coil.id], 'partirlo');

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
                // D-085: cortar no cambia el color del material.
                colorId: coil.colorId,
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
                // La hija hereda la clase de la madre (D-049): partir un **fleje** para
                // reancharlo devuelve flejes, no bobinas. Sin esto, la hija nacía con el
                // `@default(COIL)` de la columna y se caía del stock de flejes (RF-42),
                // producción la rechazaba por "es una bobina, no un fleje", y el guardrail
                // de D-060 sobre las hijas de un partido quedaba inalcanzable.
                kind: coil.kind,
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
        // D-060: una hija de este partido puede ser un fleje ya montado en una OP, y esa
        // asignación no deja movimiento de kardex que el chequeo de abajo pueda ver.
        await assertStripsNotAssigned(
          tx,
          split.children.map((c) => c.id),
          'revertir el partido',
        );

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
      // D-060: mermar un fleje montado en una OP le quitaría a la orden el material que
      // sus piezas todavía no consumieron, y la merma del cierre saldría de menos.
      await assertStripsNotAssigned(tx, [coil.id], 'registrarle merma');

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
      // La merma de RF-17 apunta a la bobina misma (`refId = coil.id`); la merma de proceso
      // del cierre de una OP (D-057) apunta a la orden. Sin distinguirlas, anular esta
      // última devolvía los kilos y el valor al fleje mientras el producto terminado
      // conservaba el costo absorbido (D-056): valor creado de la nada en el valorizado,
      // y una reapertura posterior que ya no vería esa merma y duplicaría los kilos.
      if (movement.refId !== movement.itemId) {
        throw new BadRequestException(
          'Esa merma es la merma de proceso del cierre de una orden de producción: reabre la orden para deshacerla (D-057)',
        );
      }
      await this.coils.lockCoil(tx, movement.itemId);
      // Devolver los kilos de una merma anulada recalcula el costo promedio del fleje: si
      // una OP ya reportó piezas contra él, sus reportes siguientes saldrían a otro costo
      // que los anteriores (mismo motivo que bloquea recostear, D-045/D-060).
      await assertStripsNotAssigned(tx, [movement.itemId], 'anular la merma');
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
      // D-060: cerrar un fleje que una OP tiene montado lo sacaría de producción justo
      // mientras la orden lo está usando.
      await assertStripsNotAssigned(tx, [coil.id], 'cambiarle el estado');
      // D-066: cerrar tampoco mueve kardex, así que la invariante de cantidad no lo ve, y
      // una bobina cerrada no entra a producción (RF-19): el material prometido a un
      // pedido quedaría inalcanzable sin que nada avisara.
      if (input.status === CoilStatus.CLOSED) {
        await assertNotReserved(
          tx,
          [{ itemType: InventoryItemType.COIL, itemId: coil.id }],
          'cerrarla',
        );
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
      if (input.colorId !== undefined && coil.status !== CoilStatus.OPEN) {
        throw new BadRequestException('El color solo se edita con la bobina abierta');
      }
      // D-060: recostear (D-045) o reanchar un fleje montado en una OP cambiaría, a mitad
      // de la corrida, el costo con el que ya entraron piezas y el ancho contra el que se
      // validó la receta.
      // D-085: el color entra en la misma lista que el ancho. Cambiarlo en un rollo que
      // una OP ya montó rompería, a mitad de corrida, la igualdad de color contra la que
      // se validó el montaje (D-086).
      if (touchesCost || input.widthMm !== undefined || input.colorId !== undefined) {
        await assertStripsNotAssigned(tx, [coil.id], 'editarlo');
      }

      const data: Prisma.CoilUpdateInput = {};
      if (input.widthMm !== undefined) data.widthMm = input.widthMm;
      if (input.colorId !== undefined) {
        // Por `resolveActive` y no por `connect` directo: un id inexistente daba un 500
        // opaco, y —lo que importa— un color **desactivado** se podía asignar acá,
        // esquivando a posteriori el guardrail que impide desactivar un color en uso.
        const resolved = await this.colors.resolveActive(input.colorId);
        data.color = resolved === null ? { disconnect: true } : { connect: { id: resolved } };
      }
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
      // D-060: anular un fleje montado en una OP dejaría a la orden apuntando a material
      // que ya no existe, sin ningún movimiento de kardex que lo delatara.
      await assertStripsNotAssigned(tx, [coil.id], 'anularlo');
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
