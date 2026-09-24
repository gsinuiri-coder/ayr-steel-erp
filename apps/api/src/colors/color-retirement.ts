import { BadRequestException } from '@nestjs/common';
import { InventoryItemType, type Prisma } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';

/**
 * D-274: retirar un color del maestro que nadie usa, junto con sus specs de materia prima
 * sobrantes.
 *
 * Nace de un caso concreto: el dry-run del color comercial encontró en production un color
 * `NATURAL` que ningún acabado, producto ni bobina lleva, y dos `raw_material_specs` con ese
 * color que ninguna línea ni reserva nombra. El nombre choca con el tipo de acabado NATURAL
 * (D-273), y las specs son residuo: una spec se crea al vuelo al cotizar (D-134) y se vuelve a
 * crear sola si alguna vez hace falta.
 *
 * **Con una sola referencia no se toca nada.** Se cuentan todas las que pueden explicar el
 * color —productos, bobinas, acabados y líneas de compra, activos o no— y todas las que pueden
 * nombrar a sus specs: líneas de cotización y de pedido de cualquier estado, y reservas firmes
 * y temporales de cualquier estado. Una spec que la historia nombra no es sobrante aunque la
 * promesa ya esté cerrada: borrarla dejaría a esa línea apuntando a nada.
 *
 * El color se **desactiva**, no se borra (baja lógica, igual que `ColorsService.update`). Las
 * specs sí se borran: no tienen estado propio ni baja lógica, y cada una queda entera en el
 * `before` de su auditoría.
 */

export interface ColorRetirementPlan {
  color: { id: string; code: string; name: string; isActive: boolean } | null;
  specs: { id: string; businessLineId: string; thicknessMm: string }[];
  references: {
    products: number;
    coils: number;
    finishes: number;
    purchaseItems: number;
    quotationLines: number;
    salesOrderLines: number;
    reservations: number;
    temporaryReservations: number;
  };
  /** Por qué no se puede. Vacía = se puede ejecutar. */
  stops: string[];
}

const REFERENCE_LABELS: Record<keyof ColorRetirementPlan['references'], string> = {
  products: 'producto(s)',
  coils: 'bobina(s)',
  finishes: 'acabado(s)',
  purchaseItems: 'línea(s) de compra',
  quotationLines: 'línea(s) de cotización sobre sus specs',
  salesOrderLines: 'línea(s) de pedido sobre sus specs',
  reservations: 'reserva(s) firme(s) sobre sus specs',
  temporaryReservations: 'reserva(s) temporal(es) sobre sus specs',
};

export async function planColorRetirement(
  tx: Prisma.TransactionClient,
  code: string,
): Promise<ColorRetirementPlan> {
  const empty = {
    products: 0,
    coils: 0,
    finishes: 0,
    purchaseItems: 0,
    quotationLines: 0,
    salesOrderLines: 0,
    reservations: 0,
    temporaryReservations: 0,
  };
  const color = await tx.color.findUnique({
    where: { code },
    select: { id: true, code: true, name: true, isActive: true },
  });
  if (color === null) {
    return { color: null, specs: [], references: empty, stops: [`No existe el color ${code}`] };
  }

  const specRows = await tx.rawMaterialSpec.findMany({
    where: { colorId: color.id },
    select: { id: true, businessLineId: true, thicknessMm: true },
    orderBy: { thicknessMm: 'asc' },
  });
  const specIds = specRows.map((s) => s.id);
  const onSpecs = { itemType: InventoryItemType.RAW_MATERIAL, itemId: { in: specIds } };
  const onSpecLines = {
    reserveItemType: InventoryItemType.RAW_MATERIAL,
    reserveItemId: { in: specIds },
  };

  const [
    products,
    coils,
    finishes,
    purchaseItems,
    quotationLines,
    salesOrderLines,
    reservations,
    temporaryReservations,
  ] = await Promise.all([
    tx.product.count({ where: { colorId: color.id } }),
    tx.coil.count({ where: { colorId: color.id } }),
    tx.finish.count({ where: { colorId: color.id } }),
    tx.purchaseItem.count({ where: { colorId: color.id } }),
    tx.quotationItem.count({ where: onSpecLines }),
    tx.salesOrderItem.count({ where: onSpecLines }),
    tx.reservation.count({ where: onSpecs }),
    tx.quotationReservation.count({ where: onSpecs }),
  ]);
  const references = {
    products,
    coils,
    finishes,
    purchaseItems,
    quotationLines,
    salesOrderLines,
    reservations,
    temporaryReservations,
  };

  const stops = (Object.keys(references) as (keyof typeof references)[])
    .filter((k) => references[k] > 0)
    .map(
      (k) =>
        `El color ${color.code} tiene ${String(references[k])} ${REFERENCE_LABELS[k]}: no es un color sin uso`,
    );

  return {
    color,
    specs: specRows.map((s) => ({
      id: s.id,
      businessLineId: s.businessLineId,
      thicknessMm: s.thicknessMm.toFixed(2),
    })),
    references,
    stops,
  };
}

/**
 * Ejecuta el retiro dentro de la transacción del llamador. Bloquea la fila del color y
 * **vuelve a planear**: lo que el dry-run vio puede haber cambiado, y la decisión se toma sobre
 * lo que hay ahora.
 */
export async function executeColorRetirement(
  tx: Prisma.TransactionClient,
  audit: Pick<AuditService, 'write'>,
  actorId: string,
  code: string,
): Promise<ColorRetirementPlan> {
  await tx.$queryRaw`SELECT "id" FROM "colors" WHERE "code" = ${code} FOR UPDATE`;
  const plan = await planColorRetirement(tx, code);
  if (plan.stops.length > 0) throw new BadRequestException(plan.stops.join('; '));
  const color = plan.color;
  if (color === null) throw new BadRequestException(`No existe el color ${code}`);
  if (!color.isActive && plan.specs.length === 0) {
    throw new BadRequestException(`El color ${code} ya está inactivo y sin specs: nada que hacer`);
  }

  if (plan.specs.length > 0) {
    await tx.rawMaterialSpec.deleteMany({
      where: { id: { in: plan.specs.map((s) => s.id) }, colorId: color.id },
    });
  }
  for (const spec of plan.specs) {
    await audit.write(tx, {
      actorId,
      action: 'raw_material_specs.delete',
      entity: 'raw_material_specs',
      entityId: spec.id,
      before: { ...spec, colorId: color.id, colorCode: color.code },
      reason: `D-274: spec sobrante del color ${color.code}, sin líneas ni reservas`,
    });
  }
  await tx.color.update({ where: { id: color.id }, data: { isActive: false } });
  await audit.write(tx, {
    actorId,
    action: 'colors.retire',
    entity: 'colors',
    entityId: color.id,
    before: { code: color.code, name: color.name, isActive: color.isActive },
    after: { code: color.code, name: color.name, isActive: false },
    reason: 'D-274: color sin uso cuyo nombre choca con un tipo de acabado (D-273)',
  });
  return plan;
}
