import { Decimal, PURCHASE_IMPORT_COLUMNS, QUOTATION_IMPORT_COLUMNS, toDecimal } from '@ayr/shared';
import {
  firstNegativeDate,
  firstValidDate,
  RECOST_MAX_ROWS,
  type QtyRow,
} from '../inventory/recost-engine';
import { getField, parseCalendarDate, rawToString } from './parse-spreadsheet';

/**
 * cc63 — **la revisión previa de una carga atrasada** (`pnpm carga:revisar`). Recibe el «plan de
 * carga» (un Excel con una hoja por tipo de operación) y, sin escribir nada, dice qué haría el
 * sistema al cargarlo en el orden documentado (`docs/operacion/carga-atrasada.md`):
 *
 * - qué salida dejaría un ítem en negativo en alguna fecha (D-652/D-662), con la primera fecha
 *   válida: el mismo cálculo que el kardex (`firstNegativeDate` y `firstValidDate` del motor);
 * - cuántas filas recostearía cada movimiento atrasado y si alguno pasa el tope (`RECOST_MAX_ROWS`);
 * - qué comprobante queda fuera de la ventana de emisión de 90 días (D-072/D-210) o cerca de ella;
 * - fechas futuras o anteriores al inicio de la carga histórica, y referencias rotas entre hojas.
 *
 * El formato del archivo está pensado para que un cargador futuro lo use sin cambios: la hoja
 * «Compras» tiene las columnas del importador de compras (más la fecha de recepción) y la hoja
 * «Ventas» es el export del sistema de facturación que ya lee el importador de cotizaciones.
 */

export const LOAD_SHEETS = {
  purchases: 'Compras',
  sales: 'Ventas',
  production: 'Producción',
  dispatches: 'Despachos',
  collections: 'Cobros',
  supplierPayments: 'Pagos',
} as const;

/** Las columnas propias del plan (las de compras y ventas son las de sus importadores). */
export const LOAD_COLUMNS = {
  receivedDate: { key: 'receivedDate', header: 'FECHA DE RECEPCIÓN', required: true },
  saleDocument: { key: 'saleDocument', header: 'SERIE - NÚMERO', required: true },
  date: { key: 'date', header: 'FECHA', required: true },
  sku: { key: 'sku', header: 'CÓDIGO PRODUCTO', required: true },
  qty: { key: 'qty', header: 'CANTIDAD', required: true },
  coil: { key: 'coil', header: 'CÓDIGO BOBINA', required: false },
  coilKg: { key: 'coilKg', header: 'KG CONSUMIDOS', required: false },
  amount: { key: 'amount', header: 'MONTO', required: true },
  method: { key: 'method', header: 'MEDIO DE PAGO', required: false },
  reference: { key: 'reference', header: 'REFERENCIA', required: false },
  supplierRuc: { key: 'supplierRuc', header: 'RUC PROVEEDOR', required: true },
  purchaseDocument: { key: 'purchaseDocument', header: 'SERIE-NÚMERO', required: true },
} as const;

/** Encabezados de cada hoja, en el orden en que la plantilla los escribe. */
export const LOAD_SHEET_HEADERS: Record<keyof typeof LOAD_SHEETS, string[]> = {
  purchases: [
    ...Object.values(PURCHASE_IMPORT_COLUMNS).map((c) => c.header),
    LOAD_COLUMNS.receivedDate.header,
  ],
  sales: Object.values(QUOTATION_IMPORT_COLUMNS),
  production: [
    LOAD_COLUMNS.saleDocument.header,
    LOAD_COLUMNS.date.header,
    LOAD_COLUMNS.sku.header,
    LOAD_COLUMNS.qty.header,
    LOAD_COLUMNS.coil.header,
    LOAD_COLUMNS.coilKg.header,
  ],
  dispatches: [
    LOAD_COLUMNS.saleDocument.header,
    LOAD_COLUMNS.date.header,
    LOAD_COLUMNS.sku.header,
    LOAD_COLUMNS.qty.header,
  ],
  collections: [
    LOAD_COLUMNS.saleDocument.header,
    LOAD_COLUMNS.date.header,
    LOAD_COLUMNS.amount.header,
    LOAD_COLUMNS.method.header,
    LOAD_COLUMNS.reference.header,
  ],
  supplierPayments: [
    LOAD_COLUMNS.supplierRuc.header,
    LOAD_COLUMNS.purchaseDocument.header,
    LOAD_COLUMNS.date.header,
    LOAD_COLUMNS.amount.header,
    LOAD_COLUMNS.method.header,
    LOAD_COLUMNS.reference.header,
  ],
};

