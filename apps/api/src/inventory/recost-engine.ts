import { Decimal } from '@ayr/shared';

/**
 * cc53 (D-649) — **recosteo del promedio por fecha.** Funciones puras: `InventoryService` lee las
 * filas del kardex, decide con estas y escribe los `ADJUST` de recosteo por su puerta.
 *
 * El kardex valoriza una salida al promedio del saldo; si se graba con una fecha anterior a
 * movimientos que el ítem ya tiene, ese promedio no es el de su fecha (cc52, UPVC6MT). La regla
 * nueva: cada salida toma el promedio **vigente a su fecha** (`operationDate`, y a igual fecha el
 * orden de registro), y lo que cambia hacia adelante se corrige con un movimiento de ajuste que
 * apunta a la fila corregida. Ninguna fila se edita.
 *
 * Costos «de fila»: positivos para una entrada o una salida (el valor que mueve), con signo en un
 * `ADJUST` (lo que suma al saldo). El **costo efectivo** de una fila es su `totalCost` más sus
 * recosteos ya registrados.
 */

/** Por debajo de un céntimo, la diferencia es ruido de redondeo del promedio guardado: no se ajusta. */
export const RECOST_MIN_DELTA = new Decimal('0.01');

/** Tope de filas reproducidas por operación (D-649, decisión del dueño): encima, queda pendiente. */
export const RECOST_MAX_ROWS = 500;

const ZERO = new Decimal(0);

/** Cómo se valoriza una fila al reproducir el saldo. */
export type RecostRule =
  /** Su valor no depende del promedio: compra, carga inicial, ajuste de compra o de flete. */
  | 'FIXED'
  /** Salida (o entrada al promedio, como el sobrante): cantidad × promedio vigente a su posición. */
  | 'AVERAGE'
  /** Anulación: el costo corregido del original, en la proporción con que lo anuló. */
  | 'REVERSAL'
  /** Devolución de NC (D-646): el costo corregido de la salida del despacho, en proporción. */
  | 'RETURN';

export interface RecostRow {
  id: string;
  type: 'IN' | 'OUT' | 'ADJUST';
  qty: Decimal;
  /** `totalCost` tal como quedó grabado. */
  recorded: Decimal;
  /** `recorded` más sus recosteos (en costo de fila). */
  effective: Decimal;
  rule: RecostRule;
  /** `REVERSAL`: el movimiento anulado. `RETURN`: la salida del despacho que se devuelve. */
  sourceId?: string | null;
}

/** Una fila de otro ítem que esta reproducción necesita (una devolución cruzada). */
export interface ExternalCost {
  type: 'IN' | 'OUT' | 'ADJUST';
  qty: Decimal;
  /** Su costo efectivo hoy (grabado más recosteos). */
  effective: Decimal;
  /** Su costo corregido (igual al efectivo si no se recalcula en esta corrida). */
  corrected: Decimal;
}

export interface RecostDelta {
  id: string;
  /** Lo que la fila tiene que pasar a valer (costo de fila). */
  target: Decimal;
  /** Diferencia contra su costo efectivo (costo de fila). */
  delta: Decimal;
}

export interface ReplayResult {
  /** Costo corregido de cada fila reproducida (desde `start`). */
  corrected: Map<string, Decimal>;
  /** Filas cuya diferencia llega a un céntimo. */
  deltas: RecostDelta[];
  qty: Decimal;
  value: Decimal;
}

export interface ReplayOptions {
  /** Índice de la primera fila que se recalcula; las anteriores valen su costo efectivo. */
  start: number;
  /** Costo impuesto desde otro ítem (entrada derivada de una producción, un partido o un corte). */
  overrides?: ReadonlyMap<string, Decimal>;
  /** Fuentes de otro ítem de una `REVERSAL` o una `RETURN`. */
  external?: ReadonlyMap<string, ExternalCost>;
}

