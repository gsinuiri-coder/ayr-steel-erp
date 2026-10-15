import { BadRequestException } from '@nestjs/common';
import {
  cents,
  Decimal,
  DERIVED_UNIT_VALUE_DECIMALS,
  derivedUnitValue,
  IGV_RATE_PCT,
  salesTotals,
  serializeSalesTotals,
  toDecimal,
  toFixedString,
  type SalesLineTotals,
} from '@ayr/shared';
import { PartLedger, partKind, pendingWithDrafts } from './invoicing-math';

/**
 * cc54 (D-663) — **las líneas de una nota de crédito, según su motivo.** Funciones puras: el
 * servicio lee el comprobante afectado y lo ya acreditado, y escribe lo que esto decide.
 *
 * - Por **cantidad** (01, 02, 06, 07): cada línea acredita unidades a su valor; la línea entera
 *   copia su importe (D-169) y la parte que cierra toma el resto (D-265).
 * - Por **precio** (05): la diferencia entre el precio vigente y el nuevo, sobre las unidades que
 *   siguen facturadas.
 * - Por **monto** (04): un monto con IGV repartido entre las líneas en proporción a lo que les
 *   queda; la cabecera suma exactamente el monto (el importe del papel manda).
 * - Con **importe cero** (03, 13): las líneas con su cantidad y los importes en cero.
 *
 * «Lo acreditado» se separa en dos: la **cantidad** solo la mueven los motivos de cantidad; el
 * **importe**, todos. Una rebaja anterior no devuelve unidades, pero sí baja lo que valen.
 */

const ZERO = new Decimal(0);
const ONE_PLUS_IGV = new Decimal(1).plus(toDecimal(IGV_RATE_PCT).div(100));

/** Una línea del comprobante que se acredita. */
export interface AffectedLine {
  id: string;
  lineNumber: number;
  qty: Decimal;
  subtotalPen: Decimal;
  igvPen: Decimal;
  totalPen: Decimal;
  unitPricePen: string;
  description: string;
  productId: string | null;
  unit: string;
  salesOrderItemId: string | null;
}

export interface Amounts {
  subtotal: Decimal;
  igv: Decimal;
  total: Decimal;
}

/** Lo ya acreditado de una línea por notas vivas (o en borrador). */
export interface LineCredits {
  /** Unidades, solo de los motivos de cantidad. */
  qty: Decimal;
  /** Importes de los motivos de cantidad. */
  byQty: Amounts;
  /** Importes de los demás motivos (rebajas). */
  byAmount: Amounts;
}

export const NO_CREDITS: LineCredits = {
  qty: ZERO,
  byQty: { subtotal: ZERO, igv: ZERO, total: ZERO },
  byAmount: { subtotal: ZERO, igv: ZERO, total: ZERO },
};

/** Una línea de la nota, lista para escribir. */
export interface NoteLine {
  original: AffectedLine;
  qty: string;
  unitPricePen: string;
  description: string;
  subtotalPen: string;
  igvPen: string;
  totalPen: string;
}

const plus = (a: Amounts, b: Amounts): Amounts => ({
  subtotal: a.subtotal.plus(b.subtotal),
  igv: a.igv.plus(b.igv),
  total: a.total.plus(b.total),
});

/** Todo lo acreditado de la línea en importe (por cantidad y por rebajas). */
export function creditedAmounts(c: LineCredits): Amounts {
  return plus(c.byQty, c.byAmount);
}

/** Lo que le queda a la línea: unidades facturadas y lo que valen. */
export function remainingOf(
  line: AffectedLine,
  c: LineCredits,
): { qty: Decimal; amounts: Amounts } {
  const done = creditedAmounts(c);
  return {
    qty: line.qty.minus(c.qty),
    amounts: {
      subtotal: line.subtotalPen.minus(done.subtotal),
      igv: line.igvPen.minus(done.igv),
      total: line.totalPen.minus(done.total),
    },
  };
}

