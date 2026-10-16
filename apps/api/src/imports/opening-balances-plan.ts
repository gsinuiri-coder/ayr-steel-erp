import {
  Decimal,
  hasCollectibleBalance,
  PAYMENT_METHOD_LABELS,
  PaymentMethod,
  toDecimal,
} from '@ayr/shared';
import { parseCalendarDate } from './parse-spreadsheet';

/**
 * cc56 (D-668) — **saldos iniciales de cobranzas y pagos a proveedor**: el plan puro.
 *
 * El dueño entrega, por comprobante (o por compra), lo cobrado hasta una fecha de corte —una fila
 * por cobro: fecha, monto, medio— o solo el saldo que quedaba pendiente a esa fecha. Esto decide,
 * sin tocar la base, qué cobros (pagos) hay que registrar para que el saldo al corte sea el que dice
 * el Excel. Lo que no aparece se trata según la opción del lote: «pagado al corte» (se registra un
 * cobro por todo lo que se debía al corte) o «sigue pendiente» (no se toca).
 *
 * Es el mismo cálculo para clientes y proveedores: una **cuenta** (comprobante o compra) tiene un
 * neto al corte, lo ya pagado con fecha hasta el corte y lo que hoy se puede pagar (el saldo vigente
 * en céntimos). Los montos van en la moneda de la cuenta (soles en ventas, D-064; la de la compra en
 * compras). El registro lo hace después el servicio de dominio de cada lado (`addPaymentInTx`), que
 * vuelve a validar el saldo con la cuenta bloqueada.
 */

/** Qué hacer con lo que no aparece en el Excel (D-668): no hay valor por defecto. */
export const MISSING_POLICIES = ['PAID', 'PENDING'] as const;
export type MissingPolicy = (typeof MISSING_POLICIES)[number];

export const MISSING_POLICY_LABELS: Record<MissingPolicy, string> = {
  PAID: 'pagado al corte',
  PENDING: 'sigue pendiente',
};

/** Una cuenta que se puede cobrar (o pagar): un comprobante vivo o una compra recibida. */
export interface OpeningAccount {
  id: string;
  /** Cómo la nombra el Excel: `FFA1-00001360`, o `20123456789 · F001-123` en compras. */
  key: string;
  issueDate: string;
  /** Neto al corte: total menos las notas de crédito vivas emitidas hasta el corte (4 decimales). */
  netAtCutoff: Decimal;
  /** Lo pagado con fecha hasta el corte, ya registrado en la app (cobros vivos). */
  paidUpToCutoff: Decimal;
  /** Lo que hoy se puede cobrar, en céntimos (`payableBalance` del saldo vigente). */
  payableNow: Decimal;
  /** Moneda de la cuenta (`PEN` en ventas; la de la compra en compras). */
  currency?: string;
}

/** Una fila del Excel ya leída (texto tal como vino; el plan lo valida). */
export interface OpeningRow {
  rowNumber: number;
  key: string;
  date: string;
  amount: string;
  method: string;
  reference: string;
  balance: string;
  /** Solo compras en moneda extranjera: el tipo de cambio del pago (opcional). */
  exchangeRate?: string;
}

export interface PlannedPayment {
  accountId: string;
  key: string;
  date: string;
  /** Dos decimales, en la moneda de la cuenta. */
  amount: string;
  method: PaymentMethod;
  reference: string | null;
  exchangeRate: string | null;
  /** De dónde sale: una fila de cobro, el saldo declarado o la opción del lote. */
  source: 'ROW' | 'BALANCE' | 'MISSING_PAID';
  rowNumbers: number[];
  currency?: string;
}

export interface PlanIssue {
  rowNumber: number | null;
  key: string | null;
  message: string;
}

export interface AccountOutcome {
  key: string;
  issueDate: string;
  /** Saldo al corte antes del lote (neto al corte − pagado hasta el corte). */
  balanceAtCutoffBefore: string;
  registered: string;
  balanceAtCutoffAfter: string;
  treatment: 'EXCEL' | 'MISSING_PAID' | 'MISSING_PENDING' | 'AFTER_CUTOFF';
}

export interface OpeningPlan {
  payments: PlannedPayment[];
  errors: PlanIssue[];
  warnings: PlanIssue[];
  accounts: AccountOutcome[];
  totalRegistered: string;
  /** Lo registrado por moneda (compras en soles y en dólares no se suman entre sí). */
  totalsByCurrency: Record<string, string>;
}

