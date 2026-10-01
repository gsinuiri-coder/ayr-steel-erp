import { BadRequestException } from '@nestjs/common';
import { PurchaseStatus } from '@prisma/client';
import { Decimal, money, toDecimal, type DecimalInput } from '@ayr/shared';

/**
 * D-371 — corregir o quitar líneas de una compra **en borrador**: todavía no hay kardex, ni
 * bobinas, ni costo de recepción que mover, así que la corrección es solo de importes. Lo de una
 * compra ya recibida (D-372) es otra cosa: toca kardex y va en su propia pista.
 *
 * Sin consultas: las reglas y la aritmética viven acá para probarse sin base.
 */

const HUNDRED = new Decimal(100);

/** Lo que decide si una compra admite tocar sus líneas. */
export interface DraftEditState {
  status: PurchaseStatus;
  /** Pagos vigentes (no revertidos) registrados contra la compra. */
  livePayments: number;
}

export function assertDraftEditable(state: DraftEditState): void {
  if (state.status !== PurchaseStatus.DRAFT) {
    throw new BadRequestException(
      state.status === PurchaseStatus.RECEIVED
        ? 'La compra ya está recibida: sus líneas movieron kardex y no se editan desde acá'
        : 'La compra está anulada: no hay líneas que corregir',
    );
  }
  if (state.livePayments > 0) {
    throw new BadRequestException(
      'La compra tiene pagos registrados: revierte los pagos antes de corregir sus líneas',
    );
  }
}

export function assertCanDeleteLine(lineCount: number): void {
  if (lineCount <= 1) {
    throw new BadRequestException(
      'Es la única línea de la compra: una compra sin líneas no existe; anúlala en su lugar',
    );
  }
}

/** Las tasas que el alta aplica a una compra: 18 estándar, 0 exonerado. */
const STANDARD_IGV_RATES_PCT = [new Decimal(18), new Decimal(0)];
/** Holgura, en puntos, para absorber el redondeo a céntimos de cada línea. */
const IGV_RATE_TOLERANCE_PCT = new Decimal('0.1');

/**
 * La tasa de IGV de la compra, en puntos, leída de sus propios totales. La compra no la guarda:
 * el alta aplica una sola tasa a todas las líneas, así que `igv ÷ subtotal` la devuelve con el
 * ruido del redondeo por línea (o de los importes del papel, D-359). Se ajusta a la tasa
 * estándar más cercana dentro de 0,1 puntos; si no cae cerca de ninguna, la compra no se
 * corrige desde acá: recalcular con una tasa que nunca existió inventaría un IGV.
 */
export function impliedIgvRatePct(subtotal: DecimalInput, igv: DecimalInput): Decimal {
  const base = toDecimal(subtotal);
  const raw = base.isZero() ? new Decimal(0) : toDecimal(igv).div(base).times(HUNDRED);
  const standard = STANDARD_IGV_RATES_PCT.find((rate) =>
    raw.minus(rate).abs().lte(IGV_RATE_TOLERANCE_PCT),
  );
  if (standard === undefined) {
    throw new BadRequestException(
      `La compra no tiene una tasa de IGV estándar (sale ${raw.toFixed(2)} %): no se recalcula desde acá; anúlala y regístrala de nuevo`,
    );
  }
  return standard;
}

/** Los importes de una línea con su cantidad y costo nuevos: la misma cuenta que el alta. */
export function editedLineAmounts(
  qty: DecimalInput,
  unitPrice: DecimalInput,
  igvRatePct: DecimalInput,
): { subtotal: Decimal; igv: Decimal; total: Decimal } {
  const subtotal = money(toDecimal(qty).times(toDecimal(unitPrice)));
  const igv = money(subtotal.times(toDecimal(igvRatePct)).div(HUNDRED));
  return { subtotal, igv, total: subtotal.plus(igv) };
}

/** Los totales de la cabecera desde sus líneas, con el TC que la compra ya tiene. */
export function purchaseTotalsOf(
  lines: readonly { subtotal: DecimalInput; igv: DecimalInput }[],
  exchangeRate: DecimalInput,
): { subtotal: Decimal; igv: Decimal; total: Decimal; totalPen: Decimal } {
  const subtotal = lines.reduce((acc, l) => acc.plus(toDecimal(l.subtotal)), new Decimal(0));
  const igv = lines.reduce((acc, l) => acc.plus(toDecimal(l.igv)), new Decimal(0));
  const total = subtotal.plus(igv);
  return { subtotal, igv, total, totalPen: money(total.times(toDecimal(exchangeRate))) };
}