/** El orden de carga (decisión del dueño del 2026-10-20). */
export const LOAD_ORDER = [
  'Compras: alta y recepción, con su fecha',
  'Ventas: importar las cotizaciones y confirmar los pedidos',
  'Producción: partes y cierres de OP, con su fecha',
  'Despachos, con su fecha',
  'Comprobantes manuales, con la serie, el número y la fecha del otro sistema',
  'Cobros y pagos',
] as const;

/** Días hacia atrás que acepta la emisión de un comprobante (D-072/D-210). */
export const ISSUE_WINDOW_DAYS = 90;
/** Desde cuántos días antes del límite se avisa. */
const ISSUE_WINDOW_WARN_DAYS = 15;

export type Sheets = Record<keyof typeof LOAD_SHEETS, Record<string, unknown>[]>;

/** Un ítem del kardex como lo nombra el plan: SKU de producto o código de bobina. */
export interface LoadItem {
  key: string;
  kind: 'PRODUCT' | 'COIL';
  label: string;
}

/** Lo que la base sabe de los ítems que el plan nombra (lo arma la CLI con una lectura). */
export interface LoadContext {
  /** Fecha de la carga (hoy en Lima, o la que se simule). */
  loadDate: string;
  /** Inicio de la carga histórica (`HISTORICAL_LOAD_START`). */
  historicalFloor: string;
  /** Kardex actual en cantidades por ítem (`qtyRowsOf`); un ítem que no está no tiene filas. */
  kardex: ReadonlyMap<string, readonly QtyRow[]>;
  /** SKU de productos que existen. */
  products: ReadonlySet<string>;
  /** Códigos de bobina que existen. */
  coils: ReadonlySet<string>;
}

export interface LoadIssue {
  sheet: string;
  row: number | null;
  message: string;
}

export interface LoadRecost {
  sheet: string;
  row: number;
  item: string;
  date: string;
  /** Filas del ítem posteriores al movimiento (y de lo fabricado con él, si es una bobina). */
  rowsAfter: number;
  overLimit: boolean;
}

export interface LoadReview {
  loadDate: string;
  order: readonly string[];
  counts: Record<keyof typeof LOAD_SHEETS, number>;
  errors: LoadIssue[];
  warnings: LoadIssue[];
  recosts: LoadRecost[];
  /** Movimientos de kardex que la carga escribiría y cuántos se rechazarían por D-652. */
  movements: { planned: number; rejected: number };
  /** El comprobante más antiguo y la última fecha en que todavía se puede registrar. */
  oldestIssue: { document: string; issueDate: string; lastLoadDate: string } | null;
}

interface Movement {
  sheet: string;
  row: number;
  itemKey: string;
  date: string;
  qty: Decimal;
  type: 'IN' | 'OUT';
  /** Una salida de bobina para producir: lo producido recostea en cascada. */
  producesKey?: string;
}

const ZERO = new Decimal(0);

export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function rowNumber(i: number): number {
  return i + 2;
}

function cell(raw: Record<string, unknown>, header: string, required = true): string {
  return getField(raw, { key: header, header, required });
}

