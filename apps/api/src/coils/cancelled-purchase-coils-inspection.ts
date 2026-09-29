import type { InventoryMovement, Prisma } from '@prisma/client';

type CoilMovement = Pick<
  InventoryMovement,
  | 'id'
  | 'itemId'
  | 'type'
  | 'refType'
  | 'refId'
  | 'qty'
  | 'unitCost'
  | 'operationDate'
  | 'reversalOfId'
>;

export interface CancelledPurchaseCoil {
  id: string;
  sku: string;
  purchaseId: string;
  purchaseDocument: string;
  purchaseDate: string;
  kg: string;
  entryDate: string | null;
  entryCostPerKg: string | null;
  verdict: 'RESTAURABLE-SEGURO' | 'EXCLUIDA';
  reasons: string[];
  laterMovements: {
    id: string;
    type: string;
    refType: string;
    operationDate: string;
  }[];
}

export interface CancelledPurchaseCoilsInspection {
  branch: string;
  snapshotUtc: string;
  coils: CancelledPurchaseCoil[];
}

export function assertCancelledPurchaseCoilsInspectionArgs(args: readonly string[]): void {
  if (args.length !== 0)
    throw new Error(`Este subcomando es solo lectura y no acepta argumentos: ${args[0] ?? ''}`);
}

/**
 * Conserva el criterio del clasificador de fechas recibidas: cualquier movimiento ajeno al
 * asiento de compra y a su reversa impide regrabar una entrada, porque podría recostearlo.
 */
export function classifyCancelledPurchaseCoil(
  coil: Omit<CancelledPurchaseCoil, 'verdict' | 'reasons' | 'laterMovements'>,
  movements: readonly CoilMovement[],
): CancelledPurchaseCoil {
  const reasons: string[] = [];
  const original = movements.find(
    (m) => m.type === 'IN' && m.refType === 'PURCHASE' && m.refId === coil.purchaseId,
  );
  if (!original) reasons.push('No se encontró el ingreso PURCHASE original de la compra vinculada');
  const cancellation = original
    ? movements.find((m) => m.reversalOfId === original.id && m.type === 'OUT')
    : undefined;
  if (original && !cancellation) reasons.push('El ingreso PURCHASE no tiene reversa de anulación');

  const ownIds = new Set(
    [original?.id, cancellation?.id].filter((id): id is bigint => id !== undefined),
  );
  const later = movements.filter((m) => !ownIds.has(m.id));
  if (later.length > 0)
    reasons.push(
      `Tiene ${later.length} movimiento(s) ajeno(s) a la anulación; restaurar puede recostearlos`,
    );

  return {
    ...coil,
    entryDate: original?.operationDate.toISOString().slice(0, 10) ?? null,
    entryCostPerKg: original?.unitCost.toString() ?? null,
    verdict: reasons.length === 0 ? 'RESTAURABLE-SEGURO' : 'EXCLUIDA',
    reasons,
    laterMovements: later.map((m) => ({
      id: m.id.toString(),
      type: m.type,
      refType: m.refType,
      operationDate: m.operationDate.toISOString().slice(0, 10),
    })),
  };
}

/** Solo Prisma ORM; el llamador abre una transacción READ ONLY. */
export async function inspectCancelledPurchaseCoils(
  tx: Prisma.TransactionClient,
  branch: string,
): Promise<CancelledPurchaseCoilsInspection> {
  const coils = await tx.coil.findMany({
    where: { status: 'CANCELLED', purchaseId: { not: null } },
    select: {
      id: true,
      code: true,
      purchaseId: true,
      weightKg: true,
      purchase: { select: { series: true, number: true, issueDate: true } },
    },
    orderBy: { code: 'asc' },
  });
  const coilIds = coils.map((coil) => coil.id);
  const movements =
    coilIds.length === 0
      ? []
      : await tx.inventoryMovement.findMany({
          where: { itemType: 'COIL', itemId: { in: coilIds } },
          select: {
            id: true,
            itemId: true,
            type: true,
            refType: true,
            refId: true,
            qty: true,
            unitCost: true,
            operationDate: true,
            reversalOfId: true,
          },
          orderBy: [{ operationDate: 'asc' }, { id: 'asc' }],
        });
  return {
    branch,
    snapshotUtc: new Date().toISOString(),
    coils: coils.map((coil) => {
      if (!coil.purchaseId || !coil.purchase)
        throw new Error(`La bobina anulada ${coil.code} perdió su compra de origen`);
      return classifyCancelledPurchaseCoil(
        {
          id: coil.id,
          sku: coil.code,
          purchaseId: coil.purchaseId,
          purchaseDocument: `${coil.purchase.series}-${coil.purchase.number}`,
          purchaseDate: coil.purchase.issueDate.toISOString().slice(0, 10),
          kg: coil.weightKg.toString(),
          entryDate: null,
          entryCostPerKg: null,
        },
        movements.filter((movement) => movement.itemId === coil.id),
      );
    }),
  };
}
