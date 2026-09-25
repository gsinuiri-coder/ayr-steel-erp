import { Decimal, toDecimal, toFixedString } from '@ayr/shared';

/**
 * D-279 — Valorización PEPS (primeras entradas, primeras salidas) de un ítem, **solo para el
 * reporte** del registro de inventario permanente valorizado (SUNAT, formato 13.1).
 *
 * El sistema valoriza en costo promedio ponderado (D-028) y eso no cambia: el kardex, los
 * saldos, el costo de venta y todo otro reporte siguen leyendo `inventory_movements` y
 * `inventory_balances` tal cual. Acá se re-lee la misma lista de movimientos y se recalcula
 * el costo de cada salida con capas: cada entrada abre una capa a su costo; cada salida
 * consume las capas más antiguas primero.
 *
 * Reglas para lo que no es una entrada o salida simple:
 * - **Anulación de una salida** (`IN` con `reversalOfId`): vuelven las mismas porciones de
 *   capa que esa salida consumió, a su costo PEPS y al frente de la cola (eran las más
 *   antiguas). No se usa el costo promedio que registró el kardex.
 * - **Anulación de una entrada** (`OUT` con `reversalOfId`): sale primero de la capa que
 *   abrió esa entrada; lo que ya no esté ahí (se consumió), de las más antiguas.
 * - **Ajuste de costo** (`ADJUST`, D-043): mueve valor sin mover cantidad; el monto se reparte
 *   sobre las capas vivas en proporción a sus kilos. Sin capas vivas, no hay a quién cargarlo:
 *   se marca.
 * - **Salida sin capas suficientes**: el kardex no lo permite en operación normal
 *   (`assertChronological`), pero una retrofecha o un dato viejo puede dejarlo. No se inventa
 *   costo: la parte cubierta sale a costo PEPS, la parte sin capa al **costo unitario que el
 *   kardex registró** para esa salida, y la fila lleva una advertencia con los kilos sin capa.
 *   El faltante queda como saldo negativo en cantidad y la próxima entrada lo cubre primero
 *   (esa porción no abre capa).
 */

export interface PepsMovement {
  id: string;
  type: 'IN' | 'OUT' | 'ADJUST';
  /** Siempre positiva (el sentido lo da `type`). En `ADJUST`, los kilos del saldo. */
  qty: string;
  /** Valor del movimiento según el kardex. En `ADJUST` puede ser negativo (su anulación). */
  totalCost: string;
  /** `YYYY-MM-DD`, día de negocio (D-124). */
  operationDate: string;
  reversalOfId: string | null;
}

export interface PepsLayer {
  qty: string;
  unitCost: string;
  total: string;
}

export interface PepsRow {
  movementId: string;
  operationDate: string;
  inQty: string | null;
  inUnitCost: string | null;
  inTotal: string | null;
  outQty: string | null;
  outUnitCost: string | null;
  outTotal: string | null;
  balanceQty: string;
  balanceUnitCost: string;
  balanceTotal: string;
  warning: string | null;
}

export interface PepsBalance {
  qty: string;
  /** Valor ÷ cantidad; cero sin saldo. */
  unitCost: string;
  total: string;
  layers: PepsLayer[];
}

export interface PepsResult {
  opening: PepsBalance;
  rows: PepsRow[];
  closing: PepsBalance;
  totals: { inQty: string; inTotal: string; outQty: string; outTotal: string };
  warnings: string[];
}

interface Layer {
  qty: Decimal;
  unitCost: Decimal;
  /** Movimiento que abrió la capa: la anulación de esa entrada sale de acá primero. */
  sourceId: string;
}

interface Piece {
  qty: Decimal;
  unitCost: Decimal;
  sourceId: string;
}

const ZERO = new Decimal(0);

class PepsQueue {
  layers: Layer[] = [];
  /** Kilos que salieron sin capa y todavía no cubrió ninguna entrada. */
  deficit = ZERO;

  qty(): Decimal {
    return this.layers.reduce((acc, l) => acc.plus(l.qty), ZERO).minus(this.deficit);
  }

  value(): Decimal {
    return this.layers.reduce((acc, l) => acc.plus(l.qty.times(l.unitCost)), ZERO);
  }

