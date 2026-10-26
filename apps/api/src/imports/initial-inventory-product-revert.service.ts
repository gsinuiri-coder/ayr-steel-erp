import { BadRequestException, Injectable } from '@nestjs/common';
import { InventoryItemType, type Prisma } from '@prisma/client';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { OperationDateService } from '../common/operation-date.service';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { revertEntryErrors } from './initial-inventory-product-revert';

export interface RevertInput {
  batchId: string;
  execute: boolean;
  operationDate?: string;
  reason: string;
}

export interface RevertRowSummary {
  movementId: string;
  sku: string;
  qty: string;
  unit: string;
  totalCost: string;
  ok: boolean;
  errors: string[];
  reversed: boolean;
}

export interface RevertReport {
  batchId: string;
  operationDate: string;
  ok: boolean;
  executed: boolean;
  rows: RevertRowSummary[];
}

type Db = Prisma.TransactionClient | PrismaService;

interface Entry {
  id: bigint;
  businessLineId: string;
  itemId: string;
  qty: Prisma.Decimal;
  unit: string;
  totalCost: Prisma.Decimal;
}

/**
 * cc68 (D-722): la **reversa** de un lote de la carga inicial de productos (D-206/D-207, D-712).
 * Regla dura 15: la operación directa existía sin su reversa; esta es esa reversa, con las mismas
 * condiciones de la carga — sin controller (solo el CLI de arranque), dry-run por defecto, todo o
 * nada y por la puerta `InventoryService.reverse` (regla dura 8), nunca editando el kardex.
 *
 * Revierte cada entrada `IN`/`IMPORT` del lote (`refId` = id del lote) con la fecha de operación
 * pedida. Rechaza el lote entero si alguna entrada ya se usó (`revertEntryErrors`): una carga que
 * alguien vendió, ajustó o reservó no se borra por esta vía.
 */
@Injectable()
export class InitialInventoryProductRevertService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
    private readonly operationDateService: OperationDateService,
  ) {}

  async revert(actor: RequestUser, input: RevertInput): Promise<RevertReport> {
    const operationDate = this.operationDateService.resolve(actor, input.operationDate);
    const reason = input.reason.trim();
    if (reason === '') throw new BadRequestException('Falta el motivo de la reversa');

    const plan = await this.plan(this.prisma, input.batchId);
    if (!plan.ok || !input.execute) {
      return {
        batchId: input.batchId,
        operationDate,
        ok: plan.ok,
        executed: false,
        rows: plan.rows,
      };
    }

    const rows = await this.prisma.$transaction(
      async (tx) => {
        // Regla dura 17: los saldos del lote, en orden, antes de leer lo que se decide (D-474).
        await this.inventory.lockInOrder(tx, {
          items: plan.entries.map((e) => ({
            businessLineId: e.businessLineId,
            itemType: InventoryItemType.PRODUCT,
            itemId: e.itemId,
            unit: e.unit,
          })),
        });
        const locked = await this.plan(tx, input.batchId);
        if (!locked.ok) {
          throw new BadRequestException(
            `El lote cambió mientras se revertía: ${locked.rows.flatMap((r) => r.errors).join('; ')}`,
          );
        }
        for (const entry of locked.entries) {
          await this.inventory.reverse(tx, entry.id, actor.id, reason, operationDate, true);
        }
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'imports.initial-inventory-products.revert',
          entity: 'products',
          entityId: null,
          after: {
            batchId: input.batchId,
            operationDate,
            reason,
            count: locked.entries.length,
            movementIds: locked.entries.map((e) => e.id.toString()),
          },
        });
        return locked.rows.map((r) => ({ ...r, reversed: true }));
      },
      { timeout: 300_000, maxWait: 20_000 },
    );
    return { batchId: input.batchId, operationDate, ok: true, executed: true, rows };
  }

  /** Las entradas del lote y por qué no se pueden revertir (vacío si se puede). */
  private async plan(
    db: Db,
    batchId: string,
  ): Promise<{ ok: boolean; entries: Entry[]; rows: RevertRowSummary[] }> {
    const entries: Entry[] = await db.inventoryMovement.findMany({
      where: {
        itemType: InventoryItemType.PRODUCT,
        type: 'IN',
        refType: 'IMPORT',
        refId: batchId,
        reversalOfId: null,
      },
      select: {
        id: true,
        businessLineId: true,
        itemId: true,
        qty: true,
        unit: true,
        totalCost: true,
      },
      orderBy: { id: 'asc' },
    });
    if (entries.length === 0) {
      throw new BadRequestException(
        `No hay entradas de carga inicial de productos con el lote ${batchId}`,
      );
    }
    const itemIds = entries.map((e) => e.itemId);
    const entryIds = entries.map((e) => e.id);
    const [products, others, reservations, quotationReservations] = await Promise.all([
      db.product.findMany({ where: { id: { in: itemIds } }, select: { id: true, sku: true } }),
      db.inventoryMovement.findMany({
        where: {
          itemType: InventoryItemType.PRODUCT,
          itemId: { in: itemIds },
          id: { notIn: entryIds },
        },
        select: { itemId: true, reversalOfId: true },
      }),
      db.reservation.groupBy({
        by: ['itemId'],
        where: { itemType: InventoryItemType.PRODUCT, itemId: { in: itemIds }, status: 'ACTIVE' },
        _count: { _all: true },
      }),
      db.quotationReservation.groupBy({
        by: ['itemId'],
        where: {
          itemType: InventoryItemType.PRODUCT,
          itemId: { in: itemIds },
          status: 'ACTIVE',
          expiresAt: { gt: new Date() },
        },
        _count: { _all: true },
      }),
    ]);
    const skuOf = new Map(products.map((p) => [p.id, p.sku]));
    const reversedIds = new Set(
      others.filter((m) => m.reversalOfId !== null).map((m) => String(m.reversalOfId)),
    );
    const count = (rows: { itemId: string; _count: { _all: number } }[], id: string) =>
      rows.find((r) => r.itemId === id)?._count._all ?? 0;

    const rows = entries.map((e): RevertRowSummary => {
      const sku = skuOf.get(e.itemId) ?? e.itemId;
      const errors = revertEntryErrors({
        sku,
        alreadyReversed: reversedIds.has(e.id.toString()),
        laterMovements: others.filter(
          (m) => m.itemId === e.itemId && String(m.reversalOfId) !== e.id.toString(),
        ).length,
        activeReservations: count(reservations, e.itemId),
        activeQuotationReservations: count(quotationReservations, e.itemId),
      });
      return {
        movementId: e.id.toString(),
        sku,
        qty: e.qty.toFixed(3),
        unit: e.unit,
        totalCost: e.totalCost.toFixed(2),
        ok: errors.length === 0,
        errors,
        reversed: false,
      };
    });
    return { ok: rows.every((r) => r.ok), entries, rows };
  }
}
