import { BadRequestException } from '@nestjs/common';
import type { InventoryMovement, Prisma } from '@prisma/client';
import { Decimal, productionOrderCode, toDecimal } from '@ayr/shared';
import type { AdjustCostInput, InventoryService } from '../inventory/inventory.service';
import { prorateDelta } from '../inventory/recost-engine';

/**
 * cc55 (D-665, E-01 de audit-01) — **el despunte de una OP cuyo producto ya salió.**
 *
 * El `ADJUST` de cierre (D-057/D-089) reparte el despunte y el residuo de redondeo sobre el saldo
 * del producto; sin saldo (todo despachado) `adjustCost` no escribe nada y ese costo se perdía: no
 * llegaba a ninguna venta. Acá se cargan, en cambio, a **las entradas de producto de los partes**
 * de la OP (en proporción a lo que cada una valía), por `InventoryService.recostEntries`: el recosteo
 * por fecha (D-649) lleva ese costo a las salidas que siguieron, el mismo día o después. Los
 * ajustes llevan `CLOSE_RECOST_NOTE` en la nota, que es lo que la reapertura mira.
 */
export const CLOSE_RECOST_NOTE_PREFIX = 'Cierre de';

export function closeRecostNote(orderSeq: number): string {
  return `${CLOSE_RECOST_NOTE_PREFIX} ${productionOrderCode(orderSeq)}: despunte sobre lo ya despachado (D-665)`;
}

export async function recostCloseIntoEntries(
  tx: Prisma.TransactionClient,
  inventory: Pick<InventoryService, 'recostEntries'>,
  input: {
    orderSeq: number;
    reportIds: readonly string[];
    productId: string;
    amountPen: Decimal;
    actorId: string;
  },
): Promise<unknown> {
  if (input.amountPen.isZero() || input.reportIds.length === 0) return null;
  const entries = await tx.inventoryMovement.findMany({
    where: {
      itemType: 'PRODUCT',
      itemId: input.productId,
      type: 'IN',
      refType: 'PRODUCTION',
      refId: { in: [...input.reportIds] },
      reversalOfId: null,
      reversals: { none: {} },
      recostOfId: null,
    },
    select: { id: true, qty: true, totalCost: true },
  });
  if (entries.length === 0) return null;
  const parts = prorateDelta(
    input.amountPen,
    entries.map((e) => ({
      id: e.id.toString(),
      recorded: toDecimal(e.totalCost.toString()),
      qty: toDecimal(e.qty.toString()),
    })),
  );
  return inventory.recostEntries(
    tx,
    entries.map((e) => ({
      movementId: e.id,
      addPen: parts.get(e.id.toString()) ?? new Decimal(0),
    })),
    { actorId: input.actorId, note: closeRecostNote(input.orderSeq) },
  );
}

/**
 * cc55 (D-665): el ajuste de cierre de una OP. Con saldo del producto, el `ADJUST` de siempre sobre
 * ese saldo (D-057/D-089); sin saldo, el ajuste va a las entradas de los partes y de ahí a los
 * despachos (`recostCloseIntoEntries`). Lo usan los cierres de coberturas y de drywall.
 */
export async function applyCloseAdjustment(
  tx: Prisma.TransactionClient,
  inventory: Pick<InventoryService, 'adjustCost' | 'recostEntries'>,
  input: { adjust: AdjustCostInput; orderSeq: number; reportIds: readonly string[] },
): Promise<{ movement: InventoryMovement | null; recostedEntries: boolean }> {
  const amountPen = toDecimal(input.adjust.amountPen);
  if (amountPen.isZero()) return { movement: null, recostedEntries: false };
  const movement = await inventory.adjustCost(tx, input.adjust);
  if (movement !== null) return { movement, recostedEntries: false };
  const outcome = await recostCloseIntoEntries(tx, inventory, {
    orderSeq: input.orderSeq,
    reportIds: input.reportIds,
    productId: input.adjust.itemId,
    amountPen,
    actorId: input.adjust.actorId,
  });
  return { movement: null, recostedEntries: outcome !== null };
}

/**
 * cc57 (nota de cc55): lo que la auditoría del cierre dice del costo, igual en drywall y en
 * coberturas. `costAdjusted` es `true` también cuando el ajuste fue a las entradas de los partes
 * (D-665) porque el producto ya no tenía saldo; antes el cierre de drywall decía `false`.
 */
export function closeCostAudit(outcome: { movement: unknown; recostedEntries: boolean }): {
  costAdjusted: boolean;
  costRecostedIntoEntries?: true;
} {
  const costAdjusted = outcome.movement !== null || outcome.recostedEntries;
  return outcome.recostedEntries
    ? { costAdjusted, costRecostedIntoEntries: true }
    : { costAdjusted };
}

/**
 * cc55 (D-665): la reapertura no deshace un cierre que pasó el despunte a las ventas. Revertir el
 * despunte de la bobina dejaría ese costo cargado dos veces (otra vez en la bobina y en las salidas
 * del producto). Es el mismo criterio que con el `ADJUST` de cierre: si el producto ya se movió, se
 * anula primero ese movimiento.
 */
export async function assertNoCloseRecost(
  tx: Prisma.TransactionClient,
  orderId: string,
  what: string,
): Promise<void> {
  const order = await tx.productionOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: { seq: true },
  });
  const found = await tx.inventoryMovement.findFirst({
    where: { recostOfId: { not: null }, notes: closeRecostNote(order.seq) },
    select: { id: true },
  });
  if (found) {
    throw new BadRequestException(
      `${what} ya se movieron: el cierre pasó su despunte a los despachos (D-665). Anula esos despachos antes de reabrirla`,
    );
  }
}