  /** Entrada: primero cubre el faltante, lo que sobra abre capa al final. */
  push(piece: Piece, front = false): void {
    let qty = piece.qty;
    if (this.deficit.gt(0)) {
      const covered = Decimal.min(qty, this.deficit);
      this.deficit = this.deficit.minus(covered);
      qty = qty.minus(covered);
    }
    if (qty.lte(0)) return;
    const layer = { qty, unitCost: piece.unitCost, sourceId: piece.sourceId };
    if (front) this.layers.unshift(layer);
    else this.layers.push(layer);
  }

  /** Saca `qty` en orden PEPS, empezando por la capa `preferId` si se indica. */
  take(qty: Decimal, preferId?: string): { pieces: Piece[]; missing: Decimal } {
    const pieces: Piece[] = [];
    let remaining = qty;
    const order = preferId
      ? [
          ...this.layers.filter((l) => l.sourceId === preferId),
          ...this.layers.filter((l) => l.sourceId !== preferId),
        ]
      : [...this.layers];
    for (const layer of order) {
      if (remaining.lte(0)) break;
      const used = Decimal.min(layer.qty, remaining);
      pieces.push({ qty: used, unitCost: layer.unitCost, sourceId: layer.sourceId });
      layer.qty = layer.qty.minus(used);
      remaining = remaining.minus(used);
    }
    this.layers = this.layers.filter((l) => l.qty.gt(0));
    if (remaining.gt(0)) this.deficit = this.deficit.plus(remaining);
    return { pieces, missing: Decimal.max(remaining, ZERO) };
  }

  /** Ajuste de costo repartido por kilos. `false` si no hay capas vivas que lo reciban. */
  spread(amount: Decimal): boolean {
    const qty = this.layers.reduce((acc, l) => acc.plus(l.qty), ZERO);
    if (qty.lte(0)) return false;
    for (const layer of this.layers) {
      layer.unitCost = layer.unitCost.plus(amount.div(qty));
    }
    return true;
  }

  snapshot(): PepsBalance {
    const qty = this.qty();
    const value = this.value();
    return {
      qty: toFixedString(qty, 'KG'),
      unitCost: toFixedString(qty.gt(0) ? value.div(qty) : ZERO, 'MONEY'),
      total: toFixedString(value, 'MONEY'),
      layers: this.layers.map((l) => ({
        qty: toFixedString(l.qty, 'KG'),
        unitCost: toFixedString(l.unitCost, 'MONEY'),
        total: toFixedString(l.qty.times(l.unitCost), 'MONEY'),
      })),
    };
  }
}

function costOf(pieces: Piece[]): Decimal {
  return pieces.reduce((acc, p) => acc.plus(p.qty.times(p.unitCost)), ZERO);
}

/**
 * Valoriza por PEPS. `movements` llega en orden cronológico del kardex (fecha de operación,
 * instante de grabación, id); los anteriores a `from` arman el saldo inicial y los
 * posteriores a `to` se ignoran.
 */