function toNoteLine(
  original: AffectedLine,
  qty: Decimal,
  totals: SalesLineTotals,
  unitPricePen: Decimal,
  description = original.description,
): NoteLine {
  return {
    original,
    qty: toFixedString(qty, 'KG'),
    unitPricePen: toFixedString(Decimal.max(unitPricePen, ZERO), 'MONEY'),
    description,
    ...serializeSalesTotals(totals),
  };
}

function lineOf(lines: readonly AffectedLine[], id: string): AffectedLine {
  const found = lines.find((l) => l.id === id);
  if (!found) {
    throw new BadRequestException('Hay una línea que no pertenece al comprobante afectado');
  }
  return found;
}

/**
 * Por **cantidad** (01, 02, 06, 07). `requested` en `null` es la nota **total**: lo que le queda a
 * cada línea. Es la cuenta de siempre (D-169, D-255, D-265) con una corrección de cc54: si la
 * línea ya tuvo una rebaja, la línea entera no copia su importe (ya no vale eso) y la parte se
 * valoriza a lo que le queda por unidad, así la que cierra toma exactamente el resto.
 */
export function qtyCreditLines(
  lines: readonly AffectedLine[],
  requested: readonly { affectedItemId: string; qty: string }[] | null,
  credited: ReadonlyMap<string, LineCredits>,
  drafted: ReadonlyMap<string, LineCredits> = new Map(),
): NoteLine[] {
  const creditsOf = (id: string) => credited.get(id) ?? NO_CREDITS;
  const asked =
    requested ??
    lines
      // Una total sobre un comprobante que ya tuvo una parcial acredita **lo que queda**.
      .filter((l) => l.qty.minus(creditsOf(l.id).qty).gt(0))
      .map((l) => ({ affectedItemId: l.id, qty: l.qty.minus(creditsOf(l.id).qty).toFixed(3) }));
  const parts = new PartLedger(
    [...credited].map(([id, c]) => {
      const a = creditedAmounts(c);
      return [id, { subtotalPen: a.subtotal, igvPen: a.igv, totalPen: a.total }] as const;
    }),
    [...drafted].map(([id, c]) => {
      const a = creditedAmounts(c);
      return [id, { subtotalPen: a.subtotal, igvPen: a.igv, totalPen: a.total }] as const;
    }),
  );
  // Dos líneas de la nota sobre la misma línea del comprobante acreditaban el doble.
  const usedHere = new Map<string, Decimal>();
  return asked.map((line) => {
    const original = lineOf(lines, line.affectedItemId);
    const c = creditsOf(original.id);
    const qty = toDecimal(line.qty);
    const pending = original.qty.minus(c.qty).minus(usedHere.get(original.id) ?? ZERO);
    if (qty.lte(0)) {
      throw new BadRequestException(
        `La línea ${String(original.lineNumber)} ya está acreditada por completo`,
      );
    }
    if (qty.gt(pending)) {
      throw new BadRequestException(
        `A la línea ${String(original.lineNumber)} le quedan ${pending.toFixed(3)} por acreditar y se intentan acreditar ${qty.toFixed(3)}`,
      );
    }
    usedHere.set(original.id, (usedHere.get(original.id) ?? ZERO).plus(qty));
    const rebated = c.byAmount.total.gt(0);
    const closing = pendingWithDrafts({
      qty,
      pending,
      drafts: (drafted.get(original.id) ?? NO_CREDITS).qty,
    });
    let kind = partKind({
      qty,
      lineQty: original.qty,
      pending: closing.pending,
      priceEdited: false,
    });
    if (kind === 'FULL' && rebated) kind = 'CLOSING';
    const rest = remainingOf(original, c);
    // D-255: el unitario derivado del importe, con diez decimales. Con una rebaja previa, el de lo
    // que queda (lo que de verdad se cobra por unidad).
    const unit =
      rebated && rest.qty.gt(0)
        ? derivedUnitValue(rest.qty, rest.amounts.subtotal)
        : derivedUnitValue(original.qty, original.subtotalPen);
    const totals = parts.part(
      original.id,
      { subtotalPen: original.subtotalPen, igvPen: original.igvPen, totalPen: original.totalPen },
      kind,
      () =>
        salesTotals([{ qty: line.qty, unitPricePen: unit.toFixed(DERIVED_UNIT_VALUE_DECIMALS) }]),
      closing.countDrafts,
    );
    return toNoteLine(original, qty, totals, toDecimal(original.unitPricePen));
  });
}

