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

/**
 * La tasa de IGV de la compra, en puntos, leída de sus propios totales. La compra no la guarda:
 * el alta aplica una sola tasa a todas las líneas (18 estándar, 0 exonerado), así que
 * `igv ÷ subtotal` la devuelve; se redondea a dos decimales para absorber el redondeo a
 * céntimos de cada línea. Sin subtotal, 0.
 */
export function impliedIgvRatePct(subtotal: DecimalInput, igv: DecimalInput): Decimal {
  const base = toDecimal(subtotal);
  if (base.isZero()) return new Decimal(0);
  return toDecimal(igv).div(base).times(HUNDRED).toDecimalPlaces(2);
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
