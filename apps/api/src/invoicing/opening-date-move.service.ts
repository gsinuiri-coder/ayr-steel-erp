import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { DispatchStatus, Prisma } from '@prisma/client';
import { carriesInventory, Decimal, dispatchCode, salesOrderCode, toDecimal } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { OperationDateService } from '../common/operation-date.service';
import { PrismaService } from '../prisma/prisma.service';
import { reservedByItem } from '../sales/reserved-ledger';
import { DispatchesService } from './dispatches.service';
import type { PlanItemKardex } from './invoice-dispatch-plan';
import {
  InvoiceDispatchService,
  planSignature,
  type InvoiceDispatchPlan,
} from './invoice-dispatch.service';
import {
  acceptedOuts,
  assertOpeningMoveNotApplied,
  OPENING_MOVE_ACTION,
  OPENING_MOVE_LOCK,
  OPENING_MOVE_REASON,
  planMissingOuts,
  planOpeningMoves,
  type OpeningMove,
  type PlannedMissingOut,
} from './opening-date-move';

const day = (value: Date): string => value.toISOString().slice(0, 10);

/** Motivo de la salida que se agrega a un despacho que se registró sin ella (D-285). */
export const ADDED_OUT_REASON =
  'despacho a la fecha del comprobante (salida agregada al refechar el inventario inicial, D-285)';

export interface AddedOut extends PlannedMissingOut {
  orderCode: string;
  dispatchCode: string;
  sku: string;
  label: string;
  costPen: Decimal;
}

export interface OpeningDateMovePlan {
  target: string;
  moves: OpeningMove[];
  added: AddedOut[];
  dispatch: InvoiceDispatchPlan;
  /** Costo promedio vigente por ítem: el de la salida (una salida sale al promedio, D-028). */
  avgCost: Map<string, Decimal>;
}

/**
 * D-285: la fecha efectiva del inventario inicial y lo que destraba.
 *
 * Tres pasos, en este orden y cada uno por su servicio de dominio:
 * 1. la carga inicial de cada ítem que lo admite pasa al `HISTORICAL_LOAD_START` (la única
 *    escritura fuera de `InventoryService.record`: la migración del trigger la admite solo con
 *    `SET LOCAL ayr.opening_date_move = 'on'`, que se declara únicamente acá);
 * 2. las líneas despachadas sin salida (lo «entregado antes del inventario inicial» de D-278)
 *    reciben su `OUT` por `DispatchesService.addMissingMovementInTx`;
 * 3. lo facturado sin despacho se despacha por `InvoiceDispatchService` (con la regla de la
 *    fecha del parte de producción).
 * El dry-run simula los tres sobre el kardex, en el orden de la base, sin escribir.
 */