/**
 * 05 · **precio nuevo por línea** (con IGV). La rebaja es la diferencia entre lo que hoy vale cada
 * unidad facturada y el precio nuevo, sobre las unidades que siguen facturadas. Un precio nuevo
 * de cero acredita exactamente lo que le queda a la línea.
 */
export function priceCreditLines(
  lines: readonly AffectedLine[],
  prices: readonly { affectedItemId: string; unitPriceWithIgvPen: string }[],
  credited: ReadonlyMap<string, LineCredits>,
): NoteLine[] {
  return prices.map((p) => {
    const original = lineOf(lines, p.affectedItemId);
    const rest = remainingOf(original, credited.get(original.id) ?? NO_CREDITS);
    const at = `La línea ${String(original.lineNumber)}`;
    if (rest.qty.lte(0) || rest.amounts.total.lte(0)) {
      throw new BadRequestException(`${at} ya está acreditada por completo`);
    }
    const current = derivedUnitValue(rest.qty, rest.amounts.subtotal);
    const currentWithIgv = rest.amounts.total.div(rest.qty);
    const next = toDecimal(p.unitPriceWithIgvPen)
      .div(ONE_PLUS_IGV)
      .toDecimalPlaces(DERIVED_UNIT_VALUE_DECIMALS, Decimal.ROUND_HALF_UP);
    if (next.gte(current)) {
      throw new BadRequestException(
        `${at}: el precio nuevo tiene que ser menor que el vigente (S/ ${currentWithIgv.toFixed(2)} con IGV)`,
      );
    }
    const rebate = current.minus(next);
    const exactRest: SalesLineTotals = { ...rest.amounts };
    const recomputed = salesTotals([
      { qty: rest.qty.toFixed(3), unitPricePen: rebate.toFixed(DERIVED_UNIT_VALUE_DECIMALS) },
    ]);
    const totals =
      toDecimal(p.unitPriceWithIgvPen).isZero() || recomputed.total.gt(rest.amounts.total)
        ? exactRest
        : recomputed;
    return toNoteLine(original, rest.qty, totals, totals.subtotal.div(rest.qty));
  });
}

/**
 * Reparte `amount` (4 decimales) en proporción a `weights`; el resto del redondeo va a la de mayor
 * peso, así la suma es exacta.
 */
export function prorate(amount: Decimal, weights: readonly Decimal[]): Decimal[] {
  const sum = weights.reduce((a, w) => a.plus(w), ZERO);
  if (sum.lte(0)) return weights.map(() => ZERO);
  const parts = weights.map((w) =>
    amount.times(w).div(sum).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
  );
  const diff = amount.minus(parts.reduce((a, p) => a.plus(p), ZERO));
  let biggest = 0;
  weights.forEach((w, i) => {
    if (w.gt(weights[biggest] ?? ZERO)) biggest = i;
  });
  parts[biggest] = (parts[biggest] ?? ZERO).plus(diff);
  return parts;
}

/**
 * 04 · **un monto con IGV** sobre el total. La cabecera tiene que dar exactamente ese monto (el del
 * papel): gravada = céntimo(monto ÷ 1.18), IGV = monto − gravada, y cada cifra se reparte entre las
 * líneas en proporción a lo que les queda. Si el monto es todo lo que queda, cada línea toma su resto.
 */