export interface PlanOptions {
  cutoff: string;
  missing: MissingPolicy;
  /** Piso de la carga histórica (`HISTORICAL_LOAD_START`): ningún pago antes. */
  historicalFloor: string;
  /** Lo que dice el mensaje de un medio vacío o una cuenta inexistente. */
  noun: { account: string; payment: string };
}

const ZERO = new Decimal(0);

/** `1 234,50`, `1,234.50`, `1234.5`, `S/ 1234` → Decimal. `null` si no es un número. */
export function parseAmount(raw: string): Decimal | null {
  let text = raw.replaceAll(/s\/\.?|us\$|\$|\s/gi, '');
  if (text === '') return null;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    // Los dos separadores: el último es el decimal.
    text =
      lastComma > lastDot ? text.replaceAll('.', '').replace(',', '.') : text.replaceAll(',', '');
  } else if (lastComma !== -1) {
    // Solo coma: decimal si le siguen uno o dos dígitos al final (`1234,5`), si no miles.
    const decimals = text.length - lastComma - 1;
    text =
      decimals >= 1 && decimals <= 2 && text.indexOf(',') === lastComma
        ? text.replace(',', '.')
        : text.replaceAll(',', '');
  }
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  return toDecimal(text);
}

const METHOD_BY_LABEL = new Map<string, PaymentMethod>(
  Object.entries(PAYMENT_METHOD_LABELS).flatMap(([method, label]) => [
    [normalize(label), method as PaymentMethod],
    [normalize(method), method as PaymentMethod],
  ]),
);
for (const [alias, method] of [
  ['yape', PaymentMethod.WALLET],
  ['plin', PaymentMethod.WALLET],
  ['billetera', PaymentMethod.WALLET],
  ['deposito', PaymentMethod.DEPOSIT],
  ['transferencia bancaria', PaymentMethod.TRANSFER],
  ['letra', PaymentMethod.OTHER],
] as const) {
  METHOD_BY_LABEL.set(alias, method);
}

function normalize(text: string): string {
  return text.trim().toLowerCase().normalize('NFD').replaceAll(/[̀-ͯ]/g, '');
}

/** `Transferencia` → `TRANSFER`. `null` si no es un medio conocido. */
export function parseMethod(raw: string): PaymentMethod | null {
  return METHOD_BY_LABEL.get(normalize(raw)) ?? null;
}

/** Redondeo de lo que se paga: al céntimo hacia arriba, como `payableBalance` (D-169). */
function cents(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_CEIL);
}

interface ParsedRow {
  row: OpeningRow;
  kind: 'PAYMENT' | 'BALANCE' | 'EMPTY';
  date: string | null;
  amount: Decimal | null;
  balance: Decimal | null;
  method: PaymentMethod;
}

/** Lee y valida una fila; devuelve `null` (con su error ya anotado) si no sirve. */
function parseRow(
  row: OpeningRow,
  account: OpeningAccount,
  options: PlanOptions,
  errors: PlanIssue[],
  warnings: PlanIssue[],
): ParsedRow | null {
  const issue = (message: string): PlanIssue => ({
    rowNumber: row.rowNumber,
    key: row.key,
    message,
  });
  const hasPayment = row.amount.trim() !== '' || row.date.trim() !== '';
  const hasBalance = row.balance.trim() !== '';
  if (!hasPayment && !hasBalance) {
    return { row, kind: 'EMPTY', date: null, amount: null, balance: null, method: 'OTHER' };
  }
  if (hasPayment && hasBalance) {
    errors.push(
      issue(
        `una fila es un ${options.noun.payment} (fecha y monto) o un saldo al corte, no las dos cosas`,
      ),
    );
    return null;
  }

  let method: PaymentMethod = PaymentMethod.OTHER;
  if (row.method.trim() === '') {
    if (hasPayment) warnings.push(issue('sin medio de pago: se registra como «Otro»'));
  } else {
    const parsed = parseMethod(row.method);
    if (parsed === null) {
      errors.push(issue(`medio de pago desconocido: «${row.method.trim()}»`));
      return null;
    }
    method = parsed;
  }

  if (hasBalance) {
    const balance = parseAmount(row.balance);
    if (balance === null || balance.isNegative()) {
      errors.push(issue(`saldo al corte inválido: «${row.balance.trim()}»`));
      return null;
    }
    return { row, kind: 'BALANCE', date: options.cutoff, amount: null, balance, method };
  }

  const amount = parseAmount(row.amount);
  if (amount === null || amount.lte(0)) {
    errors.push(issue(`monto inválido: «${row.amount.trim()}» (tiene que ser mayor que cero)`));
    return null;
  }
  if (amount.decimalPlaces() > 2) {
    errors.push(issue(`monto con más de dos decimales: «${row.amount.trim()}»`));
    return null;
  }
  let date = options.cutoff;
  if (row.date.trim() === '') {
    warnings.push(issue(`sin fecha: se registra al corte (${options.cutoff})`));
  } else {
    const parsed = parseCalendarDate(row.date);
    if (parsed === null) {
      errors.push(issue(`fecha inválida: «${row.date.trim()}» (usa AAAA-MM-DD o DD/MM/AAAA)`));
      return null;
    }
    date = parsed;
  }
  if (date > options.cutoff) {
    errors.push(issue(`la fecha ${date} es posterior al corte (${options.cutoff})`));
    return null;
  }
  if (date < options.historicalFloor) {
    errors.push(
      issue(
        `la fecha ${date} es anterior al inicio de la carga histórica (${options.historicalFloor})`,
      ),
    );
    return null;
  }
  if (date < account.issueDate) {
    warnings.push(issue(`la fecha ${date} es anterior a la emisión (${account.issueDate})`));
  }
  return { row, kind: 'PAYMENT', date, amount, balance: null, method };
}

