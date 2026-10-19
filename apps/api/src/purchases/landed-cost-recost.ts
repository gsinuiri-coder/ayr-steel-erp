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
 * La nota de los ajustes del servicio. La anulación encuentra lo que el servicio sumó por la marca
 * `compra <id>` (`landedCostKey`), no por la nota entera: la serie y el número se pueden corregir
 * en una compra recibida (autorrevisión de cc58-c, P1-2).
 */
export function landedCostNote(
  purchase: Pick<Purchase, 'id' | 'serviceKind' | 'series' | 'number'>,
): string {
  const label = purchase.serviceKind ? SERVICE_KIND_LABELS[purchase.serviceKind] : 'Servicio';
  // El id de la compra hace la nota única: dos proveedores pueden tener el mismo F001-1 sobre la
  // misma compra de bobinas (revisión de cc58-c, P1-1).
  return `${label} ${purchase.series}-${purchase.number} (${LANDED_COST_MARK}, compra ${purchase.id})`;
}

/** La marca de las notas del flete por recosteo: la buscan las correcciones que no lo contemplan. */
export const LANDED_COST_MARK = 'D-686';

/** La parte de la nota que identifica al servicio, también en las filas de su anulación. */
export function landedCostKey(servicePurchaseId: string): string {
  return `(${LANDED_COST_MARK}, compra ${servicePurchaseId})`;
}

/**
 * Si la entrada recibió un costo de servicio por recosteo (D-686). «Editar compra recibida» y la
 * corrección del costo de la bobina no lo contemplan y lo avisan.
 */
export async function hasLandedRecost(
  tx: Prisma.TransactionClient,
  entryId: bigint,
): Promise<boolean> {
  // El neto: un servicio ya anulado suma su alta y su anulación, y no bloquea (P2-5).
  const sum = await tx.inventoryMovement.aggregate({
    where: { recostOfId: entryId, notes: { contains: `(${LANDED_COST_MARK}, compra ` } },
    _sum: { totalCost: true },
  });
  return !toDecimal(sum._sum.totalCost?.toString() ?? '0').isZero();
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
  servicePurchaseId: string,
): Promise<{ movementId: bigint; itemId: string; qty: Decimal; amountPen: Decimal }[]> {
  const rows = await tx.inventoryMovement.findMany({
    // Solo las entradas de la compra de bobinas: las hijas de un partido y los flejes reciben su
    // parte en cascada con la misma nota, y restarla también ahí la restaría dos veces.
    where: {
      type: 'ADJUST',
      // Alta y anulación del mismo servicio: el neto es lo que sigue sumado.
      notes: { contains: landedCostKey(servicePurchaseId) },
      recostOf: { type: 'IN', refType: 'PURCHASE', refId: relatedPurchaseId },
    },
    select: {
      totalCost: true,
      recostOf: {
        select: {
          id: true,
          itemId: true,
          qty: true,
          totalCost: true,
          reversalOfId: true,
          reversals: { select: { id: true, totalCost: true } },
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
      // Anular la bobina (o la compra) revierte la entrada a su costo **efectivo**: el flete ya
      // salió con esa reversa y no hay nada que restar (revisión de cc58-c, P1-2). Un reemplazo
      // («Editar compra recibida») la revierte a su costo grabado y el flete queda en el saldo sin
      // entrada viva a la que restárselo: eso sí se rechaza, con la bobina.
      if (await leftWithReversal(tx, entry.id, entry.totalCost, entry.reversals)) continue;
      const coil = await tx.coil.findUnique({
        where: { id: entry.itemId },
        select: { code: true },
      });
      throw new BadRequestException(
        `La entrada de la bobina ${coil?.code ?? entry.itemId} se reemplazó después de este costo: no se puede restar sin saber a qué entrada va`,
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

/**
 * La reversa de la entrada se llevó su costo efectivo (el grabado más **todos** sus recosteos): lo
 * que el servicio le sumó salió con ella.
 */
async function leftWithReversal(
  tx: Prisma.TransactionClient,
  entryId: bigint,
  recorded: { toString(): string },
  reversals: readonly { totalCost: { toString(): string } }[],
): Promise<boolean> {
  const [reversal] = reversals;
  if (!reversal) return false;
  const recosts = await tx.inventoryMovement.aggregate({
    where: { recostOfId: entryId },
    _sum: { totalCost: true },
  });
  const effective = toDecimal(recorded.toString()).plus(
    toDecimal(recosts._sum.totalCost?.toString() ?? '0'),
  );
  return toDecimal(reversal.totalCost.toString()).minus(effective).abs().lt('0.0001');
}