export function amountCreditLines(
  lines: readonly AffectedLine[],
  amountWithIgv: string,
  credited: ReadonlyMap<string, LineCredits>,
): NoteLine[] {
  const open = lines
    .map((l) => ({ line: l, rest: remainingOf(l, credited.get(l.id) ?? NO_CREDITS) }))
    .filter((x) => x.rest.qty.gt(0) && x.rest.amounts.total.gt(0));
  const left = open.reduce((a, x) => a.plus(x.rest.amounts.total), ZERO);
  const amount = toDecimal(amountWithIgv);
  if (open.length === 0) {
    throw new BadRequestException('No queda nada por acreditar en este comprobante');
  }
  if (amount.gt(left)) {
    throw new BadRequestException(
      `La rebaja (S/ ${amount.toFixed(2)}) pasa lo que queda por acreditar (S/ ${left.toFixed(2)})`,
    );
  }
  if (amount.equals(left)) {
    return open.map((x) =>
      toNoteLine(x.line, x.rest.qty, x.rest.amounts, x.rest.amounts.subtotal.div(x.rest.qty)),
    );
  }
  const subtotal = cents(amount.div(ONE_PLUS_IGV));
  const igv = amount.minus(subtotal);
  const weights = open.map((x) => x.rest.amounts.total);
  const subs = prorate(subtotal, weights);
  const igvs = prorate(igv, weights);
  return open
    .map((x, i) => {
      const s = subs[i] ?? ZERO;
      const g = igvs[i] ?? ZERO;
      return toNoteLine(
        x.line,
        x.rest.qty,
        { subtotal: s, igv: g, total: s.plus(g) },
        s.div(x.rest.qty),
      );
    })
    .filter((l) => toDecimal(l.totalPen).gt(0));
}

/**
 * 03 y 13 · **importe cero**. El 03 lleva solo las líneas corregidas, con su descripción nueva; el
 * 13, todas (el comprobante electrónico pide al menos una línea).
 */
export function zeroCreditLines(
  lines: readonly AffectedLine[],
  descriptions: readonly { affectedItemId: string; description: string }[] | null,
): NoteLine[] {
  const zero: SalesLineTotals = { subtotal: ZERO, igv: ZERO, total: ZERO };
  if (descriptions === null) {
    return lines.map((l) => toNoteLine(l, l.qty, zero, ZERO));
  }
  return descriptions.map((d) => {
    const original = lineOf(lines, d.affectedItemId);
    if (d.description.trim() === original.description.trim()) {
      throw new BadRequestException(
        `La línea ${String(original.lineNumber)}: la descripción corregida es igual a la facturada`,
      );
    }
    return toNoteLine(original, original.qty, zero, ZERO, d.description.trim());
  });
}

/** Una línea de una NC anterior, como la lee el servicio. */
export interface PriorCreditRow {
  affectedItemId: string | null;
  qty: { toString(): string };
  subtotalPen: { toString(): string };
  igvPen: { toString(): string };
  totalPen: { toString(): string };
  document: { creditNoteReason: string | null };
}

/**
 * Lo acreditado por línea a partir de las líneas de las NC anteriores: la cantidad y su importe
 * solo de los motivos de cantidad; el importe de los demás, aparte (D-663).
 */
export function creditsByLine(
  rows: readonly PriorCreditRow[],
  isQtyReason: (reason: string | null) => boolean,
): Map<string, LineCredits> {
  const out = new Map<string, LineCredits>();
  for (const r of rows) {
    if (r.affectedItemId === null) continue;
    const prev = out.get(r.affectedItemId) ?? NO_CREDITS;
    const amounts: Amounts = {
      subtotal: toDecimal(r.subtotalPen.toString()),
      igv: toDecimal(r.igvPen.toString()),
      total: toDecimal(r.totalPen.toString()),
    };
    out.set(
      r.affectedItemId,
      isQtyReason(r.document.creditNoteReason)
        ? { ...prev, qty: prev.qty.plus(r.qty.toString()), byQty: plus(prev.byQty, amounts) }
        : { ...prev, byAmount: plus(prev.byAmount, amounts) },
    );
  }
  return out;
}
