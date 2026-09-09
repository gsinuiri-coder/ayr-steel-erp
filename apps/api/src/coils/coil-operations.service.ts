import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
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
  fromDateOnly,
  Role,
  toDecimal,
  toFixedString,
  Unit,
  type CoilDto,
  type CoilSplitDto,
  type CreateCoilScrapInput,
  type CreateCoilSplitInput,
  type ReverseMovementInput,
  type SetCoilStatusInput,
  type UpdateCoilInput,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { ColorsService } from '../colors/colors.service';
import { ENV, type Env } from '../config/env';
import { OperationDateService } from '../common/operation-date.service';
import { liveMovements } from '../inventory/live-movements';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertStripsNotAssigned } from '../production/production-assignments';
import { roofingToleranceMm } from '../production/roofing-coil-match';
import { assertRawMaterialInvariant } from '../sales/raw-material';
import { assertNotReserved } from '../sales/reservation-guard';
import { planCoilCloseAdjustment, type CoilCloseAdjustmentKind } from './coil-close-math';
import { expandSplitWidths, planCoilSplit } from './coil-split-math';
import { CoilsService } from './coils.service';

/**
 * D-164: lo que el cierre (o la reapertura) movió en el kardex, para la auditoría del hecho
 * que lo provocó. `null` cuando no hubo nada que liquidar, que es el caso normal de una
 * bobina que se cierra ya en cero.
 */