/**
 * El plan del lote. No escribe nada: dice qué pagos registrar, qué filas tienen error (y entonces
 * no se ejecuta nada del lote) y cómo queda el saldo al corte de cada cuenta.
 */
export function planOpeningBalances(
  accounts: readonly OpeningAccount[],
  rows: readonly OpeningRow[],
  options: PlanOptions,
): OpeningPlan {
  const errors: PlanIssue[] = [];
  const warnings: PlanIssue[] = [];
  const byKey = new Map<string, OpeningAccount[]>();
  for (const account of accounts) {
    byKey.set(account.key, [...(byKey.get(account.key) ?? []), account]);
  }

  const rowsByAccount = new Map<string, ParsedRow[]>();
  for (const row of rows) {
    if (row.key.trim() === '') {
      errors.push({
        rowNumber: row.rowNumber,
        key: null,
        message: `falta el ${options.noun.account}`,
      });
      continue;
    }
    const matches = byKey.get(row.key) ?? [];
    if (matches.length !== 1) {
      errors.push({
        rowNumber: row.rowNumber,
        key: row.key,
        message:
          matches.length === 0
            ? `${options.noun.account} inexistente o sin saldo que registrar (anulado, borrador o nota de crédito)`
            : `${options.noun.account} ambiguo: hay ${String(matches.length)} con ese número`,
      });
      continue;
    }
    const [account] = matches as [OpeningAccount];
    const blank = [row.date, row.amount, row.balance].every((v) => v.trim() === '');
    if (account.issueDate > options.cutoff && blank) continue;
    if (account.issueDate > options.cutoff) {
      errors.push({
        rowNumber: row.rowNumber,
        key: row.key,
        message: `emitido el ${account.issueDate}, después del corte (${options.cutoff}): no es un saldo inicial`,
      });
      continue;
    }
    const parsed = parseRow(row, account, options, errors, warnings);
    if (parsed === null) continue;
    rowsByAccount.set(account.id, [...(rowsByAccount.get(account.id) ?? []), parsed]);
  }

  const payments: PlannedPayment[] = [];
  const outcomes: AccountOutcome[] = [];
  for (const account of accounts) {
    const rawBefore = Decimal.max(account.netAtCutoff.minus(account.paidUpToCutoff), ZERO);
    // D-377: un resto de fracciones de céntimo no es deuda; no se registra un cobro de 0,01 por él.
    const before = hasCollectibleBalance(rawBefore) ? rawBefore : ZERO;
    const outcome = (registered: Decimal, treatment: AccountOutcome['treatment']): void => {
      outcomes.push({
        key: account.key,
        issueDate: account.issueDate,
        balanceAtCutoffBefore: before.toFixed(2),
        registered: registered.toFixed(2),
        balanceAtCutoffAfter: Decimal.max(before.minus(registered), ZERO).toFixed(2),
        treatment,
      });
    };
    if (account.issueDate > options.cutoff) {
      outcome(ZERO, 'AFTER_CUTOFF');
      continue;
    }
    const parsed = (rowsByAccount.get(account.id) ?? []).filter((r) => r.kind !== 'EMPTY');
    const accountError = (message: string, rowNumbers: number[]): void => {
      errors.push({ rowNumber: rowNumbers[0] ?? null, key: account.key, message });
    };
    // Lo que se puede registrar sin pasar el saldo al corte ni el saldo de hoy.
    const room = Decimal.min(cents(before), account.payableNow);

    let planned: PlannedPayment[] = [];
    if (parsed.length === 0) {
      if (options.missing === 'PENDING' || room.lte(0)) {
        outcome(ZERO, options.missing === 'PAID' ? 'MISSING_PAID' : 'MISSING_PENDING');
        continue;
      }
      planned = [
        {
          accountId: account.id,
          key: account.key,
          currency: account.currency,
          date: options.cutoff,
          amount: room.toFixed(2),
          method: PaymentMethod.OTHER,
          reference: null,
          exchangeRate: null,
          source: 'MISSING_PAID',
          rowNumbers: [],
        },
      ];
      payments.push(...planned);
      outcome(room, 'MISSING_PAID');
      continue;
    }

    const balances = parsed.filter((r) => r.kind === 'BALANCE');
    const rowNumbers = parsed.map((r) => r.row.rowNumber);
    if (balances.length > 0 && (balances.length > 1 || parsed.length > 1)) {
      accountError(
        `tiene ${String(parsed.length)} filas: con saldo al corte va una sola fila`,
        rowNumbers,
      );
      continue;
    }
    if (balances.length === 1) {
      const [only] = balances as [ParsedRow];
      const declared = only.balance ?? ZERO;
      const toRegister = cents(before).minus(declared);
      if (toRegister.isNegative()) {
        accountError(
          `el saldo al corte declarado (${declared.toFixed(2)}) es mayor que lo que se debía al corte (${before.toFixed(2)})`,
          rowNumbers,
        );
        continue;
      }
      if (toRegister.gt(room)) {
        accountError(
          `habría que registrar ${toRegister.toFixed(2)} y hoy solo se puede ${room.toFixed(2)} (una nota de crédito o un ${options.noun.payment} posterior al corte ya bajó el saldo)`,
          rowNumbers,
        );
        continue;
      }
      if (toRegister.gt(0)) {
        planned = [
          {
            accountId: account.id,
            key: account.key,
            currency: account.currency,
            date: options.cutoff,
            amount: toRegister.toFixed(2),
            method: only.method,
            reference: blankToNull(only.row.reference),
            exchangeRate: blankToNull(only.row.exchangeRate),
            source: 'BALANCE',
            rowNumbers,
          },
        ];
      }
      payments.push(...planned);
      outcome(toRegister, 'EXCEL');
      continue;
    }

    if (account.paidUpToCutoff.gt(0)) {
      accountError(
        `ya tiene ${account.paidUpToCutoff.toFixed(2)} registrado en la app hasta el corte: las filas de ${options.noun.payment} duplicarían lo cobrado. Para esta cuenta usa «saldo pendiente al corte»`,
        rowNumbers,
      );
      continue;
    }
    const total = parsed.reduce((acc, r) => acc.plus(r.amount ?? ZERO), ZERO);
    if (total.gt(room)) {
      accountError(
        `los ${options.noun.payment}s suman ${total.toFixed(2)} y el saldo al corte es ${cents(before).toFixed(2)}` +
          (account.payableNow.lt(cents(before))
            ? ` (hoy se puede registrar hasta ${account.payableNow.toFixed(2)})`
            : ''),
        rowNumbers,
      );
      continue;
    }
    planned = parsed.map((r) => ({
      accountId: account.id,
      key: account.key,
      currency: account.currency,
      date: r.date ?? options.cutoff,
      amount: (r.amount ?? ZERO).toFixed(2),
      method: r.method,
      reference: blankToNull(r.row.reference),
      exchangeRate: blankToNull(r.row.exchangeRate),
      source: 'ROW' as const,
      rowNumbers: [r.row.rowNumber],
    }));
    payments.push(...planned);
    outcome(total, 'EXCEL');
  }

  const totalRegistered = payments.reduce((acc, p) => acc.plus(p.amount), ZERO);
  const byCurrency = new Map<string, Decimal>();
  for (const p of payments) {
    const c = p.currency ?? 'PEN';
    byCurrency.set(c, (byCurrency.get(c) ?? ZERO).plus(p.amount));
  }
  return {
    payments,
    errors,
    warnings,
    accounts: outcomes,
    totalRegistered: totalRegistered.toFixed(2),
    totalsByCurrency: Object.fromEntries([...byCurrency].map(([c, v]) => [c, v.toFixed(2)])),
  };
}

/** Una celda vacía (o solo espacios) es «no vino». */
function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}