@Injectable()
export class OpeningDateMoveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatches: DispatchesService,
    private readonly invoiceDispatch: InvoiceDispatchService,
    private readonly audit: AuditService,
    private readonly operationDate: OperationDateService,
  ) {}

  async plan(): Promise<OpeningDateMovePlan> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await this.assertNotApplied(tx);
        return this.buildPlan(tx);
      },
      { timeout: 180_000 },
    );
  }

  async buildPlan(tx: Prisma.TransactionClient): Promise<OpeningDateMovePlan> {
    const target = this.operationDate.historicalLoadStart;

    // 1. La carga inicial por ítem, y el primer movimiento que no lo es.
    const imports = await tx.inventoryMovement.findMany({
      where: { refType: 'IMPORT', type: 'IN' },
      orderBy: [{ operationDate: 'asc' }, { id: 'asc' }],
      select: { id: true, itemType: true, itemId: true, operationDate: true },
    });
    const importItemIds = [...new Set(imports.map((m) => m.itemId))];
    const others = await tx.inventoryMovement.groupBy({
      by: ['itemType', 'itemId'],
      where: { itemId: { in: importItemIds }, refType: { not: 'IMPORT' } },
      _min: { operationDate: true },
    });
    const earliestOther = new Map(
      others.map((o) => [
        `${o.itemType}:${o.itemId}`,
        o._min.operationDate === null ? null : day(o._min.operationDate),
      ]),
    );
    const labels = await this.labels(tx, importItemIds);
    const byItem = new Map<string, { id: string; date: string }[]>();
    for (const m of imports) {
      const key = `${m.itemType}:${m.itemId}`;
      byItem.set(key, [
        ...(byItem.get(key) ?? []),
        { id: m.id.toString(), date: day(m.operationDate) },
      ]);
    }
    const moves = planOpeningMoves(
      [...byItem].map(([key, list]) => ({
        key,
        label: labels.get(key.split(':')[1] ?? '') ?? key,
        imports: list,
        earliestOther: earliestOther.get(key) ?? null,
      })),
      target,
    ).sort((a, b) => a.label.localeCompare(b.label));
    const movedOpening = new Map<string, string>();
    for (const mv of moves) {
      if (mv.action === 'MOVE') for (const id of mv.movementIds) movedOpening.set(id, target);
    }

    // 2. Las líneas despachadas sin salida de kardex.
    const missingRows = await tx.dispatchItem.findMany({
      where: { movementId: null, dispatch: { status: DispatchStatus.ISSUED } },
      select: {
        id: true,
        itemType: true,
        itemId: true,
        reserveQty: true,
        product: { select: { sku: true, businessLine: { select: { inventoryStrategy: true } } } },
        dispatch: {
          select: { seq: true, dispatchDate: true, salesOrder: { select: { seq: true } } },
        },
      },
    });
    // Solo productos (autorrevisión P2-3): una bobina tiene identidad y no se le agrega una
    // salida a ciegas; va a revisión.
    const inventoryRows = missingRows.filter((r) => carriesInventory(r.product.businessLine));
    const missing = inventoryRows.filter((r) => r.itemType === 'PRODUCT');
    const coilRows = inventoryRows.filter((r) => r.itemType !== 'PRODUCT');
    const missingIds = [...new Set(missing.map((m) => m.itemId))];
    const labelIds = [...new Set(inventoryRows.map((m) => m.itemId))];
    const kardex = await this.kardex(tx, missingIds, movedOpening);
    const plannedOuts = planMissingOuts(
      missing.map((m) => ({
        id: m.id,
        itemKey: `${m.itemType}:${m.itemId}`,
        date: day(m.dispatch.dispatchDate),
        qty: toDecimal(m.reserveQty.toString()),
      })),
      kardex,
      await this.headroom(tx, missingIds),
    );
    for (const c of coilRows) {
      plannedOuts.push({
        id: c.id,
        itemKey: `${c.itemType}:${c.itemId}`,
        date: day(c.dispatch.dispatchDate),
        qty: toDecimal(c.reserveQty.toString()),
        action: 'REVIEW',
        reason: 'Bobina despachada sin salida: se revisa a mano',
      });
    }
    const avgCost = await this.avgCosts(tx, [...new Set([...missingIds, ...importItemIds])]);
    const missingLabels = await this.labels(tx, labelIds);
    const rowById = new Map(inventoryRows.map((m) => [m.id, m]));
    const added: AddedOut[] = plannedOuts.map((p) => {
      const row = rowById.get(p.id);
      if (row === undefined) throw new Error('línea de despacho perdida');
      return {
        ...p,
        orderCode: salesOrderCode(row.dispatch.salesOrder.seq),
        dispatchCode: dispatchCode(row.dispatch.seq),
        sku: row.product.sku,
        label: missingLabels.get(row.itemId) ?? p.itemKey,
        costPen: p.qty.times(avgCost.get(p.itemKey) ?? new Decimal(0)),
      };
    });

    // 3. Lo facturado sin despacho, con la carga refechada y las salidas del paso 2 sumadas.
    const dispatch = await this.invoiceDispatch.buildPlan(
      tx,
      {},
      { movedOpening, priorOuts: acceptedOuts(plannedOuts) },
    );
    for (const info of dispatch.items.values()) avgCost.set(info.key, info.avgCost);
    return { target, moves, added, dispatch, avgCost };
  }

  /** Se niega si la auditoría de la ejecución ya existe (D-286: deshabilitada para siempre). */
  private async assertNotApplied(client: Prisma.TransactionClient): Promise<void> {
    const applied = await client.auditLog.findFirst({
      where: { action: OPENING_MOVE_ACTION },
      select: { id: true },
    });
    assertOpeningMoveNotApplied(applied !== null);
  }

  /**
   * Ejecuta los tres pasos. `expected` es la huella del dry-run: si la de ahora no coincide,
   * no escribe nada. Corre una sola vez (auditoría) y nunca dos a la vez: una transacción
   * aparte sostiene un advisory lock mientras duran los tres pasos (D-286).
   */
  async execute(actor: RequestUser, expected: string): Promise<OpeningDateMovePlan> {
    return this.prisma.$transaction(
      async (lockTx) => {
        const [lock] = await lockTx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext(${OPENING_MOVE_LOCK})) AS locked`;
        if (lock?.locked !== true) {
          throw new ConflictException(
            'La herramienta de D-285 ya está corriendo en otra sesión: no se escribe nada.',
          );
        }
        await this.assertNotApplied(lockTx);
        return this.executeLocked(actor, expected);
      },
      { timeout: 30 * 60_000 },
    );
  }

  private async executeLocked(actor: RequestUser, expected: string): Promise<OpeningDateMovePlan> {
    const plan = await this.prisma.$transaction((tx) => this.buildPlan(tx), { timeout: 180_000 });
    const toMove = plan.moves.filter((m) => m.action === 'MOVE');
    const now = openingPlanSignature(plan);
    if (now !== expected) {
      throw new BadRequestException(
        'El plan de ahora no coincide con el del dry-run: no se escribe nada.',
      );
    }

    // Paso 1, en una sola transacción: todos los movimientos o ninguno.
    if (toMove.length > 0)
      await this.prisma.$transaction(
        async (tx) => {
          await this.assertNotApplied(tx);
          // SET LOCAL: vale solo para esta transacción (migración 20260925010000).
          await tx.$queryRaw`SELECT set_config('ayr.opening_date_move', 'on', true)`;
          const to = new Date(`${plan.target}T00:00:00.000Z`);
          for (const mv of toMove) {
            for (const [i, id] of mv.movementIds.entries()) {
              await tx.inventoryMovement.update({
                where: { id: BigInt(id) },
                data: { operationDate: to },
              });
              await this.audit.write(tx, {
                actorId: actor.id,
                action: OPENING_MOVE_ACTION,
                entity: 'inventory_movements',
                entityId: id,
                before: { operationDate: mv.from[i] },
                after: { operationDate: plan.target, item: mv.label, reason: OPENING_MOVE_REASON },
              });
            }
          }
        },
        { timeout: 120_000 },
      );

    // Paso 2: una transacción por línea de despacho.
    for (const out of plan.added.filter((a) => a.action === 'ADD')) {
      await this.prisma.$transaction(
        (tx) => this.dispatches.addMissingMovementInTx(tx, actor, out.id, ADDED_OUT_REASON),
        { timeout: 60_000 },
      );
    }

    // Paso 3: una transacción por comprobante, cada uno comparando su plan con el del dry-run.
    for (const inv of plan.dispatch.invoices) {
      if (!inv.lines.some((l) => l.action !== 'REVIEW')) continue;
      await this.prisma.$transaction(
        (tx) => this.invoiceDispatch.executeInTx(tx, actor, inv.invoiceId, inv),
        { timeout: 120_000 },
      );
    }
    return plan;
  }

  private async kardex(
    tx: Prisma.TransactionClient,
    itemIds: string[],
    moved: ReadonlyMap<string, string>,
  ): Promise<Map<string, PlanItemKardex>> {
    const rows = await tx.inventoryMovement.findMany({
      where: { itemId: { in: itemIds } },
      select: {
        id: true,
        itemType: true,
        itemId: true,
        type: true,
        qty: true,
        refType: true,
        operationDate: true,
        at: true,
      },
    });
    const dated = rows
      .map((m) => ({ ...m, date: moved.get(m.id.toString()) ?? day(m.operationDate) }))
      .sort((a, b) =>
        a.date !== b.date
          ? a.date < b.date
            ? -1
            : 1
          : a.at.getTime() !== b.at.getTime()
            ? a.at.getTime() - b.at.getTime()
            : a.id < b.id
              ? -1
              : a.id > b.id
                ? 1
                : 0,
      );
    const out = new Map<string, PlanItemKardex>();
    for (const m of dated) {
      const key = `${m.itemType}:${m.itemId}`;
      const entry = out.get(key) ?? { openingDate: null, movements: [] };
      const qty = toDecimal(m.qty.toString());
      entry.movements.push({
        date: m.date,
        signedQty: m.type === 'IN' ? qty : m.type === 'OUT' ? qty.negated() : new Decimal(0),
      });
      if (m.type === 'IN' && m.refType === 'IMPORT' && entry.openingDate === null) {
        entry.openingDate = m.date;
      }
      out.set(key, entry);
    }
    return out;
  }

  /** Saldo de hoy menos lo reservado vivo (firme y temporal), por ítem de producto. */
  private async headroom(tx: Prisma.TransactionClient, productIds: string[]) {
    const [balances, reserved] = await Promise.all([
      tx.inventoryBalance.findMany({
        where: { itemType: 'PRODUCT', itemId: { in: productIds } },
        select: { itemId: true, qty: true },
      }),
      reservedByItem(tx, 'PRODUCT', productIds),
    ]);
    return new Map(
      balances.map((b) => [
        `PRODUCT:${b.itemId}`,
        toDecimal(b.qty.toString()).minus(reserved.get(b.itemId) ?? new Decimal(0)),
      ]),
    );
  }

  private async avgCosts(tx: Prisma.TransactionClient, itemIds: string[]) {
    const balances = await tx.inventoryBalance.findMany({
      where: { itemId: { in: itemIds } },
      select: { itemType: true, itemId: true, avgCost: true },
    });
    return new Map(
      balances.map((b) => [`${b.itemType}:${b.itemId}`, toDecimal(b.avgCost.toString())]),
    );
  }

  private async labels(tx: Prisma.TransactionClient, ids: string[]): Promise<Map<string, string>> {
    const [products, coils] = await Promise.all([
      tx.product.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true } }),
      tx.coil.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } }),
    ]);
    return new Map([
      ...products.map((p) => [p.id, p.sku] as [string, string]),
      ...coils.map((c) => [c.id, c.code] as [string, string]),
    ]);
  }
}

/** Huella del plan entero: lo que la ejecución tiene que reencontrar para escribir. */
export function openingPlanSignature(plan: OpeningDateMovePlan): string {
  return JSON.stringify({
    moves: plan.moves.map((m) => `${m.key}:${m.action}:${m.movementIds.join(',')}:${m.to}`),
    added: plan.added.map((a) => `${a.id}:${a.action}:${a.date}:${a.qty.toFixed(3)}`),
    dispatch: plan.dispatch.invoices.map((i) => `${i.number}=${planSignature(i)}`),
  });
}
