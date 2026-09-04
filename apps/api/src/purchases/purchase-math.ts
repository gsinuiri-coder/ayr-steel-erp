import { Currency, type Prisma } from '@prisma/client';
import { Decimal, money, toDecimal, type CreatePurchaseInput } from '@ayr/shared';

/**
 * Aritmética de compras (D-030, D-038, D-039). Funciones puras, sin base de datos ni
 * Nest, para poder probar el dinero de verdad: totales con IGV, saldo con pagos
 * parciales y conversión de moneda. Todo con `Decimal`, nunca con `number` (D-003).
 */

const HUNDRED = new Decimal(100);

/** Saldo por debajo de un céntimo: la compra se da por saldada. */
const CLOSING_TOLERANCE = new Decimal('0.01');

export interface PurchaseTotals {
  items: ComputedItem[];
  subtotal: Decimal;
  igv: Decimal;
  total: Decimal;
}

/** Lo mínimo de una compra que necesita el cálculo de saldo. */
export interface BalanceablePurchase {
  total: Prisma.Decimal;
  currency: Currency;
}

/**
 * Lo mínimo de un pago que necesita el cálculo de saldo. `reversedAt` es obligatorio a
 * propósito, no opcional: obliga a cada llamador a decidir explícitamente qué pasa un
 * pago anulado (Sesión M-2) en vez de arrastrar el olvido en silencio, que es justo lo
 * que dejaba `cancel()` contando pagos ya anulados como si siguieran vigentes.
 */
export interface BalanceablePayment {
  amount: Prisma.Decimal;
  currency: Currency;
  exchangeRate: Prisma.Decimal;
  reversedAt: Date | null;
}

export interface ComputedItem {
  productId?: string;
  description: string;
  qty: Decimal;
  unit: string;
  unitPrice: Decimal;
  subtotal: Decimal;
  igv: Decimal;
  total: Decimal;
  finishId?: string;
  /** D-085: color de la bobina que la línea da de alta. Solo en compras `COIL`. */
  colorId?: string;
  widthMm?: string;
  thicknessMm?: string;
}

/**
 * Totales de la compra. Se redondea a escala dinero línea por línea y recién después
 * se suma, para que la cabecera siempre cuadre con el detalle que se muestra.
 */
export function computeTotals(input: CreatePurchaseInput): PurchaseTotals {
  const igvRate = toDecimal(input.igvRate).div(HUNDRED);
  const items = input.items.map((item) => {
    const qty = toDecimal(item.qty);
    const unitPrice = toDecimal(item.unitPrice);
    const subtotal = money(qty.times(unitPrice));
    const igv = money(subtotal.times(igvRate));
    return {
      productId: item.productId,
      description: item.description,
      qty,
      unit: item.unit,
      unitPrice,
      subtotal,
      igv,
      total: subtotal.plus(igv),
      finishId: item.finishId,
      colorId: item.colorId,
      widthMm: item.widthMm,
      thicknessMm: item.thicknessMm,
    } satisfies ComputedItem;
  });

  const subtotal = items.reduce((acc, i) => acc.plus(i.subtotal), new Decimal(0));
  const igv = items.reduce((acc, i) => acc.plus(i.igv), new Decimal(0));
  return { items, subtotal, igv, total: subtotal.plus(igv) };
}

export function computeDueDate(input: CreatePurchaseInput): string | null {
  if (input.paymentTerms !== 'CREDITO' || !input.creditDays) return null;
  const due = new Date(`${input.issueDate}T00:00:00.000Z`);
  due.setUTCDate(due.getUTCDate() + input.creditDays);
  return due.toISOString().slice(0, 10);
}

/** Convierte el monto de un pago a la moneda de la compra (D-039). */
export function toPurchaseCurrency(
  amount: Decimal,
  paymentCurrency: Currency,
  purchaseCurrency: Currency,
  rate: Decimal,
): Decimal {
  if (paymentCurrency === purchaseCurrency) return amount;
  if (paymentCurrency === Currency.PEN) return money(amount.div(rate));
  return money(amount.times(rate));
}

export function purchaseBalance(
  purchase: BalanceablePurchase,
  payments: BalanceablePayment[],
): Decimal {
  // Un pago anulado (Sesión M-2) no cuenta para el saldo: se filtra acá, en el único
  // lugar donde se suman pagos, para que ningún llamador (alta de pago, DTO de lista,
  // estado de cuenta) tenga que acordarse de hacerlo por su cuenta.
  const paid = payments
    .filter((p) => p.reversedAt === null)
    .reduce(
      (acc, p) =>
        acc.plus(
          toPurchaseCurrency(
            toDecimal(p.amount.toString()),
            p.currency,
            purchase.currency,
            toDecimal(p.exchangeRate.toString()),
          ),
        ),
      new Decimal(0),
    );
  const balance = money(toDecimal(purchase.total.toString()).minus(paid));
  // Un pago en otra moneda deja residuos de céntimos al convertir: por debajo de un
  // céntimo la compra se considera saldada, si no nunca llegaría a saldo cero (D-039).
  return balance.abs().lt(CLOSING_TOLERANCE) ? new Decimal(0) : balance;
}

export function paidAmount(purchase: BalanceablePurchase, payments: BalanceablePayment[]): Decimal {
  return money(toDecimal(purchase.total.toString()).minus(purchaseBalance(purchase, payments)));
}

export function startOfDayUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}