export function valuePeps(movements: PepsMovement[], from: string, to: string): PepsResult {
  const queue = new PepsQueue();
  /**
   * Lo que consumió cada salida, para devolverlo si se anula: las porciones con capa y el
   * faltante que salió sin capa (con su costo unitario registrado).
   */
  const consumed = new Map<string, { pieces: Piece[]; missing: Decimal; missingUnit: Decimal }>();
  const rows: PepsRow[] = [];
  const warnings: string[] = [];
  let opening: PepsBalance | null = null;
  let inQty = ZERO;
  let inTotal = ZERO;
  let outQty = ZERO;
  let outTotal = ZERO;

  for (const m of movements) {
    if (m.operationDate > to) break;
    const inRange = m.operationDate >= from;
    if (inRange && opening === null) opening = queue.snapshot();

    const qty = toDecimal(m.qty);
    const registered = toDecimal(m.totalCost);
    let rowIn: { qty: Decimal | null; total: Decimal } | null = null;
    let rowOut: { qty: Decimal | null; total: Decimal } | null = null;
    let warning: string | null = null;

    if (m.type === 'IN') {
      const original = m.reversalOfId ? consumed.get(m.reversalOfId) : undefined;
      if (original) {
        // D-288: el faltante de la salida anulada vuelve primero. Lo que el faltante todavía
        // debe se cancela; lo que ya cubrió una entrada posterior vuelve como capa a su costo
        // registrado. Sin esto la reversa de una salida sin capas dejaba el faltante para
        // siempre (el saldo PEPS negativo que el re-fechado hacia atrás produce siempre que el
        // stock es justo).
        const cancelled = Decimal.min(queue.deficit, original.missing);
        queue.deficit = queue.deficit.minus(cancelled);
        const uncovered = original.missing.minus(cancelled);
        // Vuelven las porciones de la salida anulada, al frente y en su orden original.
        for (const piece of [...original.pieces].reverse()) queue.push(piece, true);
        if (uncovered.gt(0)) {
          queue.push({ qty: uncovered, unitCost: original.missingUnit, sourceId: m.id }, true);
        }
        rowIn = {
          qty,
          total: costOf(original.pieces).plus(original.missing.times(original.missingUnit)),
        };
      } else {
        const unitCost = qty.gt(0) ? registered.div(qty) : ZERO;
        queue.push({ qty, unitCost, sourceId: m.id });
        rowIn = { qty, total: registered };
      }
    } else if (m.type === 'OUT') {
      const { pieces, missing } = queue.take(qty, m.reversalOfId ?? undefined);
      const registeredUnit = qty.gt(0) ? registered.div(qty) : ZERO;
      consumed.set(m.id, { pieces, missing, missingUnit: registeredUnit });
      let total = costOf(pieces);
      if (missing.gt(0)) {
        total = total.plus(missing.times(registeredUnit));
        warning = `Salida sin capas PEPS suficientes: ${toFixedString(missing, 'KG')} valorizados al costo registrado del kardex (${toFixedString(registeredUnit, 'MONEY')})`;
      }
      rowOut = { qty, total };
    } else {
      // ADJUST: solo valor. Positivo va en entradas, negativo en salidas, sin cantidad.
      if (!queue.spread(registered)) {
        warning = 'Ajuste de costo sin saldo en capas: no se aplicó a la valorización PEPS';
      } else if (registered.gte(0)) {
        rowIn = { qty: null, total: registered };
      } else {
        rowOut = { qty: null, total: registered.negated() };
      }
    }

    if (warning) warnings.push(`${m.operationDate}: ${warning}`);
    if (!inRange) continue;

    if (rowIn) {
      inQty = inQty.plus(rowIn.qty ?? ZERO);
      inTotal = inTotal.plus(rowIn.total);
    }
    if (rowOut) {
      outQty = outQty.plus(rowOut.qty ?? ZERO);
      outTotal = outTotal.plus(rowOut.total);
    }
    const balanceQty = queue.qty();
    const balanceTotal = queue.value();
    rows.push({
      movementId: m.id,
      operationDate: m.operationDate,
      inQty: rowIn?.qty ? toFixedString(rowIn.qty, 'KG') : null,
      inUnitCost: rowIn?.qty?.gt(0) ? toFixedString(rowIn.total.div(rowIn.qty), 'MONEY') : null,
      inTotal: rowIn ? toFixedString(rowIn.total, 'MONEY') : null,
      outQty: rowOut?.qty ? toFixedString(rowOut.qty, 'KG') : null,
      outUnitCost: rowOut?.qty?.gt(0) ? toFixedString(rowOut.total.div(rowOut.qty), 'MONEY') : null,
      outTotal: rowOut ? toFixedString(rowOut.total, 'MONEY') : null,
      balanceQty: toFixedString(balanceQty, 'KG'),
      balanceUnitCost: toFixedString(
        balanceQty.gt(0) ? balanceTotal.div(balanceQty) : ZERO,
        'MONEY',
      ),
      balanceTotal: toFixedString(balanceTotal, 'MONEY'),
      warning,
    });
  }

  const closing = queue.snapshot();
  return {
    opening: opening ?? closing,
    rows,
    closing,
    totals: {
      inQty: toFixedString(inQty, 'KG'),
      inTotal: toFixedString(inTotal, 'MONEY'),
      outQty: toFixedString(outQty, 'KG'),
      outTotal: toFixedString(outTotal, 'MONEY'),
    },
    warnings,
  };
}