function round4(d: Decimal): Decimal {
  return d.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

/**
 * El costo corregido de una fila que sigue a otra (`REVERSAL`, `RETURN`), o `null` si queda como
 * estaba. La anulación de una entrada o una salida es por la misma cantidad: toma el corregido del
 * original. La de un ajuste anuló una parte: esa misma proporción del corregido. Una devolución,
 * la parte de la salida que devuelve, por cantidad (su costo de origen pudo grabarse ya recosteado).
 */
function followCost(row: RecostRow, source: ExternalCost | undefined): Decimal | null {
  if (!source) return null;
  if (row.rule === 'RETURN') {
    if (source.qty.isZero()) return null;
    if (row.qty.eq(source.qty)) return source.corrected;
    return round4(source.corrected.times(row.qty).div(source.qty));
  }
  if (source.type !== 'ADJUST') return source.corrected;
  if (source.effective.isZero() || source.corrected.eq(source.effective)) return null;
  return round4(row.recorded.times(source.corrected).div(source.effective));
}

/**
 * Reproduce el saldo de un ítem en orden de fecha y registro, y devuelve el costo correcto de cada
 * fila desde `start`. Las filas anteriores entran con su costo efectivo (lo ya corregido no se
 * vuelve a tocar). El saldo se lleva por valor exacto, como la vista Promedio: una salida que se
 * lleva todo lo que queda se lleva todo el valor.
 */
export function replayItem(rows: readonly RecostRow[], options: ReplayOptions): ReplayResult {
  const corrected = new Map<string, Decimal>();
  const deltas: RecostDelta[] = [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  let qty = ZERO;
  let value = ZERO;

  const sourceCost = (id: string | null | undefined): ExternalCost | undefined => {
    if (!id) return undefined;
    const local = byId.get(id);
    if (local) {
      return {
        type: local.type,
        qty: local.qty,
        effective: local.effective,
        corrected: corrected.get(id) ?? local.effective,
      };
    }
    return options.external?.get(id);
  };

  rows.forEach((row, index) => {
    let cost = row.effective;
    if (index >= options.start) {
      const override = options.overrides?.get(row.id);
      if (override !== undefined) {
        cost = override;
      } else if (row.rule === 'AVERAGE') {
        // Sin saldo a esa fecha no hay promedio con qué valorizar: queda como se grabó.
        if (qty.gt(0)) {
          cost =
            row.type === 'OUT'
              ? averageOutCost({ qty, value }, row.qty)
              : round4(row.qty.times(value).div(qty));
        }
      } else if (row.rule === 'REVERSAL' || row.rule === 'RETURN') {
        cost = followCost(row, sourceCost(row.sourceId)) ?? row.effective;
      }
      corrected.set(row.id, cost);
      const delta = cost.minus(row.effective);
      if (delta.abs().gte(RECOST_MIN_DELTA)) deltas.push({ id: row.id, target: cost, delta });
    }
    if (row.type === 'IN') {
      value = qty.lte(0) ? cost : value.plus(cost);
      qty = qty.plus(row.qty);
    } else if (row.type === 'OUT') {
      qty = qty.minus(row.qty);
      value = qty.lte(0) ? ZERO : value.minus(cost);
    } else {
      value = value.plus(cost);
    }
  });
  return { corrected, deltas, qty, value };
}

/**
 * El saldo hasta la posición `end` (exclusiva), con los costos efectivos: lo que una salida nueva,
 * fechada ahí, toma como promedio.
 */
export function stockBefore(
  rows: readonly RecostRow[],
  end: number,
): { qty: Decimal; value: Decimal } {
  let qty = ZERO;
  let value = ZERO;
  for (const row of rows.slice(0, end)) {
    if (row.type === 'IN') {
      value = qty.lte(0) ? row.effective : value.plus(row.effective);
      qty = qty.plus(row.qty);
    } else if (row.type === 'OUT') {
      qty = qty.minus(row.qty);
      value = qty.lte(0) ? ZERO : value.minus(row.effective);
    } else {
      value = value.plus(row.effective);
    }
  }
  return { qty, value };
}

/** Costo de una salida de `outQty` sobre un saldo: todo el valor si se lleva todo. */
export function averageOutCost(stock: { qty: Decimal; value: Decimal }, outQty: Decimal): Decimal {
  if (stock.qty.lte(0)) return ZERO;
  if (outQty.gte(stock.qty)) return round4(Decimal.max(stock.value, ZERO));
  return round4(outQty.times(stock.value).div(stock.qty));
}

/**
 * El total de un `ADJUST` de recosteo (lo que suma al **saldo**) a partir de la diferencia en costo
 * de fila: una salida que cuesta X más saca X más del saldo (−X); una entrada o un ajuste que vale X
 * más lo suma (+X).
 */
export function recostAdjustTotal(type: 'IN' | 'OUT' | 'ADJUST', delta: Decimal): Decimal {
  return type === 'OUT' ? delta.negated() : delta;
}

/** La inversa: cuánto mueve un recosteo grabado el costo de la fila que corrige. */
export function rowCostOfRecost(
  targetType: 'IN' | 'OUT' | 'ADJUST',
  adjustTotal: Decimal,
): Decimal {
  return targetType === 'OUT' ? adjustTotal.negated() : adjustTotal;
}

/**
 * Reparte la diferencia de una salida entre las entradas que derivan de ella (D-597/D-608, reporte
 * de producción), en proporción a lo que cada una valía; si todas valían cero, por cantidad. Cada
 * parte a 4 decimales y el resto a la de mayor peso (la primera si empatan), así la suma es exacta.
 */
export function prorateDelta(
  delta: Decimal,
  targets: readonly { id: string; recorded: Decimal; qty: Decimal }[],
): Map<string, Decimal> {
  const out = new Map<string, Decimal>();
  if (targets.length === 0) return out;
  const byValue = targets.some((t) => !t.recorded.isZero());
  const weight = (t: { recorded: Decimal; qty: Decimal }) => (byValue ? t.recorded.abs() : t.qty);
  const total = targets.reduce((s, t) => s.plus(weight(t)), ZERO);
  let heaviest = targets[0];
  if (heaviest === undefined) return out;
  for (const t of targets) if (weight(t).gt(weight(heaviest))) heaviest = t;
  let assigned = ZERO;
  for (const t of targets) {
    if (t === heaviest) continue;
    const part = total.isZero()
      ? ZERO
      : delta.times(weight(t)).div(total).toDecimalPlaces(4, Decimal.ROUND_DOWN);
    out.set(t.id, part);
    assigned = assigned.plus(part);
  }
  out.set(heaviest.id, delta.minus(assigned));
  return out;
}
