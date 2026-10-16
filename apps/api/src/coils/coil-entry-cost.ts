import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  costChangeNote,
  Decimal,
  toDecimal,
  toFixedString,
  type CostChangeReason,
} from '@ayr/shared';
import type { AuditService } from '../audit/audit.service';
import type { InventoryService, RecostOutcome } from '../inventory/inventory.service';
import { rowCostOfRecost } from '../inventory/recost-engine';
import { lockCoilRows } from '../inventory/row-locks';

/**
 * cc56 (D-669, C2 de cc55) — **corregir el costo de la entrada de una bobina que ya se movió.**
 *
 * La edición de RF-20 (D-045) recostea por reversa + reingreso y solo admite una bobina sin
 * movimientos posteriores a su ingreso. Una bobina vendida entera ya no entra ahí. Esta corrección
 * fija el costo efectivo de su entrada viva en `peso × costo/kg × TC` por la puerta del recosteo por
 * fecha (`InventoryService.recostEntries`, D-649/D-665): escribe el `ADJUST` de la entrada, con su
 * fecha, y los de las salidas que se llevaron ese saldo. La fila original no se edita (regla 8).
 * La ficha de la bobina (`unit_cost_per_kg` y totales) queda con el costo corregido.
 *
 * Exige un motivo de la lista (D-669): nunca es un camino para bajar el costo y vender más barato.
 */
export interface CoilEntryCostInput {
  coilId: string;
  unitCostPerKg: Decimal;
  costReason: CostChangeReason;
  detail: string;
}

export interface CoilEntryCostResult {
  coilId: string;
  entryMovementId: string;
  fromPen: string;
  toPen: string;
  addPen: string;
  outcome: RecostOutcome | null;
}

export async function correctCoilEntryCost(
  tx: Prisma.TransactionClient,
  deps: { inventory: Pick<InventoryService, 'recostEntries'>; audit: Pick<AuditService, 'write'> },
  actorId: string,
  input: CoilEntryCostInput,
): Promise<CoilEntryCostResult> {
  if (input.unitCostPerKg.lte(0))
    throw new BadRequestException('El costo por kg tiene que ser mayor que cero');
  await lockCoilRows(tx, [input.coilId]);
  const coil = await tx.coil.findUnique({ where: { id: input.coilId } });
  if (!coil) throw new BadRequestException('Bobina no encontrada');
  if (coil.status === 'CANCELLED') throw new BadRequestException('La bobina está anulada');

  // La entrada viva: un `IN` de la bobina sin reversa y que no sea él mismo una reversa.
  const entries = await tx.inventoryMovement.findMany({
    where: {
      itemType: 'COIL',
      itemId: coil.id,
      type: 'IN',
      reversalOfId: null,
      reversals: { none: {} },
    },
    select: { id: true, qty: true, totalCost: true, operationDate: true },
  });
  if (entries.length !== 1) {
    throw new BadRequestException(
      `La bobina ${coil.code} tiene ${String(entries.length)} entradas vivas: se corrige una sola`,
    );
  }
  const [entry] = entries as [(typeof entries)[number]];
  const recosts = await tx.inventoryMovement.aggregate({
    where: { recostOfId: entry.id },
    _sum: { totalCost: true },
  });
  const effective = toDecimal(entry.totalCost.toString()).plus(
    rowCostOfRecost('IN', toDecimal(recosts._sum.totalCost?.toString() ?? '0')),
  );
  const qty = toDecimal(entry.qty.toString());
  const rate = toDecimal(coil.exchangeRate.toString());
  const target = toDecimal(toFixedString(qty.times(input.unitCostPerKg).times(rate), 'MONEY'));
  const add = target.minus(effective);
  const note = costChangeNote(input.costReason, input.detail);

  const outcome = add.isZero()
    ? null
    : await deps.inventory.recostEntries(tx, [{ movementId: entry.id, addPen: add }], {
        actorId,
        note,
      });
  if (outcome?.pending) {
    throw new BadRequestException(
      'El recosteo pasa el tope en línea (D-649): no se corrige; usa recosteo:historico',
    );
  }

  const totalCost = toFixedString(
    toDecimal(coil.weightKg.toString()).times(input.unitCostPerKg),
    'MONEY',
  );
  await tx.coil.update({
    where: { id: coil.id },
    data: {
      unitCostPerKg: toFixedString(input.unitCostPerKg, 'MONEY'),
      totalCost,
      totalCostPen: toFixedString(target, 'MONEY'),
    },
  });
  await deps.audit.write(tx, {
    actorId,
    action: 'coils.entry-cost-correction',
    entity: 'coils',
    entityId: coil.id,
    reason: note,
    before: {
      unitCostPerKg: coil.unitCostPerKg.toFixed(4),
      totalCostPen: coil.totalCostPen.toFixed(4),
      entryEffectivePen: effective.toFixed(4),
    },
    after: {
      unitCostPerKg: toFixedString(input.unitCostPerKg, 'MONEY'),
      totalCostPen: toFixedString(target, 'MONEY'),
      entryMovementId: entry.id.toString(),
      addPen: add.toFixed(4),
      costReason: input.costReason,
      adjustedMovementIds: (outcome?.adjusted ?? []).map((a) => a.movement.id.toString()),
    },
  });
  return {
    coilId: coil.id,
    entryMovementId: entry.id.toString(),
    fromPen: effective.toFixed(4),
    toPen: target.toFixed(4),
    addPen: add.toFixed(4),
    outcome,
  };
}

/** Lo neto del recosteo por cada movimiento ajustado, para la vista previa (`id → delta`). */
export function adjustedDeltas(
  outcome: RecostOutcome | null,
): {
  movementId: string;
  type: string;
  refType: string | null;
  refId: string | null;
  delta: string;
}[] {
  return (outcome?.adjusted ?? []).map((a) => ({
    movementId: a.movement.id.toString(),
    type: a.movement.type,
    refType: a.movement.refType,
    refId: a.movement.refId,
    delta: a.delta.toFixed(4),
  }));
}

export { Decimal };
