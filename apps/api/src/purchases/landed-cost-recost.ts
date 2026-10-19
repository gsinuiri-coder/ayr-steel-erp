import { BadRequestException } from '@nestjs/common';
import type { Prisma, Purchase } from '@prisma/client';
import { Decimal, SERVICE_KIND_LABELS, toDecimal } from '@ayr/shared';

/**
 * cc58 (D-686, D-10 de audit-01): el flete, la aduana o el seguro de una compra de bobinas se suma al
 * costo de **la entrada** de cada bobina (`InventoryService.recostEntries`) y el recosteo por fecha lo
 * lleva a lo que ya salió. Estas son las piezas que comparten la recepción y la anulación del
 * servicio.
 */

/** Las entradas vivas de la compra de bobinas: el ingreso de cada bobina, sin reversa. */
export async function landedCostEntries(
  tx: Prisma.TransactionClient,
  relatedPurchaseId: string,
  coils: readonly { id: string }[],
): Promise<{ id: bigint; itemId: string; qty: Decimal }[]> {
  if (coils.length === 0) return [];
  const rows = await tx.inventoryMovement.findMany({
    where: {
      itemType: 'COIL',
      itemId: { in: coils.map((c) => c.id) },
      type: 'IN',
      refType: 'PURCHASE',
      refId: relatedPurchaseId,
      recostOfId: null,
      reversalOfId: null,
      reversals: { none: {} },
    },
    orderBy: { id: 'asc' },
    select: { id: true, itemId: true, qty: true },
  });
  return rows
    .map((r) => ({ id: r.id, itemId: r.itemId, qty: toDecimal(r.qty.toString()) }))
    .filter((r) => r.qty.gt(0));
}

/**
 * La nota de los ajustes del servicio: la misma en la recepción y en la anulación, que la usa para
 * encontrar lo que el servicio le sumó a cada entrada.
 */
export function landedCostNote(
  purchase: Pick<Purchase, 'serviceKind' | 'series' | 'number'>,
): string {
  const label = purchase.serviceKind ? SERVICE_KIND_LABELS[purchase.serviceKind] : 'Servicio';
  return `${label} ${purchase.series}-${purchase.number} (D-686)`;
}

/**
 * Lo que el servicio le sumó a cada entrada: el `ADJUST` de recosteo **de la entrada misma** con la
 * nota del servicio (los de las salidas llevan la misma nota y se deshacen solos al restar en la
 * entrada). Una entrada que después se reemplazó o se anuló ya no se puede restar sin inventar a cuál
 * va: se rechaza con el nombre de la bobina.
 */
export async function landedCostShares(
  tx: Prisma.TransactionClient,
  relatedPurchaseId: string,
  note: string,
): Promise<{ movementId: bigint; itemId: string; qty: Decimal; amountPen: Decimal }[]> {
  const rows = await tx.inventoryMovement.findMany({
    // Solo las entradas de la compra de bobinas: las hijas de un partido y los flejes reciben su
    // parte en cascada con la misma nota, y restarla también ahí la restaría dos veces.
    where: {
      type: 'ADJUST',
      notes: note,
      recostOf: { type: 'IN', refType: 'PURCHASE', refId: relatedPurchaseId },
    },
    select: {
      totalCost: true,
      recostOf: {
        select: {
          id: true,
          itemId: true,
          qty: true,
          reversalOfId: true,
          reversals: { select: { id: true } },
        },
      },
    },
  });
  const byEntry = new Map<
    bigint,
    { movementId: bigint; itemId: string; qty: Decimal; amountPen: Decimal }
  >();
  for (const r of rows) {
    const entry = r.recostOf;
    if (!entry) continue;
    if (entry.reversalOfId !== null || entry.reversals.length > 0) {
      const coil = await tx.coil.findUnique({
        where: { id: entry.itemId },
        select: { code: true },
      });
      throw new BadRequestException(
        `La entrada de la bobina ${coil?.code ?? entry.itemId} se reemplazó o se anuló después de este costo: no se puede restar sin saber a qué entrada va`,
      );
    }
    const prev = byEntry.get(entry.id);
    const amount = toDecimal(r.totalCost.toString());
    byEntry.set(entry.id, {
      movementId: entry.id,
      itemId: entry.itemId,
      qty: toDecimal(entry.qty.toString()),
      amountPen: (prev?.amountPen ?? new Decimal(0)).plus(amount),
    });
  }
  return [...byEntry.values()].filter((s) => !s.amountPen.isZero());
}