interface CloseAdjustmentSummary {
  kind: CoilCloseAdjustmentKind;
  movementId: string;
  qtyKg: string;
  totalCostPen: string;
  /** Solo al cerrar: los kilos que planta declaró que quedaban en el rollo. */
  declaredPhysicalKg?: string;
  /** Solo al reabrir: el ajuste que este movimiento inverso deshace. */
  reversalOfId?: string;
}

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
    private readonly operationDate: OperationDateService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // -------------------------------------------------------------------------
  // RF-15 — partir una bobina en hijas por ancho
  // -------------------------------------------------------------------------

  async split(actor: RequestUser, coilId: string, input: CreateCoilSplitInput): Promise<CoilDto[]> {
    // D-124: una sola fecha para el partido entero — la salida de la madre y las entradas
    // de todas las hijas. Que difieran dejaría kilos en el aire por un día en el reporte.
    const operationDate = this.operationDate.resolve(actor, input.operationDate);
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
          operationDate,
          confirmBackdate: input.confirmBackdate,
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
                operationDate,
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

        // D-134: el partido se comprueba **una vez, al final**, con madre e hijas ya en
        // su estado definitivo. Movimiento por movimiento la salida de la madre se lee
        // sobre un estado transitorio —el agregado perdió todo el peso y las hijas todavía
        // no existen— y rechazaría cualquier partido con una promesa viva encima, aunque
        // las hijas hereden línea, color y espesor y el neto sea cero.
        await assertRawMaterialInvariant(
          tx,
          [coil.id, ...children.map((c) => c.id)],
          roofingToleranceMm(this.env),
        );

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'coils.split',
          entity: 'coils',
          entityId: coil.id,
          before: { availableKg: availableKg.toFixed(3), status: coil.status },
          after: {
            operationDate,
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

  async revertSplit(
    actor: RequestUser,
    splitId: string,
    input: ReverseMovementInput,
  ): Promise<CoilSplitDto[]> {
    const { reason } = input;
    // D-124: la reversa se fecha hoy salvo que un administrador diga otra cosa. No hereda
    // la fecha del partido: deshacerlo es un hecho propio, con su propia fecha.
    const operationDate = this.operationDate.resolve(actor, input.operationDate);
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
          await this.inventory.reverse(tx, movement.id, actor.id, reason, operationDate);
        }
        for (const movement of movements.filter((m) => m.type === 'OUT')) {
          await this.inventory.reverse(tx, movement.id, actor.id, reason, operationDate);
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

        // Igual que el partido, y por lo mismo: las hijas se anulan y la madre recupera
        // su peso dentro de la misma transacción, así que el único estado que significa
        // algo es el de después.
        await assertRawMaterialInvariant(
          tx,
          [coil.id, ...split.children.map((c) => c.id)],
          roofingToleranceMm(this.env),
        );

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
    const operationDate = this.operationDate.resolve(actor, input.operationDate);
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
        operationDate,
        confirmBackdate: input.confirmBackdate,
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
          operationDate,
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
  async cancelScrap(
    actor: RequestUser,
    movementId: bigint,
    input: ReverseMovementInput,
  ): Promise<CoilDto> {
    const { reason } = input;
    const operationDate = this.operationDate.resolve(actor, input.operationDate);
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
      const reversal = await this.inventory.reverse(
        tx,
        movementId,
        actor.id,
        reason,
        operationDate,
      );

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'coils.scrap-cancel',
        entity: 'coils',
        entityId: movement.itemId,
        before: { movementId: movementId.toString(), qtyKg: movement.qty.toFixed(3) },
        after: { reversalId: reversal.id.toString(), reason, operationDate },
      });
      return movement.itemId;
    });
    return this.coils.findOne(coilId);
  }

  // -------------------------------------------------------------------------
  // RF-19 — abrir y cerrar
  // -------------------------------------------------------------------------

  async setStatus(actor: RequestUser, coilId: string, input: SetCoilStatusInput): Promise<CoilDto> {
    // D-124 + D-164: el cierre ya no es solo un cambio de estado, emite un movimiento de
    // kardex, así que tiene fecha de operación como cualquier otro hecho fechado.
    const operationDate = this.operationDate.resolve(actor, input.operationDate);
    // D-134: presupuesto explícito. La comprobación del agregado recorre las bobinas
    // compatibles, y con los 5 s por defecto de Prisma esta transacción se pasaba del
    // límite contra Neon de forma intermitente — un 500 en una operación normal.
    await this.prisma.$transaction(
      async (tx) => {
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

        // D-164: el kardex se mueve **antes** de cambiar el estado. `InventoryService.record`
        // no sabe nada de estados de bobina, pero `assertRawMaterialInvariant` sí lee el
        // agregado desde la base: con la bobina ya marcada `CLOSED`, la salida se comprobaría
        // contra un agregado que acaba de perder este rollo entero y rechazaría por kilos que
        // el propio cierre sacó de la vista. Es el mismo orden que respeta el partido.
        const liquidated =
          input.status === CoilStatus.CLOSED
            ? await this.liquidateRemainder(tx, coil, input, actor, operationDate)
            : await this.reverseCloseAdjustment(tx, coil.id, input, actor, operationDate);

        await tx.coil.update({ where: { id: coilId }, data: { status: input.status } });

        // D-134: cerrar una bobina la saca del agregado sin mover kardex y sin que ninguna
        // reserva la nombre. `assertNotReserved` de arriba solo ve las promesas que apuntan a
        // **esta** bobina (la venta de un rollo entero, RF-73); una cobertura a medida promete
        // el agregado, y el agregado puede quedar corto justamente porque este rollo se fue.
        if (input.status === CoilStatus.CLOSED) {
          await assertRawMaterialInvariant(tx, [coil.id], roofingToleranceMm(this.env));
        }
        await this.audit.write(tx, {
          actorId: actor.id,
          action: input.status === CoilStatus.OPEN ? 'coils.open' : 'coils.close',
          entity: 'coils',
          entityId: coilId,
          before: { status: coil.status },
          after: {
            status: input.status,
            reason: input.reason ?? null,
            operationDate,
            // El ajuste se nombra en la auditoría del cierre y no solo en el kardex: es la
            // baja de inventario que ese cierre provocó, y RF-95 la quiere donde se decidió.
            // Se expande a un literal para que `InputJsonValue` lo acepte sin obligar a
            // `CloseAdjustmentSummary` a llevar una firma de índice, que apagaría el chequeo
            // de propiedades de toda la interfaz.
            adjustment: liquidated === null ? null : { ...liquidated },
          },
        });
      },
      { timeout: 30_000 },
    );
    return this.coils.findOne(coilId);
  }

  /**
   * D-164 — la liquidación del remanente al cerrar (RF-19).
   *
   * Cerrar una bobina declara que el rollo dejó de estar disponible. Hasta D-164 eso no movía
   * kardex, así que el saldo teórico que quedaba en `inventory_balances` seguía sumando kilos
   * y valor a un inventario valorizado de material que ya no existe — y nadie lo veía, porque
   * la bobina cerrada desaparece de las pantallas de producción pero no del valorizado.
   *
   * Ahora el cierre pide **cuántos kilos quedan de verdad** y saca la diferencia por el único
   * camino que el kardex admite (`InventoryService.record`, regla dura 2), en la misma
   * transacción que el cambio de estado. Con D-165 metiendo el 1 % de merma normal dentro de
   * la densidad estándar, lo que este movimiento mide es **merma anormal**: por eso lleva
   * `refType` propio y no se confunde con los consumos de producción en el kardex del rollo.
   */
  private async liquidateRemainder(
    tx: Prisma.TransactionClient,
    coil: Coil,
    input: SetCoilStatusInput,
    actor: RequestUser,
    operationDate: string,
  ): Promise<CloseAdjustmentSummary | null> {
    const balance = await tx.inventoryBalance.findUnique({
      where: { itemType_itemId: { itemType: 'COIL', itemId: coil.id } },
    });
    const balanceKg = toDecimal(balance?.qty.toString() ?? '0');

    // Sin saldo y sin declaración no hay nada que liquidar: es el cierre de una bobina ya
    // agotada, el caso más común y el único que sigue siendo un clic.
    //
    // El corte es por `physicalKg === undefined` y **no** por `balanceKg <= 0`: cortar por el
    // saldo dejaba fuera justamente el sobrante sobre una bobina en cero —planta encuentra
    // material que el kardex ya dio por consumido—, que es el caso para el que existe la
    // rama `SURPLUS`. Una declaración explícita se respeta siempre, en los dos sentidos.
    if (input.physicalKg === undefined) {
      // Con saldo vivo, cerrar **exige** decir qué queda. Dejarlo opcional con un default de
      // cero convertiría un olvido en una baja de inventario silenciosa, que es exactamente
      // lo que esta decisión viene a cerrar; y un default igual al saldo la deja sin efecto.
      if (balanceKg.gt(0)) {
        throw new BadRequestException(
          `La bobina tiene ${balanceKg.toFixed(3)} kg de saldo: indica cuántos kilos quedan de ` +
            'verdad en el rollo para liquidar la diferencia al cerrarla (D-164).',
        );
      }
      return null;
    }

    // Cota física: un rollo no puede tener más kilos de los que entraron. Sin esto, un `5000`
    // tipeado donde iba `500` daba de alta 4 500 kg valorizados al promedio en una sola
    // llamada, con un texto libre como única justificación. `weightKg` es el peso de alta y no
    // se mueve con los consumos ni con un partido, así que es el techo correcto.
    const declaredKg = toDecimal(input.physicalKg);
    const intakeKg = toDecimal(coil.weightKg.toString());
    if (declaredKg.gt(intakeKg)) {
      throw new BadRequestException(
        `Declaras ${declaredKg.toFixed(3)} kg y la bobina entró con ${intakeKg.toFixed(3)} kg: ` +
          'un rollo no puede tener más material del que ingresó. Revisá el número.',
      );
    }

    const plan = planCoilCloseAdjustment({
      balanceKg,
      physicalKg: input.physicalKg,
      avgCostPen: balance?.avgCost.toString() ?? '0',
      // El costo del documento ya viene en soles: `unitCostPerKg` es sin IGV y en la moneda
      // de la compra (D-038), así que el tipo de cambio de la bobina lo lleva a soles (D-042).
      documentUnitCostPen: toDecimal(coil.unitCostPerKg.toString()).times(
        toDecimal(coil.exchangeRate.toString()),
      ),
    });
    if (!plan) return null;

    // El sentido lo decide `plan.kind` y no una segunda comparación: re-derivarlo acá dejaba
    // dos fuentes para la misma pregunta, y la de acá no pasa por el redondeo a la escala de
    // kilos que sí aplica el plan.
    if (plan.kind === 'SURPLUS') {
      // Un `SURPLUS` es un conteo físico por encima del saldo teórico: material que existe y
      // el kardex no conocía. Es legítimo, pero **crea** inventario, así que exige el mismo
      // motivo escrito que cualquier otra corrección de saldo (RF-95).
      if (!input.reason) {
        throw new BadRequestException(
          `Declaras ${declaredKg.toFixed(3)} kg contra un saldo de ` +
            `${balanceKg.toFixed(3)} kg: dar de alta ${plan.qtyKg.toFixed(3)} kg que el kardex no ` +
            'tenía exige un motivo escrito.',
        );
      }
    } else if (!input.reason) {
      throw new BadRequestException(
        `Cerrar liquida ${plan.qtyKg.toFixed(3)} kg de remanente (S/ ` +
          `${plan.totalCostPen.toFixed(2)}) como merma: explica el motivo.`,
      );
    }

    const movement = await this.inventory.record(tx, {
      businessLineId: coil.businessLineId,
      itemType: 'COIL',
      itemId: coil.id,
      type: plan.kind === 'SHORTAGE' ? 'OUT' : 'IN',
      qty: toFixedString(plan.qtyKg, 'KG'),
      unit: Unit.KGM,
      // Una salida se valoriza sola al promedio vigente (D-028/D-040) y `record` ignora este
      // campo; una entrada lo exige, y sobre un saldo en cero el promedio no dice nada.
      unitCost: plan.kind === 'SURPLUS' ? toFixedString(plan.unitCostPen, 'MONEY') : undefined,
      refType: 'CLOSE_ADJUSTMENT',
      refId: coil.id,
      notes: input.reason,
      actorId: actor.id,
      operationDate,
      confirmBackdate: input.confirmBackdate,
    });
    if (!movement) {
      throw new BadRequestException('La línea de negocio de la bobina no lleva inventario');
    }

    return {
      kind: plan.kind,
      movementId: movement.id.toString(),
      qtyKg: movement.qty.toFixed(3),
      totalCostPen: movement.totalCost.toFixed(4),
      declaredPhysicalKg: declaredKg.toFixed(3),
    };
  }

  /**
   * D-164 — reabrir deshace la liquidación.
   *
   * El ajuste del cierre **no** se anula por RF-18: `cancelScrap` lo rechaza a propósito
   * (mira el `refType`), igual que rechaza la merma de proceso de una OP (D-057). El camino
   * es reabrir la bobina, que revierte el movimiento entero — kilos y valor— con un
   * movimiento inverso, nunca un `DELETE` (§3.2).
   *
   * **Solo se revierte el ajuste si es el ÚLTIMO movimiento del kardex de la bobina**, sin
   * anular nada, y si él mismo no fue anulado todavía. Es la parte que más cuesta acertar, y
   * las dos versiones anteriores estaban mal:
   *
   * 1. «El último `CLOSE_ADJUSTMENT` vivo» no ancla nada. Una bobina puede volver a `OPEN` por
   *    un camino que no es este: `revertSplit` (RF-16) reabre a la madre con un `update`
   *    directo, y ahí el ajuste de un cierre anterior queda vivo y **sin dueño**. El siguiente
   *    ciclo cerrar→reabrir lo adoptaba: madre de 500 kg, partido de 400, cierre declarando
   *    cero (ajuste de 100), `revertSplit` que devuelve los 400 y la reabre, cierre declarando
   *    los 400 (sin ajuste nuevo) y una reapertura que mete 100 kg **de la nada**.
   * 2. «El último movimiento **vivo**» tampoco, y por un motivo que no se ve: `liveMovements`
   *    descarta los pares movimiento+reversa, y la reversa del partido anula exactamente al
   *    movimiento del partido. Después de `revertSplit` los dos desaparecen de la lista y el
   *    ajuste **vuelve a quedar último**, así que la regla se saltea justo el caso que venía a
   *    cerrar. Que el par se anule es correcto para "¿queda algo que bloquee?" y equivocado
   *    para "¿pasó algo después?", que es la pregunta de acá.
   *
   * La condición que sí sirve es la cruda: nada se grabó después. El kardex es append-only, así
   * que un ajuste que dejó de ser el último **nunca vuelve a serlo** y queda inerte para
   * siempre, sin necesidad de guardar el vínculo en la bobina. Y es además lo que hace segura
   * la reversa: si algo movió el rollo después del cierre, el saldo ya no es el que el ajuste
   * dejó, y deshacerlo a ciegas es justamente lo que no se puede hacer.
   */
  private async reverseCloseAdjustment(
    tx: Prisma.TransactionClient,
    coilId: string,
    input: SetCoilStatusInput,
    actor: RequestUser,
    operationDate: string,
  ): Promise<CloseAdjustmentSummary | null> {
    const last = await tx.inventoryMovement.findFirst({
      where: { itemType: 'COIL', itemId: coilId },
      orderBy: { id: 'desc' },
      include: { reversals: { select: { id: true } } },
    });
    // `reversals` vacío: reabrir dos veces seguidas encontraría el mismo ajuste —ya revertido—
    // e intentaría revertirlo otra vez, chocando con "ese movimiento ya fue anulado". No puede
    // pasar hoy (reabrir una bobina abierta ya rebota antes), pero el chequeo es una línea y
    // el que lo garantiza es un estado, no una invariante del kardex.
    const adjustment =
      last?.refType === 'CLOSE_ADJUSTMENT' && last.reversals.length === 0 ? last : undefined;
    if (!adjustment) return null;

    if (!input.reason) {
      throw new BadRequestException(
        `Al cerrarla se liquidaron ${adjustment.qty.toFixed(3)} kg: reabrirla los devuelve al ` +
          'kardex con un movimiento inverso, así que explica el motivo.',
      );
    }

    const reversal = await this.inventory.reverse(
      tx,
      adjustment.id,
      actor.id,
      input.reason,
      operationDate,
      input.confirmBackdate,
    );
    return {
      kind: adjustment.type === 'OUT' ? 'SHORTAGE' : 'SURPLUS',
      movementId: reversal.id.toString(),
      qtyKg: reversal.qty.toFixed(3),
      totalCostPen: reversal.totalCost.toFixed(4),
      reversalOfId: adjustment.id.toString(),
    };
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

    // D-134: presupuesto explícito. La comprobación del agregado recorre las bobinas
    // compatibles, y con los 5 s por defecto de Prisma esta transacción se pasaba del
    // límite contra Neon de forma intermitente — un 500 en una operación normal.
    await this.prisma.$transaction(
      async (tx) => {
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
          // D-045 + D-124: el recosteo es reversa + reingreso, y los dos van con la MISMA
          // fecha de operación —la del ingreso original—, no con la de hoy. Fecharlos hoy
          // dejaría la bobina fuera del inventario de su propio mes entre la salida y la
          // entrada, y el saldo de ese mes cerraría mal por un movimiento que solo corrige
          // un costo. Es la única reversa del sistema que sí hereda la fecha, y hereda la
          // del movimiento que corrige, no la de un hecho distinto.
          const initial = await this.initialMovement(tx, coilId);
          const recostDate = fromDateOnly(initial.operationDate);
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
            recostDate,
            true,
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
            operationDate: recostDate,
            // El recosteo es reversa + reingreso del **mismo** hecho, con la fecha de ese
            // hecho: el guardrail de orden no aplica por definición, y sin este acuse una
            // bobina con cualquier movimiento posterior al ingreso no se podría recostear.
            confirmBackdate: true,
          });

          data.currency = currency;
          data.exchangeRate = toFixedString(exchangeRate, 'RATE');
          data.unitCostPerKg = toFixedString(unitCostPerKg, 'MONEY');
          data.totalCost = toFixedString(totalCost, 'MONEY');
          data.totalCostPen = toFixedString(totalCost.times(exchangeRate), 'MONEY');
        }

        const updated = await tx.coil.update({ where: { id: coilId }, data });

        // D-134: cambiarle el color a una bobina la **muda de agregado**, y el que abandona
        // puede quedar por debajo de lo prometido. Hay que comprobar los dos: después del
        // cambio la bobina ya no pertenece al viejo, así que leerla de la base no lo
        // encontraría — por eso los atributos anteriores viajan explícitos.
        if (input.colorId !== undefined && coil.colorId !== updated.colorId) {
          await assertRawMaterialInvariant(tx, [coil.id], roofingToleranceMm(this.env), {
            alsoAffecting: [
              {
                businessLineId: coil.businessLineId,
                colorId: coil.colorId,
                thicknessMm: coil.thicknessMm.toFixed(2),
              },
            ],
          });
        }

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
      },
      { timeout: 30_000 },
    );
    return this.coils.findOne(coilId);
  }

  // -------------------------------------------------------------------------
  // RF-21 — anular una bobina
  // -------------------------------------------------------------------------

  /** Solo si no tiene ningún movimiento aparte del ingreso inicial. Reversa ese ingreso. */
  async cancel(actor: RequestUser, coilId: string, input: ReverseMovementInput): Promise<CoilDto> {
    const { reason } = input;
    const operationDate = this.operationDate.resolve(actor, input.operationDate);
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
      await this.inventory.reverse(tx, initial.id, actor.id, reason, operationDate);
      await tx.coil.update({ where: { id: coilId }, data: { status: CoilStatus.CANCELLED } });

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'coils.cancel',
        entity: 'coils',
        entityId: coilId,
        before: { status: coil.status, code: coil.code },
        after: { status: CoilStatus.CANCELLED, reason, operationDate },
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
