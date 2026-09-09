import { BadRequestException } from '@nestjs/common';
import { roundTo, toDecimal, type Decimal, type DecimalInput } from '@ayr/shared';

/**
 * Aritmética de la liquidación de remanente al cerrar una bobina (RF-19, **D-164**).
 *
 * Aparte del servicio por el mismo motivo que `coil-split-math.ts`: es la parte que se puede
 * probar sin base de datos, y es la que decide si el kardex termina cuadrando.
 *
 * El problema que resuelve. `inventory_balances` lleva el saldo **teórico** de la bobina:
 * lo que entró menos lo que los reportes de producción, los partidos y las mermas fueron
 * descontando. Cuando planta declara que el rollo se terminó, ese saldo teórico casi nunca
 * es cero — y hasta D-164 se quedaba ahí para siempre, sumando kilos y valor a un inventario
 * valorizado de material que ya no existe. Cerrar la bobina cambiaba un estado y no movía un
 * gramo de kardex.
 *
 * Lo que la liquidación mide, ahora que D-165 metió el 1 % de merma normal dentro de la
 * densidad estándar, es **merma anormal**: lo que se perdió por encima de lo que toda corrida
 * pierde. Por eso sale con `refType` propio (`CLOSE_ADJUSTMENT`) y no como una merma de RF-17.
 */

/** Sentido de la liquidación. El `refType` es el mismo; lo que cambia es de qué lado cae. */
export type CoilCloseAdjustmentKind =
  /** Sobra saldo teórico: el material se perdió y no se registró. Sale del kardex (`OUT`). */
  | 'SHORTAGE'
  /** El conteo físico da de más de lo que el kardex creía. Entra al kardex (`IN`). */
  | 'SURPLUS';

export interface CoilCloseInput {
  /** Saldo teórico vigente de la bobina en `inventory_balances`, en kilos. */
  balanceKg: DecimalInput;
  /**
   * Kilos que planta declara que **quedan de verdad** en el rollo al cerrarlo. Cerrar una
   * bobina agotada es el caso normal y va en cero; declarar el saldo entero es cerrar sin
   * liquidar nada, que sigue siendo legítimo (sacar de producción un rollo que se guarda).
   */
  physicalKg: DecimalInput;
  /** Costo promedio vigente del saldo, en soles por kilo. Valoriza la liquidación. */
  avgCostPen: DecimalInput;
  /**
   * Costo por kilo en soles del documento de la bobina, para el caso `SURPLUS` sobre un
   * saldo en cero: sin kilos en stock el promedio vigente es cero, y valorizar ahí una
   * entrada al promedio metería kilos sin valor al inventario.
   */
  documentUnitCostPen: DecimalInput;
}

export interface CoilCloseAdjustment {
  kind: CoilCloseAdjustmentKind;
  /** Kilos del movimiento, siempre positivos: el sentido lo da `kind` (§3.2). */
  qtyKg: Decimal;
  /** Costo por kilo con el que se valoriza. Solo se usa en `SURPLUS` (una `IN` lo exige). */
  unitCostPen: Decimal;
  /** Valor en soles que la liquidación mueve. Informativo: es lo que la UI muestra. */
  totalCostPen: Decimal;
}

/**
 * El ajuste que el cierre tiene que emitir, o `null` si no hay nada que liquidar.
 *
 * `null` es un resultado normal y frecuente, no un caso de borde: una bobina que se cerró
 * sola al quedar en cero (el partido de RF-15 y la recepción de corte de D-052 lo hacen) no
 * tiene remanente, y una que se cierra declarando su saldo entero tampoco.
 */
export function planCoilCloseAdjustment(input: CoilCloseInput): CoilCloseAdjustment | null {
  const balanceKg = toDecimal(input.balanceKg);
  const physicalKg = toDecimal(input.physicalKg);
  if (!physicalKg.isFinite() || physicalKg.isNegative()) {
    throw new BadRequestException('Los kilos que quedan en la bobina no pueden ser negativos');
  }

  // La diferencia se redondea a la escala de kilos ANTES de decidir si hay algo que liquidar:
  // el saldo y lo declarado ya vienen con tres decimales, pero el residuo de una resta de
  // Decimal puede quedar en la milésima catorce y disparar un movimiento de 0.000 kg que
  // `InventoryService.record` rechaza por "la cantidad debe ser mayor a cero" — un cierre
  // normal cayéndose con un mensaje sobre cantidades que nadie tipeó.
  const difference = roundTo(balanceKg.minus(physicalKg), 'KG');
  if (difference.isZero()) return null;

  const kind: CoilCloseAdjustmentKind = difference.isPositive() ? 'SHORTAGE' : 'SURPLUS';
  const qtyKg = difference.abs();
  // Una salida se valoriza al promedio vigente y el kardex la calcula solo (D-028, D-040);
  // acá el promedio se usa únicamente para **mostrar** cuánto valor se va. La entrada sí
  // necesita el costo explícito, y sobre un saldo vacío el promedio vigente no dice nada.
  const avgCostPen = toDecimal(input.avgCostPen);
  const unitCostPen =
    kind === 'SHORTAGE' || avgCostPen.gt(0) ? avgCostPen : toDecimal(input.documentUnitCostPen);

  return {
    kind,
    qtyKg,
    unitCostPen,
    totalCostPen: roundTo(qtyKg.times(unitCostPen), 'MONEY'),
  };
}