function amountOf(text: string): Decimal | null {
  const clean = text.replaceAll(/s\/\.?|\s/gi, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(clean)) return null;
  return toDecimal(clean);
}

/**
 * La revisión. Pura: el kardex actual y lo que existe llegan en `ctx`; los movimientos del plan se
 * simulan en el orden de carga, cada uno grabado «hoy» con su fecha de operación (al final de su
 * día, como lo graba el kardex), y una salida que dejaría negativo se rechaza y no entra.
 */
export function reviewBackdatedLoad(sheets: Sheets, ctx: LoadContext): LoadReview {
  const errors: LoadIssue[] = [];
  const warnings: LoadIssue[] = [];
  const recosts: LoadRecost[] = [];
  const err = (sheet: string, row: number | null, message: string) =>
    errors.push({ sheet, row, message });
  const warn = (sheet: string, row: number | null, message: string) =>
    warnings.push({ sheet, row, message });

  const dateOf = (sheet: string, row: number, raw: string, label: string): string | null => {
    const date = parseCalendarDate(raw);
    if (!date) {
      err(sheet, row, `${label} inválida: «${raw}»`);
      return null;
    }
    if (date > ctx.loadDate) {
      err(sheet, row, `${label} ${date} es posterior a la fecha de carga (${ctx.loadDate})`);
      return null;
    }
    if (date < ctx.historicalFloor) {
      err(
        sheet,
        row,
        `${label} ${date} es anterior al inicio de la carga histórica (${ctx.historicalFloor})`,
      );
      return null;
    }
    return date;
  };
  const qtyOf = (sheet: string, row: number, raw: string, label: string): Decimal | null => {
    const q = amountOf(raw);
    if (!q || q.lte(0)) {
      err(sheet, row, `${label} inválida: «${raw}» (tiene que ser mayor que cero)`);
      return null;
    }
    return q;
  };

  const movements: Movement[] = [];
  const newCoils = new Map<string, string>();

  // 1. Compras: cada línea recibida es una entrada de su ítem en la fecha de recepción.
  const purchaseDocs = new Map<string, string>();
  sheets.purchases.forEach((raw, i) => {
    const sheet = LOAD_SHEETS.purchases;
    const row = rowNumber(i);
    const doc = `${rawToString(cell(raw, PURCHASE_IMPORT_COLUMNS.supplierRuc.header))} · ${cell(raw, PURCHASE_IMPORT_COLUMNS.document.header)}`;
    const issue = dateOf(
      sheet,
      row,
      cell(raw, PURCHASE_IMPORT_COLUMNS.issueDate.header),
      'La fecha de emisión',
    );
    const received = dateOf(
      sheet,
      row,
      cell(raw, LOAD_COLUMNS.receivedDate.header),
      'La fecha de recepción',
    );
    if (!issue || !received) return;
    if (received < issue) err(sheet, row, `recepción ${received} anterior a la emisión ${issue}`);
    purchaseDocs.set(doc, issue);
    const sku = cell(raw, PURCHASE_IMPORT_COLUMNS.sku.header, false);
    const external = cell(raw, PURCHASE_IMPORT_COLUMNS.externalCode.header, false);
    const kg = cell(raw, PURCHASE_IMPORT_COLUMNS.kg.header, false);
    if (kg !== '' && external !== '') {
      // Una bobina nueva: la nombra su código externo dentro del plan.
      const q = qtyOf(sheet, row, kg, 'KG');
      if (!q) return;
      if (ctx.coils.has(external) || newCoils.has(external)) {
        err(sheet, row, `la bobina ${external} ya existe`);
        return;
      }
      newCoils.set(external, received);
      movements.push({
        sheet,
        row,
        itemKey: `COIL:${external}`,
        date: received,
        qty: q,
        type: 'IN',
      });
      return;
    }
    if (sku === '') {
      // Un servicio o un flete no mueve stock.
      return;
    }
    if (!ctx.products.has(sku)) {
      err(sheet, row, `el SKU ${sku} no existe en el catálogo`);
      return;
    }
    const q = qtyOf(
      sheet,
      row,
      cell(raw, PURCHASE_IMPORT_COLUMNS.qty.header, false),
      'La cantidad',
    );
    if (!q) return;
    movements.push({ sheet, row, itemKey: `PRODUCT:${sku}`, date: received, qty: q, type: 'IN' });
  });

  // 2. Ventas: no mueven stock; dan los comprobantes, sus cantidades por SKU y sus totales.
  const sales = new Map<
    string,
    { issueDate: string; total: Decimal; qtyBySku: Map<string, Decimal> }
  >();
  sheets.sales.forEach((raw, i) => {
    const sheet = LOAD_SHEETS.sales;
    const row = rowNumber(i);
    const doc = cell(raw, QUOTATION_IMPORT_COLUMNS.documentKey);
    const issue = dateOf(
      sheet,
      row,
      cell(raw, QUOTATION_IMPORT_COLUMNS.issueDate),
      'La fecha de emisión',
    );
    if (!issue || doc === '') {
      if (doc === '') err(sheet, row, 'falta la serie y el número del comprobante');
      return;
    }
    const sku = cell(raw, QUOTATION_IMPORT_COLUMNS.sku);
    if (!ctx.products.has(sku)) err(sheet, row, `el SKU ${sku} no existe en el catálogo`);
    const q = qtyOf(sheet, row, cell(raw, QUOTATION_IMPORT_COLUMNS.qty), 'La cantidad') ?? ZERO;
    const net = amountOf(cell(raw, QUOTATION_IMPORT_COLUMNS.netAmount)) ?? ZERO;
    const totalCell = amountOf(cell(raw, QUOTATION_IMPORT_COLUMNS.totalAmount, false));
    const total = totalCell ?? net.times('1.18');
    const sale = sales.get(doc) ?? {
      issueDate: issue,
      total: ZERO,
      qtyBySku: new Map<string, Decimal>(),
    };
    if (sale.issueDate !== issue) err(sheet, row, `${doc} tiene dos fechas de emisión`);
    sale.total = sale.total.plus(total);
    sale.qtyBySku.set(sku, (sale.qtyBySku.get(sku) ?? ZERO).plus(q));
    sales.set(doc, sale);
  });
  let oldest: LoadReview['oldestIssue'] = null;
  for (const [doc, sale] of sales) {
    const last = addDaysIso(sale.issueDate, ISSUE_WINDOW_DAYS);
    if (!oldest || sale.issueDate < oldest.issueDate) {
      oldest = { document: doc, issueDate: sale.issueDate, lastLoadDate: last };
    }
    if (ctx.loadDate > last) {
      err(
        LOAD_SHEETS.sales,
        null,
        `${doc} (emitido el ${sale.issueDate}) ya no se puede registrar: la emisión acepta hasta 90 días atrás (último día: ${last})`,
      );
    } else if (ctx.loadDate > addDaysIso(last, -ISSUE_WINDOW_WARN_DAYS)) {
      warn(
        LOAD_SHEETS.sales,
        null,
        `${doc} (emitido el ${sale.issueDate}) se puede registrar solo hasta el ${last}`,
      );
    }
  }

  // 3. Producción: la bobina sale (si se indica) y el producto entra, en la fecha del parte.
  const producedBySale = new Map<string, Decimal>();
  sheets.production.forEach((raw, i) => {
    const sheet = LOAD_SHEETS.production;
    const row = rowNumber(i);
    const doc = cell(raw, LOAD_COLUMNS.saleDocument.header);
    const date = dateOf(sheet, row, cell(raw, LOAD_COLUMNS.date.header), 'La fecha del parte');
    const sku = cell(raw, LOAD_COLUMNS.sku.header);
    const q = qtyOf(sheet, row, cell(raw, LOAD_COLUMNS.qty.header), 'La cantidad');
    if (!date || !q) return;
    const sale = sales.get(doc);
    if (!sale) err(sheet, row, `${doc} no está en la hoja de ventas`);
    else if (!sale.qtyBySku.has(sku)) err(sheet, row, `${doc} no vende ${sku}`);
    if (!ctx.products.has(sku)) {
      err(sheet, row, `el SKU ${sku} no existe en el catálogo`);
      return;
    }
    const coil = cell(raw, LOAD_COLUMNS.coil.header, false);
    if (coil !== '') {
      const kg = qtyOf(
        sheet,
        row,
        cell(raw, LOAD_COLUMNS.coilKg.header, false),
        'Los kg consumidos',
      );
      if (!kg) return;
      if (!ctx.coils.has(coil) && !newCoils.has(coil)) {
        err(sheet, row, `la bobina ${coil} no existe ni entra en la hoja de compras`);
        return;
      }
      movements.push({
        sheet,
        row,
        itemKey: `COIL:${coil}`,
        date,
        qty: kg,
        type: 'OUT',
        producesKey: `PRODUCT:${sku}`,
      });
    }
    movements.push({ sheet, row, itemKey: `PRODUCT:${sku}`, date, qty: q, type: 'IN' });
    producedBySale.set(`${doc}|${sku}`, (producedBySale.get(`${doc}|${sku}`) ?? ZERO).plus(q));
  });

  // 4. Despachos: salidas del producto en su fecha, contra lo vendido.
  const dispatchedBySale = new Map<string, Decimal>();
  sheets.dispatches.forEach((raw, i) => {
    const sheet = LOAD_SHEETS.dispatches;
    const row = rowNumber(i);
    const doc = cell(raw, LOAD_COLUMNS.saleDocument.header);
    const date = dateOf(sheet, row, cell(raw, LOAD_COLUMNS.date.header), 'La fecha del despacho');
    const sku = cell(raw, LOAD_COLUMNS.sku.header);
    const q = qtyOf(sheet, row, cell(raw, LOAD_COLUMNS.qty.header), 'La cantidad');
    if (!date || !q) return;
    const sale = sales.get(doc);
    const sold = sale?.qtyBySku.get(sku);
    if (!sale || !sold) {
      err(sheet, row, `${doc} no vende ${sku} en la hoja de ventas`);
      return;
    }
    const key = `${doc}|${sku}`;
    const total = (dispatchedBySale.get(key) ?? ZERO).plus(q);
    dispatchedBySale.set(key, total);
    if (total.gt(sold))
      err(sheet, row, `${doc} despacha ${total.toFixed(3)} de ${sku} y vendió ${sold.toFixed(3)}`);
    movements.push({ sheet, row, itemKey: `PRODUCT:${sku}`, date, qty: q, type: 'OUT' });
  });

  // 5. Cobros y pagos: fechas y montos contra su comprobante.
  const collected = new Map<string, Decimal>();
  sheets.collections.forEach((raw, i) => {
    const sheet = LOAD_SHEETS.collections;
    const row = rowNumber(i);
    const doc = cell(raw, LOAD_COLUMNS.saleDocument.header);
    const date = dateOf(sheet, row, cell(raw, LOAD_COLUMNS.date.header), 'La fecha del cobro');
    const amount = qtyOf(sheet, row, cell(raw, LOAD_COLUMNS.amount.header), 'El monto');
    if (!date || !amount) return;
    const sale = sales.get(doc);
    if (!sale) {
      err(sheet, row, `${doc} no está en la hoja de ventas`);
      return;
    }
    if (date < sale.issueDate)
      warn(sheet, row, `el cobro del ${date} es anterior a la emisión (${sale.issueDate})`);
    const sum = (collected.get(doc) ?? ZERO).plus(amount);
    collected.set(doc, sum);
    if (sum.gt(sale.total.toDecimalPlaces(2, Decimal.ROUND_CEIL))) {
      err(sheet, row, `${doc} cobra ${sum.toFixed(2)} y su total es ${sale.total.toFixed(2)}`);
    }
  });
  sheets.supplierPayments.forEach((raw, i) => {
    const sheet = LOAD_SHEETS.supplierPayments;
    const row = rowNumber(i);
    const doc = `${rawToString(cell(raw, LOAD_COLUMNS.supplierRuc.header))} · ${cell(raw, LOAD_COLUMNS.purchaseDocument.header)}`;
    const date = dateOf(sheet, row, cell(raw, LOAD_COLUMNS.date.header), 'La fecha del pago');
    if (!date || !qtyOf(sheet, row, cell(raw, LOAD_COLUMNS.amount.header), 'El monto')) return;
    const issue = purchaseDocs.get(doc);
    if (issue && date < issue)
      warn(sheet, row, `el pago del ${date} es anterior a la emisión de la compra (${issue})`);
  });

  // La simulación del kardex, en el orden de carga (compras, producción, despachos). Cada fila
  // nueva va al final de su día, como la graba el kardex.
  const rows = new Map<string, QtyRow[]>();
  const rowsOf = (key: string): QtyRow[] => {
    let r = rows.get(key);
    if (!r) {
      r = [...(ctx.kardex.get(key) ?? [])];
      rows.set(key, r);
    }
    return r;
  };
  const insertAt = (list: QtyRow[], date: string): number => {
    const at = list.findIndex((r) => r.date > date);
    return at === -1 ? list.length : at;
  };
  let rejected = 0;
  for (const m of movements) {
    const list = rowsOf(m.itemKey);
    const at = insertAt(list, m.date);
    let rowsAfter = list.length - at;
    if (m.producesKey) {
      const produced = rowsOf(m.producesKey);
      rowsAfter += produced.length - insertAt(produced, m.date);
    }
    if (m.type === 'OUT') {
      const negative = firstNegativeDate(list, [{ date: m.date, qty: m.qty }]);
      if (negative !== null) {
        const valid = firstValidDate(list, m.date, m.qty, ctx.loadDate);
        err(
          m.sheet,
          m.row,
          `${labelOf(m.itemKey)}: sacar ${m.qty.toFixed(3)} el ${m.date} deja el kardex en negativo el ${negative} (D-652)` +
            (valid
              ? `; la primera fecha válida es ${valid}`
              : '; no alcanza ni a la fecha de carga'),
        );
        rejected += 1;
        continue;
      }
    }
    if (rowsAfter > 0) {
      recosts.push({
        sheet: m.sheet,
        row: m.row,
        item: labelOf(m.itemKey),
        date: m.date,
        rowsAfter,
        overLimit: rowsAfter > RECOST_MAX_ROWS,
      });
    }
    list.splice(at, 0, { date: m.date, delta: m.type === 'IN' ? m.qty : m.qty.negated() });
  }
  for (const r of recosts.filter((x) => x.overLimit)) {
    warn(
      r.sheet,
      r.row,
      `${r.item}: el movimiento del ${r.date} recostearía ${String(r.rowsAfter)} filas, más que el tope (${String(RECOST_MAX_ROWS)}); quedará pendiente para pnpm recosteo:pendientes`,
    );
  }

  return {
    loadDate: ctx.loadDate,
    order: LOAD_ORDER,
    counts: {
      purchases: sheets.purchases.length,
      sales: sales.size,
      production: sheets.production.length,
      dispatches: sheets.dispatches.length,
      collections: sheets.collections.length,
      supplierPayments: sheets.supplierPayments.length,
    },
    errors,
    warnings,
    recosts,
    movements: { planned: movements.length, rejected },
    oldestIssue: oldest,
  };
}

function labelOf(key: string): string {
  const [kind, code] = key.split(':');
  return kind === 'COIL' ? `bobina ${code ?? ''}` : (code ?? key);
}
