import { BadRequestException } from '@nestjs/common';
import { Decimal, roundTo, toDecimal, type DecimalInput } from '@ayr/shared';

/**
 * Aritmética de la orden de producción (Fase 4), aparte del servicio para poder probarla
 * sola — igual que `coil-split-math.ts` y `purchase-math.ts`. Nada de esto toca la base
 * ni el kardex.
 */

export interface StripAllocationRow {
  consumptionId: string;
  coilId: string;
  coilCode: string;
  /** `assignedKg − consumedKg` de esa fila. */
  remainingKg: Decimal;
}

export interface StripAllocation {
  consumptionId: string;
  coilId: string;
  coilCode: string;
  kg: Decimal;
}

/**
 * Reparte los kilos teóricos de un reporte entre los flejes asignados, en el orden en que
 * se asignaron (el primero que se montó es el primero que se gasta). El último tramo se
 * calcula por **diferencia** contra lo ya repartido, así la suma de las asignaciones da
 * exactamente `neededKg` y no queda un residuo de milésimas — mismo criterio que el
 * reparto por acumulado de `planCoilSplit` (RF-15).
 *
 * Falla si los flejes asignados no alcanzan: reportar piezas que la OP no puede respaldar
 * en material sacaría kilos del saldo del fleje que nadie puso a disposición de esta OP.
 */
export function allocateStripKg(
  rows: StripAllocationRow[],
  neededKg: DecimalInput,
): StripAllocation[] {
  const needed = roundTo(neededKg, 'KG');
  if (needed.lte(0)) {
    throw new BadRequestException('Las piezas reportadas no consumen material');
  }

  const available = rows.reduce((acc, r) => acc.plus(r.remainingKg), new Decimal(0));
  if (needed.gt(available)) {
    throw new BadRequestException(
      `Las piezas reportadas necesitan ${needed.toFixed(3)} kg de fleje y la orden solo tiene ${available.toFixed(3)} kg asignados: consume otro fleje antes de reportar`,
    );
  }

  const allocations: StripAllocation[] = [];
  let pending = needed;
  for (const row of rows) {
    if (pending.lte(0)) break;
    if (row.remainingKg.lte(0)) continue;
    const kg = Decimal.min(row.remainingKg, pending);
    allocations.push({
      consumptionId: row.consumptionId,
      coilId: row.coilId,
      coilCode: row.coilCode,
      kg,
    });
    pending = pending.minus(kg);
  }
  if (pending.gt(0)) {
    // Inalcanzable con la comprobación de arriba; queda como red de seguridad para que
    // un error de redondeo nunca termine en un reporte que consume de menos en silencio.
    throw new BadRequestException('El reparto de kilos entre los flejes de la orden no cierra');
  }
  return allocations;
}

export interface ProductionCostInput {
  /** Valor en soles que los reportes vigentes sacaron de los flejes. */
  reportsCostPen: DecimalInput;
  /** Valor en soles de la merma de proceso que sale al cerrar (D-057). */
  scrapCostPen: DecimalInput;
  /** Piezas buenas de los reportes vigentes. */
  pieces: number;
}

export interface ProductionCost {
  materialCostPen: Decimal;
  /** Hook de D-035: en v1 siempre cero (sin mano de obra ni overhead estándar, D-056). */
  overheadCostPen: Decimal;
  totalCostPen: Decimal;
  unitCostPen: Decimal;
}

/**
 * Costo de la corrida (D-056): todo el material que salió de los flejes —el que quedó en
 * piezas **y** el que se fue en merma de proceso— repartido entre las piezas buenas. La
 * merma no destruye valor, lo absorben las piezas: eso es lo que de verdad costó cada
 * pieza, y es lo que alimenta el precio sugerido (D-032).
 *
 * `overheadCostPen` existe para que Fase 5 solo tenga que llenarlo (D-035,
 * `pricing_settings.overheadPerKg`); hoy es cero por decisión explícita.
 */
/**
 * Ajuste que el cierre emite sobre el producto terminado: la diferencia entre lo que la
 * corrida costó de verdad y el valor con el que las piezas fueron entrando reporte a
 * reporte. Se lleva dos cosas de una vez — el costo de la merma de proceso (D-057) y el
 * residuo de redondeo del costo unitario de cada reporte, que se guarda con 4 decimales—,
 * y por eso el kardex cierra exacto en vez de arrastrar céntimos huérfanos.
 *
 * Puede ser negativo (si el redondeo de los reportes fue hacia arriba y no hubo merma).
 */
export function closeAdjustmentPen(
  totalCostPen: DecimalInput,
  reports: { pieces: number; unitCostPen: DecimalInput }[],
): Decimal {
  const enteredValuePen = reports.reduce(
    (acc, r) => acc.plus(toDecimal(r.unitCostPen).times(r.pieces)),
    new Decimal(0),
  );
  return roundTo(toDecimal(totalCostPen).minus(enteredValuePen), 'MONEY');
}

export function productionCost(input: ProductionCostInput): ProductionCost {
  if (input.pieces <= 0) {
    throw new BadRequestException('Una orden sin piezas buenas no se puede costear');
  }
  const materialCostPen = roundTo(
    toDecimal(input.reportsCostPen).plus(toDecimal(input.scrapCostPen)),
    'MONEY',
  );
  const overheadCostPen = new Decimal(0);
  const totalCostPen = roundTo(materialCostPen.plus(overheadCostPen), 'MONEY');
  return {
    materialCostPen,
    overheadCostPen,
    totalCostPen,
    unitCostPen: roundTo(totalCostPen.div(input.pieces), 'MONEY'),
  };
}
