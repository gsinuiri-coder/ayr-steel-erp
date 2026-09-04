import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CoilKind,
  CoilStatus,
  CuttingOrderCoilStatus,
  CuttingOrderStatus,
  InventoryItemType,
  Prisma,
  type Coil,
} from '@prisma/client';
import {
  Decimal,
  toDecimal,
  toFixedString,
  Unit,
  type CreateCuttingOrderInput,
  type CuttingOrderDto,
  type CuttingOrderListItemDto,
  type CuttingOrderQuery,
  type ReceiveCuttingOrderCoilInput,
  type StripStockQuery,
  type StripStockRowDto,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { toPrismaLineCode, toSharedLineCode } from '../common/business-line-code';
import { planCoilSplit } from '../coils/coil-split-math';
import { CoilsService } from '../coils/coils.service';
import { InventoryService } from '../inventory/inventory.service';
import { liveMovements } from '../inventory/live-movements';
import { PrismaService } from '../prisma/prisma.service';
import { assertStripsNotAssigned } from '../production/production-assignments';
import { assertNotReserved } from '../sales/reservation-guard';
import { deriveCuttingOrderStatus, expandWidthCounts, validateWidthBudget } from './cutting-math';

/** Shape JSON de `widthPlanMm`/`receivedWidthsMm` (una fila por ancho, no por tira). */
interface WidthCount {
  widthMm: string;
  stripsCount: number;
}

/**
 * Corte tercerizado (RF-40..42, RF-22, D-049/D-050). El envío no mueve kardex (D-050):
 * una bobina enviada pasa a `IN_THIRD_PARTY` sin movimiento. La recepción reusa
 * `planCoilSplit` y `CoilsService.create/prepareBatch` tal como el partido interno
 * (RF-15), con `refType=CUTTING` y bobinas hijas `kind=STRIP`.
 */
@Injectable()
export class CuttingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly coils: CoilsService,
  ) {}

  // -------------------------------------------------------------------------
  // RF-40 — enviar bobinas a corte
  // -------------------------------------------------------------------------

  async send(actor: RequestUser, input: CreateCuttingOrderInput): Promise<CuttingOrderDto> {
    const supplier = await this.prisma.supplier.findUnique({ where: { id: input.supplierId } });
    if (!supplier) throw new NotFoundException('Proveedor no encontrado');
    if (!supplier.isActive) throw new BadRequestException('El proveedor está desactivado');
    if (!supplier.providesCuttingService) {
      throw new BadRequestException('El proveedor no presta servicio de corte tercerizado (RF-81)');
    }

    const coilIds = input.coils.map((c) => c.coilId);
    if (new Set(coilIds).size !== coilIds.length) {
      throw new BadRequestException('No se puede enviar la misma bobina dos veces en una orden');
    }

    const orderId = await this.prisma.$transaction(async (tx) => {
      // Lock en orden determinístico: evita interbloqueos si dos envíos comparten bobinas
      // (lo cual además fallará más abajo porque una ya no estará OPEN).
      const sortedIds = [...coilIds].sort();
      await tx.$queryRaw`
        SELECT "id" FROM "coils" WHERE "id" = ANY(${sortedIds}::uuid[]) ORDER BY "id" FOR UPDATE
      `;
      const coils = await tx.coil.findMany({ where: { id: { in: coilIds } } });
      const byId = new Map(coils.map((c) => [c.id, c]));

      let businessLineId: string | null = null;
      for (const item of input.coils) {
        const coil = byId.get(item.coilId);
        if (!coil) throw new NotFoundException(`Bobina ${item.coilId} no encontrada`);
        if (coil.kind !== CoilKind.COIL) {
          throw new BadRequestException(`${coil.code}: solo se envían bobinas a corte, no flejes`);
        }
        if (coil.status !== CoilStatus.OPEN) {
          throw new BadRequestException(
            `${coil.code} no está disponible (${coil.status}): solo bobinas abiertas se envían a corte`,
          );
        }
        validateWidthBudget(
          coil.widthMm.toString(),
          item.widthPlanMm,
          item.expectedKerfLossMm,
          coil.code,
        );
        if (businessLineId === null) businessLineId = coil.businessLineId;
        else if (businessLineId !== coil.businessLineId) {
          throw new BadRequestException(
            'Todas las bobinas de una orden de corte deben ser de la misma línea de negocio',
          );
        }
      }
      if (!businessLineId) throw new BadRequestException('La orden necesita al menos una bobina');

      // D-066: enviar a un tercero no mueve kardex (D-050), así que la invariante de
      // cantidad de `InventoryService` no ve nada — y sin embargo el material prometido a
      // un pedido deja de estar disponible. Es el mismo hueco que D-060 tapó para las
      // asignaciones de producción, aplicado ahora al ledger de reservas. Las filas ya
      // están bloqueadas unas líneas más arriba, en el mismo orden.
      await assertNotReserved(
        tx,
        coilIds.map((id) => ({ itemType: InventoryItemType.COIL, itemId: id })),
        'enviarla a corte',
      );

      const order = await tx.cuttingOrder.create({
        data: {
          supplierId: input.supplierId,
          businessLineId,
          status: CuttingOrderStatus.SENT,
          notes: input.notes ?? null,
          createdById: actor.id,
        },
      });

      for (const item of input.coils) {
        await tx.cuttingOrderCoil.create({
          data: {
            cuttingOrderId: order.id,
            coilId: item.coilId,
            widthPlanMm: item.widthPlanMm,
            expectedKerfLossMm: toFixedString(item.expectedKerfLossMm, 'MM'),
            status: CuttingOrderCoilStatus.SENT,
            createdById: actor.id,
          },
        });
        await tx.coil.update({
          where: { id: item.coilId },
          data: { status: CoilStatus.IN_THIRD_PARTY },
        });
      }

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'cutting.send',
        entity: 'cutting_orders',
        entityId: order.id,
        after: {
          supplierId: input.supplierId,
          coils: input.coils.map((c) => c.coilId),
        },
      });

      return order.id;
    });

    return this.findOne(orderId);
  }

  // -------------------------------------------------------------------------
  // RF-41 — recibir flejes (permite parcial, por bobina)
  // -------------------------------------------------------------------------

  async receive(
    actor: RequestUser,
    cuttingOrderId: string,
    coilId: string,
    input: ReceiveCuttingOrderCoilInput,
  ): Promise<CuttingOrderDto> {
    await this.prisma.$transaction(
      async (tx) => {
        const row = await tx.cuttingOrderCoil.findFirst({ where: { cuttingOrderId, coilId } });
        if (!row) throw new NotFoundException('La bobina no pertenece a esa orden de corte');

        await tx.$queryRaw`
          SELECT "id" FROM "cutting_order_coils" WHERE "id" = ${row.id}::uuid FOR UPDATE
        `;
        const fresh = await tx.cuttingOrderCoil.findUniqueOrThrow({ where: { id: row.id } });
        if (fresh.status !== CuttingOrderCoilStatus.SENT) {
          throw new BadRequestException(
            `Esta bobina de la orden ya está ${fresh.status === CuttingOrderCoilStatus.RECEIVED ? 'recibida' : 'anulada'}`,
          );
        }

        const coil = await this.coils.lockCoil(tx, coilId);
        if (coil.status !== CoilStatus.IN_THIRD_PARTY) {
          throw new BadRequestException('La bobina no figura enviada a corte tercerizado');
        }

        const balance = await tx.inventoryBalance.findUnique({
          where: { itemType_itemId: { itemType: 'COIL', itemId: coil.id } },
        });
        const availableKg = toDecimal(balance?.qty.toString() ?? '0');

        const plan = planCoilSplit({
          parentWidthMm: coil.widthMm.toString(),
          availableKg,
          splitWeightKg: input.receivedWeightKg,
          kerfLossMm: input.kerfLossMm,
          widthsMm: expandWidthCounts(input.receivedWidthsMm),
        });

        // La salida sale al promedio ponderado vigente de la madre (D-028), igual que el
        // partido interno: la empresa nunca dejó de ser dueña de esos kilos (D-050).
        const out = await this.inventory.record(tx, {
          businessLineId: coil.businessLineId,
          itemType: 'COIL',
          itemId: coil.id,
          type: 'OUT',
          qty: toFixedString(plan.splitWeightKg, 'KG'),
          unit: Unit.KGM,
          refType: 'CUTTING',
          refId: row.id,
          notes: `Recepción de corte tercerizado en ${plan.children.length} flejes`,
          actorId: actor.id,
        });
        if (!out) {
          throw new BadRequestException('La línea de negocio de la bobina no lleva inventario');
        }
        const unitCostPen = out.unitCost.toFixed(4);

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
                // El costo del documento se hereda (igual que el partido, RF-15); el del
                // kardex es el promedio vigente de la madre, de donde salieron los kilos.
                unitCostPerKg: coil.unitCostPerKg.toFixed(4),
                kardexUnitCostPen: unitCostPen,
                refType: 'CUTTING',
                refId: row.id,
                parentCoilId: coil.id,
                kind: CoilKind.STRIP,
                cuttingOrderCoilId: row.id,
                actorId: actor.id,
              },
              { ...batch, sequence: batch.sequence + index },
            ),
          );
        }

        // La madre vuelve de `IN_THIRD_PARTY`: si no le quedó nada, se cierra (RF-19);
        // si le sobró material, vuelve a estar `OPEN` y disponible en planta.
        const remaining = availableKg.minus(plan.splitWeightKg);
        await tx.coil.update({
          where: { id: coil.id },
          data: { status: remaining.lte(0) ? CoilStatus.CLOSED : CoilStatus.OPEN },
        });

        await tx.cuttingOrderCoil.update({
          where: { id: row.id },
          data: {
            status: CuttingOrderCoilStatus.RECEIVED,
            receivedAt: new Date(),
            receivedWidthsMm: input.receivedWidthsMm,
            receivedWeightKg: toFixedString(plan.splitWeightKg, 'KG'),
            receivedKerfLossMm: toFixedString(plan.kerfLossMm, 'MM'),
            receivedKerfLossKg: toFixedString(plan.kerfLossKg, 'KG'),
            // Si esta fila ya se había recibido y revertido antes (Fase 3b), esta
            // recepción nueva reemplaza a la anterior: el rastro de la reversa pasada
            // no aplica a lo que se acaba de recibir.
            revertedById: null,
            revertedAt: null,
          },
        });

        await this.recomputeOrderStatus(tx, cuttingOrderId);

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'cutting.receive',
          entity: 'cutting_orders',
          entityId: cuttingOrderId,
          before: { coilId, status: fresh.status },
          after: {
            coilId,
            strips: children.map((c) => c.code),
            receivedWeightKg: toFixedString(plan.splitWeightKg, 'KG'),
            kerfLossKg: toFixedString(plan.kerfLossKg, 'KG'),
          },
        });
      },
      { timeout: 30_000 },
    );

    return this.findOne(cuttingOrderId);
  }

  // -------------------------------------------------------------------------
  // Fase 3b — revertir una recepción (simétrico a RF-16)
  // -------------------------------------------------------------------------

  /**
   * Deshace la recepción de UNA bobina de la orden (RF-41 a la inversa): anula los
   * flejes que creó y devuelve el saldo a la madre, con el mismo criterio "todo o
   * nada" que RF-16 (revertir un partido) — si algún fleje ya se movió (consumo,
   * venta, otro partido), falla completa nombrándolo. La fila vuelve a `SENT`: el
   * envío sigue vivo, así que se puede recibir de nuevo o cancelar (RF-22).
   *
   * Guardrail propio de D-050 que RF-16 no necesita: la madre puede haberse vuelto a
   * enviar a OTRA orden de corte desde que se recibió esta (`send()` no deja rastro de
   * kardex), así que además de "sin movimientos posteriores" se exige que su estado
   * actual sea `OPEN` o `CLOSED` — nunca `IN_THIRD_PARTY` de otro envío, nunca
   * `CANCELLED`. Con ambos guardrails en verde, el envío queda vivo por construcción:
   * la bobina vuelve a `IN_THIRD_PARTY`, nunca a un "disponible" ambiguo.
   */
  async reverse(
    actor: RequestUser,
    cuttingOrderId: string,
    coilId: string,
    reason: string,
  ): Promise<CuttingOrderDto> {
    await this.prisma.$transaction(
      async (tx) => {
        const row = await tx.cuttingOrderCoil.findFirst({ where: { cuttingOrderId, coilId } });
        if (!row) throw new NotFoundException('La bobina no pertenece a esa orden de corte');

        await tx.$queryRaw`
          SELECT "id" FROM "cutting_order_coils" WHERE "id" = ${row.id}::uuid FOR UPDATE
        `;
        const fresh = await tx.cuttingOrderCoil.findUniqueOrThrow({ where: { id: row.id } });
        if (fresh.status !== CuttingOrderCoilStatus.RECEIVED) {
          throw new BadRequestException(
            fresh.status === CuttingOrderCoilStatus.SENT
              ? 'Esta bobina de la orden todavía no se recibió: no hay nada que revertir'
              : 'Esta bobina de la orden está cancelada: no hay nada que revertir',
          );
        }

        const coil = await this.coils.lockCoil(tx, coilId);
        if (coil.status === CoilStatus.IN_THIRD_PARTY) {
          throw new BadRequestException(
            `${coil.code} está enviada a otra orden de corte: no se puede revertir esta recepción mientras siga allá`,
          );
        }
        if (coil.status === CoilStatus.CANCELLED) {
          throw new BadRequestException(`${coil.code} está anulada`);
        }

        const all = await tx.inventoryMovement.findMany({
          where: { refType: 'CUTTING', refId: row.id },
          orderBy: { id: 'asc' },
          include: { reversals: { select: { id: true } } },
        });
        const movementIds = new Set(all.map((m) => m.id));
        // Igual que RF-16: los pares movimiento+reversa que ya se cancelaron entre sí
        // (por ejemplo un recosteo posterior) no cuentan para nada de lo que sigue.
        const movements = liveMovements(all);
        const motherOut = movements.find((m) => m.itemId === coilId && m.type === 'OUT');
        if (!motherOut) {
          throw new BadRequestException(
            'Esta recepción no tiene un movimiento de kardex que revertir',
          );
        }

        // Los flejes de ESTA generación, no todos los que alguna vez colgaron de la
        // fila: si ya se recibió, revirtió y volvió a recibir antes, `cuttingOrderCoilId`
        // también apunta a los flejes `CANCELLED` de la vez anterior. `movements` ya
        // viene acotado por `liveMovements` a los vivos de esta recepción puntual.
        const stripIds = movements.filter((m) => m.type === 'IN').map((m) => m.itemId);
        const strips = await tx.coil.findMany({ where: { id: { in: stripIds } } });

        // D-060: un fleje montado en una orden de producción no deja rastro de kardex
        // (igual que el envío a corte de D-050 no lo deja), así que el chequeo de
        // movimientos posteriores de más abajo no lo vería. Es el mismo hueco que este
        // método ya tuvo que tapar a mano con `IN_THIRD_PARTY` sobre la madre.
        await assertStripsNotAssigned(tx, stripIds, 'revertir la recepción');

        // Los flejes: mismo criterio "todo o nada" que RF-16 con las hijas de un
        // partido. Si uno ya se consumió, se vendió o se volvió a partir, devolver su
        // peso a la madre inventariaría kilos que ya no existen.
        for (const strip of strips) {
          const extra = await tx.inventoryMovement.findMany({
            where: {
              itemType: 'COIL',
              itemId: strip.id,
              ...(movementIds.size > 0 ? { id: { notIn: [...movementIds] } } : {}),
            },
            orderBy: { id: 'asc' },
            include: { reversals: { select: { id: true } } },
          });
          const blocking = liveMovements(extra)[0];
          if (blocking) {
            throw new BadRequestException(
              `El fleje ${strip.code} ya tiene movimientos posteriores (${blocking.refType}): anúlalos antes de revertir la recepción`,
            );
          }
        }

        // La madre: guardrail propio de esta reversa (D-050). Un envío a otra orden no
        // deja movimiento, así que hay que chequear explícitamente lo que sí queda
        // rastro: cualquier movimiento de la madre posterior a la salida que se está
        // revirtiendo (otro partido, otra merma, otra recepción de corte).
        const motherMovements = await tx.inventoryMovement.findMany({
          where: { itemType: 'COIL', itemId: coilId },
          orderBy: { id: 'asc' },
          include: { reversals: { select: { id: true } } },
        });
        const motherBlocking = liveMovements(motherMovements).find((m) => m.id > motherOut.id);
        if (motherBlocking) {
          throw new BadRequestException(
            `${coil.code} ya tuvo movimientos posteriores a esta recepción (${motherBlocking.refType}): no se puede revertir`,
          );
        }

        // Primero las entradas de los flejes y al final la salida de la madre: al
        // revés, la madre recuperaría el peso antes de que los flejes lo devuelvan.
        for (const movement of movements.filter((m) => m.type === 'IN')) {
          await this.inventory.reverse(tx, movement.id, actor.id, reason);
        }
        await this.inventory.reverse(tx, motherOut.id, actor.id, reason);

        await tx.coil.updateMany({
          where: { id: { in: stripIds } },
          data: { status: CoilStatus.CANCELLED },
        });

        await tx.cuttingOrderCoil.update({
          where: { id: row.id },
          data: {
            status: CuttingOrderCoilStatus.SENT,
            receivedAt: null,
            receivedWidthsMm: Prisma.JsonNull,
            receivedWeightKg: null,
            receivedKerfLossMm: null,
            receivedKerfLossKg: null,
            revertedById: actor.id,
            revertedAt: new Date(),
          },
        });

        // El envío sigue vivo (la fila vuelve a SENT): la bobina vuelve a estar en
        // poder del tercero, a la espera de una recepción correcta.
        await tx.coil.update({
          where: { id: coilId },
          data: { status: CoilStatus.IN_THIRD_PARTY },
        });

        await this.recomputeOrderStatus(tx, cuttingOrderId);

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'cutting.receive-reverse',
          entity: 'cutting_orders',
          entityId: cuttingOrderId,
          before: { coilId, status: fresh.status },
          after: {
            coilId,
            status: CuttingOrderCoilStatus.SENT,
            reason,
            cancelledStrips: strips.map((s) => s.code),
          },
        });
      },
      { timeout: 30_000 },
    );

    return this.findOne(cuttingOrderId);
  }

  // -------------------------------------------------------------------------
  // RF-22 — cancelar (lo no recibido)
  // -------------------------------------------------------------------------

  async cancel(
    actor: RequestUser,
    cuttingOrderId: string,
    reason: string,
  ): Promise<CuttingOrderDto> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "cutting_orders" WHERE "id" = ${cuttingOrderId}::uuid FOR UPDATE
      `;
      const order = await tx.cuttingOrder.findUnique({
        where: { id: cuttingOrderId },
        include: { coils: true },
      });
      if (!order) throw new NotFoundException('Orden de corte no encontrada');
      if (order.status === CuttingOrderStatus.CANCELLED) {
        throw new BadRequestException('La orden ya está anulada');
      }
      if (order.status === CuttingOrderStatus.RECEIVED) {
        throw new BadRequestException(
          'La orden ya se recibió por completo: no queda nada pendiente',
        );
      }

      const pending = order.coils.filter((c) => c.status === CuttingOrderCoilStatus.SENT);
      if (pending.length === 0) {
        throw new BadRequestException('No hay bobinas pendientes de recepción en esta orden');
      }

      for (const row of pending) {
        await tx.cuttingOrderCoil.update({
          where: { id: row.id },
          data: { status: CuttingOrderCoilStatus.CANCELLED, cancelledAt: new Date() },
        });
        // La bobina no tuvo ningún movimiento de kardex (D-050): vuelve a OPEN sin reversa.
        await tx.coil.update({ where: { id: row.coilId }, data: { status: CoilStatus.OPEN } });
      }

      await this.recomputeOrderStatus(tx, cuttingOrderId);
      const refreshed = await tx.cuttingOrder.findUniqueOrThrow({ where: { id: cuttingOrderId } });
      if (refreshed.status === CuttingOrderStatus.CANCELLED) {
        await tx.cuttingOrder.update({
          where: { id: cuttingOrderId },
          data: { cancelledAt: new Date() },
        });
      }

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'cutting.cancel',
        entity: 'cutting_orders',
        entityId: cuttingOrderId,
        before: { status: order.status },
        after: { status: refreshed.status, reason, cancelledCoils: pending.length },
      });
    });

    return this.findOne(cuttingOrderId);
  }

  // -------------------------------------------------------------------------
  // Consultas
  // -------------------------------------------------------------------------

  async findAll(query: CuttingOrderQuery): Promise<CuttingOrderListItemDto[]> {
    const orders = await this.prisma.cuttingOrder.findMany({
      where: {
        businessLine: query.businessLine
          ? { code: toPrismaLineCode(query.businessLine) }
          : undefined,
        supplierId: query.supplierId,
        status: query.status,
      },
      include: {
        supplier: { select: { name: true } },
        businessLine: { select: { code: true } },
        _count: { select: { coils: true } },
      },
      orderBy: { sentAt: 'desc' },
      take: 500,
    });

    return orders.map((o) => ({
      id: o.id,
      supplierId: o.supplierId,
      supplierName: o.supplier.name,
      businessLine: toSharedLineCode(o.businessLine.code),
      status: o.status,
      sentAt: o.sentAt.toISOString(),
      cancelledAt: o.cancelledAt ? o.cancelledAt.toISOString() : null,
      notes: o.notes,
      coilCount: o._count.coils,
      createdAt: o.createdAt.toISOString(),
    }));
  }

  async findOne(id: string): Promise<CuttingOrderDto> {
    const order = await this.prisma.cuttingOrder.findUnique({
      where: { id },
      include: {
        supplier: { select: { name: true } },
        businessLine: { select: { code: true } },
        coils: {
          include: {
            coil: { select: { code: true, widthMm: true } },
            // Excluye los flejes CANCELLED de una recepción anterior de la misma fila
            // (revertida y vuelta a recibir): sin este filtro se mezclan con los vivos
            // de la recepción actual, sin ninguna marca que los distinga en la UI.
            strips: {
              where: { status: { not: CoilStatus.CANCELLED } },
              select: { id: true, code: true, widthMm: true, weightKg: true },
              orderBy: { code: 'asc' },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        purchases: {
          select: {
            id: true,
            series: true,
            number: true,
            status: true,
            subtotal: true,
            exchangeRate: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!order) throw new NotFoundException('Orden de corte no encontrada');

    const balances = await this.prisma.inventoryBalance.findMany({
      where: { itemType: 'COIL', itemId: { in: order.coils.map((c) => c.coilId) } },
      select: { itemId: true, qty: true },
    });
    const availableKg = new Map(balances.map((b) => [b.itemId, b.qty.toFixed(3)]));

    return {
      id: order.id,
      supplierId: order.supplierId,
      supplierName: order.supplier.name,
      businessLine: toSharedLineCode(order.businessLine.code),
      status: order.status,
      sentAt: order.sentAt.toISOString(),
      cancelledAt: order.cancelledAt ? order.cancelledAt.toISOString() : null,
      notes: order.notes,
      services: order.purchases.map((p) => ({
        purchaseId: p.id,
        documentLabel: `${p.series}-${p.number}`,
        status: p.status,
        // Sin IGV (D-038) y en soles (D-042): lo que se prorrateó al recibirse.
        amountPen: toFixedString(
          toDecimal(p.subtotal.toString()).times(p.exchangeRate.toString()),
          'MONEY',
        ),
      })),
      coils: order.coils.map((row) => ({
        id: row.id,
        cuttingOrderId: row.cuttingOrderId,
        coilId: row.coilId,
        coilCode: row.coil.code,
        coilWidthMm: row.coil.widthMm.toFixed(2),
        coilAvailableKg: availableKg.get(row.coilId) ?? '0.000',
        widthPlanMm: row.widthPlanMm as unknown as WidthCount[],
        expectedKerfLossMm: row.expectedKerfLossMm.toFixed(2),
        status: row.status,
        receivedAt: row.receivedAt ? row.receivedAt.toISOString() : null,
        receivedWidthsMm: row.receivedWidthsMm as unknown as WidthCount[] | null,
        receivedWeightKg: row.receivedWeightKg ? row.receivedWeightKg.toFixed(3) : null,
        receivedKerfLossMm: row.receivedKerfLossMm ? row.receivedKerfLossMm.toFixed(2) : null,
        receivedKerfLossKg: row.receivedKerfLossKg ? row.receivedKerfLossKg.toFixed(3) : null,
        cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
        revertedAt: row.revertedAt ? row.revertedAt.toISOString() : null,
        strips: row.strips.map((s) => ({
          id: s.id,
          code: s.code,
          widthMm: s.widthMm.toFixed(2),
          weightKg: s.weightKg.toFixed(3),
        })),
        createdAt: row.createdAt.toISOString(),
      })),
      createdAt: order.createdAt.toISOString(),
    };
  }

  /** Stock de flejes por ancho (RF-42): agrupa por `typeKey` + `widthMm`. */
  async stripStock(query: StripStockQuery, showCosts: boolean): Promise<StripStockRowDto[]> {
    const coils = await this.prisma.coil.findMany({
      where: {
        kind: CoilKind.STRIP,
        status: { not: CoilStatus.CANCELLED },
        businessLine: query.businessLine
          ? { code: toPrismaLineCode(query.businessLine) }
          : undefined,
      },
      select: {
        id: true,
        typeKey: true,
        widthMm: true,
        thicknessMm: true,
        finish: { select: { code: true } },
      },
      take: 5000,
    });
    if (coils.length === 0) return [];

    const balances = await this.prisma.inventoryBalance.findMany({
      where: { itemType: 'COIL', itemId: { in: coils.map((c) => c.id) } },
    });
    const balanceById = new Map(balances.map((b) => [b.itemId, b]));

    const groups = new Map<
      string,
      {
        typeKey: string;
        finishCode: string;
        thicknessMm: string;
        widthMm: string;
        qty: Decimal;
        value: Decimal;
        count: number;
      }
    >();

    for (const coil of coils) {
      const balance = balanceById.get(coil.id);
      const qty = balance ? toDecimal(balance.qty.toString()) : new Decimal(0);
      if (qty.lte(0)) continue;
      const avgCost = balance ? toDecimal(balance.avgCost.toString()) : new Decimal(0);
      const key = `${coil.typeKey}|${coil.widthMm.toFixed(2)}`;
      const value = qty.times(avgCost);
      const current = groups.get(key);
      if (current) {
        current.qty = current.qty.plus(qty);
        current.value = current.value.plus(value);
        current.count += 1;
      } else {
        groups.set(key, {
          typeKey: coil.typeKey,
          finishCode: coil.finish.code,
          thicknessMm: coil.thicknessMm.toFixed(2),
          widthMm: coil.widthMm.toFixed(2),
          qty,
          value,
          count: 1,
        });
      }
    }

    const rows = [...groups.values()].map((g) => ({
      typeKey: g.typeKey,
      finishCode: g.finishCode,
      thicknessMm: g.thicknessMm,
      widthMm: g.widthMm,
      qtyKg: g.qty.toFixed(3),
      avgCostPen: showCosts
        ? toFixedString(g.qty.lte(0) ? new Decimal(0) : g.value.div(g.qty), 'MONEY')
        : null,
      totalValuePen: showCosts ? toFixedString(g.value, 'MONEY') : null,
      coilCount: g.count,
    }));
    rows.sort((a, b) => a.typeKey.localeCompare(b.typeKey) || a.widthMm.localeCompare(b.widthMm));
    return rows;
  }

  // -------------------------------------------------------------------------
  // Utilidades comunes
  // -------------------------------------------------------------------------

  private async recomputeOrderStatus(
    tx: Prisma.TransactionClient,
    cuttingOrderId: string,
  ): Promise<void> {
    const rows = await tx.cuttingOrderCoil.findMany({
      where: { cuttingOrderId },
      select: { status: true },
    });
    const status = deriveCuttingOrderStatus(rows.map((r) => r.status));
    await tx.cuttingOrder.update({ where: { id: cuttingOrderId }, data: { status } });
  }
}
