import { BadRequestException, ConflictException } from '@nestjs/common';
import { Currency, type CoilStatus, type Prisma } from '@prisma/client';
import {
  businessToday,
  cents,
  daysBetween,
  Decimal,
  money,
  toDecimal,
  type CreatePurchaseInput,
} from '@ayr/shared';

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

/**
 * cc33 N1 (D-534): una compra en soles que quedó grabada con TC ≠ 1 —antes del arreglo— no se
 * recibe ni se recalcula: cada uno de esos caminos multiplica por el TC guardado y propagaría el
 * error al kardex. No se corrige sola (no se reparan datos); se rechaza con el motivo a la vista.
 */
export function assertPenRateIsOne(purchase: {
  currency: Currency;
  exchangeRate: Prisma.Decimal | Decimal | string;
}): void {
  if (purchase.currency !== Currency.PEN) return;
  const rate = toDecimal(purchase.exchangeRate.toString());
  if (rate.eq(1)) return;
  throw new ConflictException(
    `Esta compra en soles quedó grabada con tipo de cambio ${rate.toFixed(4)}: no se recibe ni se recalcula hasta corregirla. Avisa al administrador.`,
  );
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
  widthMm?: string;
  thicknessMm?: string;
  /** D-116: estado con el que nace la bobina. Solo en compras `COIL`. */
  coilStatus?: CoilStatus;
}

/**
 * Totales de la compra. Se redondea a escala dinero línea por línea y recién después
 * se suma, para que la cabecera siempre cuadre con el detalle que se muestra.
 *
 * D-359: `paperAmounts` (solo el importador) trae el valor sin IGV y el IGV **del papel** por
 * línea, que se guardan tal cual en vez de recalcularse de `cantidad × unitario`: un unitario de
 * cuatro decimales no reproduce un importe de dos (D-169/D-255), y el total del papel manda.
 */
export function computeTotals(
  input: CreatePurchaseInput,
  paperAmounts?: readonly { subtotal: string; igv: string }[],
): PurchaseTotals {
  if (paperAmounts !== undefined && paperAmounts.length !== input.items.length) {
    throw new BadRequestException(
      'Los importes del papel no corresponden a las líneas de la compra',
    );
  }
  const igvRate = toDecimal(input.igvRate).div(HUNDRED);
  const items = input.items.map((item, index) => {
    const qty = toDecimal(item.qty);
    const unitPrice = toDecimal(item.unitPrice);
    const paper = paperAmounts?.[index];
    const subtotal = paper ? money(paper.subtotal) : money(qty.times(unitPrice));
    const igv = paper ? money(paper.igv) : money(subtotal.times(igvRate));
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
      widthMm: item.widthMm,
      thicknessMm: item.thicknessMm,
      coilStatus: item.coilStatus,
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

/**
 * Días de atraso de una compra en el estado de cuenta del proveedor (D-039), contra **hoy en
 * Lima** (D-069). cc39 (D-584): antes se contaba contra el día UTC (`startOfDayUtc(new Date())`),
 * que entre las 19:00 y la medianoche de Lima ya es mañana: el atraso salía con un día de más.
 * `dueDate` es una columna `DATE` (medianoche UTC), así que su día es el de su ISO.
 */
export function overdueDays(dueDate: Date | null, now: Date = new Date()): number | null {
  if (dueDate === null) return null;
  return daysBetween(dueDate.toISOString().slice(0, 10), businessToday(now));
}

/**
 * D-359: el costo con que una línea de compra entra al kardex, en soles (D-042): el **subtotal sin
 * IGV** de la línea × TC, al céntimo, y el unitario derivado de ese total (a la escala de la
 * columna). Es lo que `InventoryService.record` recibe como `totalCost`/`unitCost`.
 */
export function receptionCost(
  subtotal: Prisma.Decimal | Decimal,
  qty: Prisma.Decimal | Decimal,
  exchangeRate: Prisma.Decimal | Decimal,
): { unitCost: string; totalCost: string } {
  const totalPen = cents(toDecimal(subtotal.toString()).times(exchangeRate.toString()));
  return {
    unitCost: money(totalPen.div(qty.toString())).toFixed(4),
    totalCost: totalPen.toFixed(4),
  };
}
