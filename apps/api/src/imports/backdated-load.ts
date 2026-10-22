import {
  Decimal,
  IGV_RATE_PCT,
  MAX_BACKDATED_ISSUE_DAYS,
  PURCHASE_IMPORT_COLUMNS,
  purchaseTypeOf,
  QUOTATION_IMPORT_COLUMNS,
} from '@ayr/shared';
import { parseAmount, parseMethod } from './opening-balances-plan';
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
  // cc64 (D-705): columnas opcionales, al final de su hoja; un archivo sin ellas sigue valiendo.
  lengths: { key: 'lengths', header: 'LARGOS', required: false },
  paymentTerms: { key: 'paymentTerms', header: 'CONDICIÓN DE PAGO', required: false },
  dueDate: { key: 'dueDate', header: 'VENCIMIENTO', required: false },
  mode: { key: 'mode', header: 'MODALIDAD', required: false },
  destination: { key: 'destination', header: 'DIRECCIÓN DESTINO', required: false },
  ubigeo: { key: 'ubigeo', header: 'UBIGEO', required: false },
} as const;

/** cc64 (D-705): lo que el plan necesita saber de un producto del catálogo. */
export interface LoadProductInfo {
  /** Línea de drywall: su producción se carga a mano (D-705). */
  drywall: boolean;
  /** La línea lleva desglose de largos (`detailsLengths`, regla 13). */
  needsLengths: boolean;
}

/**
 * cc64 (D-705): `LARGOS` de una línea a medida, en metros por cantidad de piezas:
 * `4.5x10; 3x8` (también `4,5 x 10`). Devuelve los tramos en mm, o `null` si no se entiende.
 */
export function parseLengths(text: string): { lengthMm: Decimal; qty: number }[] | null {
  const parts = text
    .split(/[;\n]/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 0) return null;
  const out: { lengthMm: Decimal; qty: number }[] = [];
  for (const part of parts) {
    const match = /^(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+)$/i.exec(part);
    if (!match?.[1] || !match[2]) return null;
    const meters = new Decimal(match[1].replace(',', '.'));
    const qty = Number(match[2]);
    if (meters.lte(0) || qty <= 0) return null;
    out.push({ lengthMm: meters.times(1000).toDecimalPlaces(2), qty });
  }
  return out;
}

/** Los metros que suman unos tramos. */
export function metersOf(pieces: readonly { lengthMm: Decimal; qty: number }[]): Decimal {
  return pieces.reduce((acc, p) => acc.plus(p.lengthMm.times(p.qty).div(1000)), new Decimal(0));
}

/** cc64 (D-705): la modalidad del despacho. Vacía → recojo, con aviso. */
export function dispatchModeOf(text: string): 'PICKUP' | 'DELIVERY' | null {
  const t = text.trim().toUpperCase().normalize('NFD').replaceAll(/[̀-ͯ]/g, '');
  if (t === '' || t === 'RECOJO') return 'PICKUP';
  if (t === 'ENTREGA') return 'DELIVERY';
  return null;
}

/** cc64 (D-705): la condición de pago. Vacía → `null` (el plazo del cliente). */
export function paymentTermsOf(text: string): 'CONTADO' | 'CREDITO' | 'INVALID' | null {
  const t = text.trim().toUpperCase().normalize('NFD').replaceAll(/[̀-ͯ]/g, '');
  if (t === '') return null;
  if (t === 'CONTADO') return 'CONTADO';
  if (t === 'CREDITO') return 'CREDITO';
  return 'INVALID';
}

/** Encabezados de cada hoja, en el orden en que la plantilla los escribe. */
export const LOAD_SHEET_HEADERS: Record<keyof typeof LOAD_SHEETS, string[]> = {
  purchases: [
    ...Object.values(PURCHASE_IMPORT_COLUMNS).map((c) => c.header),
    LOAD_COLUMNS.receivedDate.header,
  ],
  sales: [
    ...Object.values(QUOTATION_IMPORT_COLUMNS),
    LOAD_COLUMNS.lengths.header,
    LOAD_COLUMNS.paymentTerms.header,
    LOAD_COLUMNS.dueDate.header,
  ],
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
    LOAD_COLUMNS.mode.header,
    LOAD_COLUMNS.destination.header,
    LOAD_COLUMNS.ubigeo.header,
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
export const ISSUE_WINDOW_DAYS = MAX_BACKDATED_ISSUE_DAYS;
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
  /** cc64 (D-705): lo que se sabe de cada SKU que existe (drywall, largos). Sin él, nada se marca. */
  productInfo?: ReadonlyMap<string, LoadProductInfo>;
  /** cc64: documentos (RUC o DNI) de clientes que existen. Sin él, no se avisa de clientes nuevos. */
  customers?: ReadonlySet<string>;
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
  /**
   * cc65: los clientes que no existen y se darán de alta desde el padrón al cargar, con su RUC o
   * DNI, el nombre que trae el export y las filas de la hoja Ventas donde aparecen.
   */
  newCustomers: { document: string; name: string; rows: number[] }[];
}

interface Movement {
  sheet: string;
  row: number;
  itemKey: string;
  date: string;
  qty: Decimal;
  type: 'IN' | 'OUT';
  /** cc64: el paso del orden de carga (1 compras, 3 producción, 4 despachos). */
  step: number;
  /** Una salida de bobina para producir: lo producido recostea en cascada. */
  producesKey?: string;
  /** cc64: la OP del parte (venta y SKU), lo que vendió y la bobina que lo alimenta. */
  opKey?: string;
  opTarget?: Decimal;
  coilKey?: string;
  /**
   * Revisión de cc63 (H-1): el parte es una sola operación. Si la salida de la bobina se rechaza,
   * la entrada del producto tampoco entra (en el sistema real el parte falla entero).
   */
  part?: number;
}

const ZERO = new Decimal(0);

export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function rowNumber(i: number, raw?: Record<string, unknown>): number {
  const n = (raw as { __rowNum__?: unknown } | undefined)?.__rowNum__;
  return typeof n === 'number' ? n + 1 : i + 2;
}

function cell(raw: Record<string, unknown>, header: string, required = true): string {
  return getField(raw, { key: header, header, required });
}

/** El monto de una celda, con los separadores que trae un Excel (`1.234,50`, `1,234.50`, `S/ 10`). */
function amountOf(text: string): Decimal | null {
  return parseAmount(text);
}

const IGV_FACTOR = new Decimal(IGV_RATE_PCT).div(100).plus(1);

/**
 * La revisión. Pura: el kardex actual y lo que existe llegan en `ctx`; los movimientos del plan se
 * simulan en el orden de carga, cada uno grabado «hoy» con su fecha de operación (al final de su
 * día, como lo graba el kardex), y una salida que dejaría negativo se rechaza y no entra.
 */
export function reviewBackdatedLoad(sheets: Sheets, ctx: LoadContext): LoadReview {
  const errors: LoadIssue[] = [];
  const warnings: LoadIssue[] = [];
  const newCustomers = new Map<string, { document: string; name: string; rows: number[] }>();
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
    const row = rowNumber(i, raw);
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
    // Autorrevisión de cc63: una bobina se reconoce por el tipo de compra, como el importador.
    const isCoil = purchaseTypeOf(cell(raw, PURCHASE_IMPORT_COLUMNS.type.header, false)) === 'COIL';
    if (isCoil && external === '') {
      warn(
        sheet,
        row,
        'bobina sin CÓDIGO EXTERNO: entra, pero la hoja de producción no la puede nombrar ni se revisa su consumo',
      );
      return;
    }
    if (isCoil || (kg !== '' && external !== '')) {
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
        step: 1,
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
    movements.push({
      sheet,
      row,
      itemKey: `PRODUCT:${sku}`,
      date: received,
      qty: q,
      type: 'IN',
      step: 1,
    });
  });

  // 2. Ventas: no mueven stock; dan los comprobantes, sus cantidades por SKU y sus totales.
  const foreignSales = new Set<string>();
  const sales = new Map<
    string,
    { issueDate: string; total: Decimal; qtyBySku: Map<string, Decimal> }
  >();
  sheets.sales.forEach((raw, i) => {
    const sheet = LOAD_SHEETS.sales;
    const row = rowNumber(i, raw);
    const doc = cell(raw, QUOTATION_IMPORT_COLUMNS.documentKey);
    // Autorrevisión de cc63: el importador de cotizaciones salta las notas de crédito del export
    // (D-152); la revisión también.
    const docType = cell(raw, QUOTATION_IMPORT_COLUMNS.docType, false).toLowerCase();
    if (docType.includes('nota') || cell(raw, QUOTATION_IMPORT_COLUMNS.adjustedDocument, false)) {
      warn(sheet, row, `${doc} es una nota de crédito: no entra como venta (se registra aparte)`);
      return;
    }
    const currency = cell(raw, QUOTATION_IMPORT_COLUMNS.currency, false).toUpperCase();
    if (currency !== '' && currency !== 'PEN' && currency !== 'SOLES') foreignSales.add(doc);
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
    const customerText = cell(raw, QUOTATION_IMPORT_COLUMNS.customer);
    const customerMatch = /^(\d{8,11})\s*-\s*(.*)$/.exec(customerText);
    const customerDoc = customerMatch?.[1];
    if (ctx.customers && !sales.has(doc)) {
      if (!customerDoc) {
        err(
          sheet,
          row,
          `CLIENTE sin RUC o DNI al inicio: «${cell(raw, QUOTATION_IMPORT_COLUMNS.customer)}»`,
        );
      } else if (!ctx.customers.has(customerDoc)) {
        warn(
          sheet,
          row,
          `el cliente ${customerDoc} no está en el maestro: se dará de alta desde el padrón al cargar (consulta externa)`,
        );
        const seen = newCustomers.get(customerDoc) ?? {
          document: customerDoc,
          name: customerMatch?.[2]?.trim() ?? '',
          rows: [],
        };
        seen.rows.push(row);
        newCustomers.set(customerDoc, seen);
      }
    }
    const q = qtyOf(sheet, row, cell(raw, QUOTATION_IMPORT_COLUMNS.qty), 'La cantidad') ?? ZERO;
    const netCell = amountOf(cell(raw, QUOTATION_IMPORT_COLUMNS.netAmount));
    if (netCell === null)
      err(
        sheet,
        row,
        `valor de venta inválido: «${cell(raw, QUOTATION_IMPORT_COLUMNS.netAmount)}»`,
      );
    const net = netCell ?? ZERO;
    const totalCell = amountOf(cell(raw, QUOTATION_IMPORT_COLUMNS.totalAmount, false));
    const total = totalCell ?? net.times(IGV_FACTOR);
    // cc64 (D-705): una línea a medida trae su plan de corte en LARGOS, que suma la cantidad.
    const lengthsText = cell(raw, LOAD_COLUMNS.lengths.header, false);
    if (ctx.productInfo?.get(sku)?.needsLengths) {
      const pieces = parseLengths(lengthsText);
      if (lengthsText === '') {
        err(
          sheet,
          row,
          `${sku} es a medida: falta LARGOS (por ejemplo «4.5x10; 3x8», metros x piezas)`,
        );
      } else if (!pieces) {
        err(
          sheet,
          row,
          `LARGOS inválidos: «${lengthsText}» (usa metros x piezas, separados por «;»)`,
        );
      } else if (!metersOf(pieces).eq(q)) {
        err(
          sheet,
          row,
          `LARGOS suman ${metersOf(pieces).toFixed(3)} m y la cantidad es ${q.toFixed(3)}`,
        );
      }
    } else if (lengthsText !== '') {
      warn(sheet, row, `${sku} no lleva largos: la columna LARGOS se ignora`);
    }
    const terms = paymentTermsOf(cell(raw, LOAD_COLUMNS.paymentTerms.header, false));
    const dueText = cell(raw, LOAD_COLUMNS.dueDate.header, false);
    if (terms === 'INVALID') {
      err(
        sheet,
        row,
        `CONDICIÓN DE PAGO inválida: «${cell(raw, LOAD_COLUMNS.paymentTerms.header, false)}» (CONTADO o CRÉDITO)`,
      );
    } else if (terms === 'CONTADO' && dueText !== '') {
      err(sheet, row, 'una venta al contado no lleva VENCIMIENTO');
    }
    if (dueText !== '') {
      const due = parseCalendarDate(dueText);
      if (!due) err(sheet, row, `VENCIMIENTO inválido: «${dueText}»`);
      else if (due < issue)
        err(sheet, row, `el vencimiento ${due} es anterior a la emisión ${issue}`);
    }
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
    const row = rowNumber(i, raw);
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
    // cc64 (D-705): la producción de drywall sale de flejes de un corte que el plan no trae.
    if (ctx.productInfo?.get(sku)?.drywall) {
      warn(sheet, row, `${sku} es de drywall: este parte se carga a mano (no se ejecuta)`);
      // Lo que produce sí entra a la simulación: sin él, su despacho daría un negativo falso. El
      // consumo de flejes no se simula (sale de un corte que el plan no trae).
      movements.push({
        sheet,
        row,
        itemKey: `PRODUCT:${sku}`,
        date,
        qty: q,
        type: 'IN',
        step: 3,
        part: i,
      });
      producedBySale.set(`${doc}|${sku}`, (producedBySale.get(`${doc}|${sku}`) ?? ZERO).plus(q));
      return;
    }
    const coil = cell(raw, LOAD_COLUMNS.coil.header, false);
    if (coil === '') {
      warn(sheet, row, 'sin CÓDIGO BOBINA: la OP tiene que tener ya una bobina montada');
    }
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
        step: 3,
        producesKey: `PRODUCT:${sku}`,
        opKey: `${doc}|${sku}`,
        part: i,
      });
    }
    movements.push({
      sheet,
      row,
      itemKey: `PRODUCT:${sku}`,
      date,
      qty: q,
      type: 'IN',
      step: 3,
      part: i,
      opKey: `${doc}|${sku}`,
      opTarget: sale?.qtyBySku.get(sku),
      ...(coil === '' ? {} : { coilKey: `COIL:${coil}` }),
    });
    producedBySale.set(`${doc}|${sku}`, (producedBySale.get(`${doc}|${sku}`) ?? ZERO).plus(q));
  });

  // Revisión de cc63 (H-2): lo producido para una venta no pasa de lo que vendió de ese SKU.
  for (const [key, made] of producedBySale) {
    const [doc, sku] = key.split('|') as [string, string];
    const sold = sales.get(doc)?.qtyBySku.get(sku);
    if (sold && made.gt(sold)) {
      err(
        LOAD_SHEETS.production,
        null,
        `${doc} produce ${made.toFixed(3)} de ${sku} y vendió ${sold.toFixed(3)}`,
      );
    }
  }

  // 4. Despachos: salidas del producto en su fecha, contra lo vendido.
  const dispatchedBySale = new Map<string, Decimal>();
  sheets.dispatches.forEach((raw, i) => {
    const sheet = LOAD_SHEETS.dispatches;
    const row = rowNumber(i, raw);
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
    // cc64 (D-705): sin modalidad se carga como recojo, y se avisa para corregirlo antes.
    const modeText = cell(raw, LOAD_COLUMNS.mode.header, false);
    const mode = dispatchModeOf(modeText);
    if (mode === null) {
      err(sheet, row, `MODALIDAD inválida: «${modeText}» (RECOJO o ENTREGA)`);
    } else if (modeText.trim() === '') {
      warn(sheet, row, 'sin MODALIDAD: se cargará como recojo');
    } else if (mode === 'DELIVERY') {
      if (cell(raw, LOAD_COLUMNS.destination.header, false) === '') {
        err(sheet, row, 'una entrega exige DIRECCIÓN DESTINO');
      }
      if (!/^\d{6}$/.test(cell(raw, LOAD_COLUMNS.ubigeo.header, false))) {
        err(sheet, row, 'una entrega exige UBIGEO de 6 dígitos');
      }
    }
    const key = `${doc}|${sku}`;
    const total = (dispatchedBySale.get(key) ?? ZERO).plus(q);
    dispatchedBySale.set(key, total);
    if (total.gt(sold))
      err(sheet, row, `${doc} despacha ${total.toFixed(3)} de ${sku} y vendió ${sold.toFixed(3)}`);
    movements.push({ sheet, row, itemKey: `PRODUCT:${sku}`, date, qty: q, type: 'OUT', step: 4 });
  });

  // Autorrevisión de cc64 (P3-17): un medio que no se entiende se carga como «Otro»; se avisa.
  const unknownMethod = (sheet: string, row: number, text: string) => {
    if (text.trim() !== '' && parseMethod(text) === null) {
      warn(sheet, row, `MEDIO DE PAGO desconocido: «${text.trim()}»; se registra como «Otro»`);
    }
  };

  // 5. Cobros y pagos: fechas y montos contra su comprobante.
  const collected = new Map<string, Decimal>();
  sheets.collections.forEach((raw, i) => {
    const sheet = LOAD_SHEETS.collections;
    const row = rowNumber(i, raw);
    const doc = cell(raw, LOAD_COLUMNS.saleDocument.header);
    const date = dateOf(sheet, row, cell(raw, LOAD_COLUMNS.date.header), 'La fecha del cobro');
    const amount = qtyOf(sheet, row, cell(raw, LOAD_COLUMNS.amount.header), 'El monto');
    if (!date || !amount) return;
    unknownMethod(sheet, row, cell(raw, LOAD_COLUMNS.method.header, false));
    const sale = sales.get(doc);
    if (!sale) {
      err(sheet, row, `${doc} no está en la hoja de ventas`);
      return;
    }
    if (date < sale.issueDate)
      warn(sheet, row, `el cobro del ${date} es anterior a la emisión (${sale.issueDate})`);
    const sum = (collected.get(doc) ?? ZERO).plus(amount);
    collected.set(doc, sum);
    // Una venta en otra moneda: el cobro va en su moneda y la revisión no la convierte.
    if (!foreignSales.has(doc) && sum.gt(sale.total.toDecimalPlaces(2, Decimal.ROUND_CEIL))) {
      err(sheet, row, `${doc} cobra ${sum.toFixed(2)} y su total es ${sale.total.toFixed(2)}`);
    }
  });
  sheets.supplierPayments.forEach((raw, i) => {
    const sheet = LOAD_SHEETS.supplierPayments;
    const row = rowNumber(i, raw);
    const doc = `${rawToString(cell(raw, LOAD_COLUMNS.supplierRuc.header))} · ${cell(raw, LOAD_COLUMNS.purchaseDocument.header)}`;
    const date = dateOf(sheet, row, cell(raw, LOAD_COLUMNS.date.header), 'La fecha del pago');
    if (!date || !qtyOf(sheet, row, cell(raw, LOAD_COLUMNS.amount.header), 'El monto')) return;
    unknownMethod(sheet, row, cell(raw, LOAD_COLUMNS.method.header, false));
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
  const failedParts = new Set<number>();
  // cc64: una bobina que ya alimentó un parte de una OP solo se baja de ella cuando la OP se
  // cierra (`releaseCoil` rechaza con kilos consumidos). Mientras la OP de una venta y un SKU no
  // complete lo vendido, su bobina no puede alimentar otra OP.
  const coilHolder = new Map<string, string>();
  const madeByOp = new Map<string, Decimal>();
  // cc64: el cargador carga cada paso de la fecha más antigua a la más nueva; la revisión, igual.
  const ordered = movements
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.step - b.m.step || a.m.date.localeCompare(b.m.date) || a.i - b.i)
    .map((x) => x.m);
  for (const m of ordered) {
    if (m.part !== undefined && failedParts.has(m.part)) continue;
    if (m.opKey !== undefined && m.producesKey !== undefined) {
      const holder = coilHolder.get(m.itemKey);
      if (holder !== undefined && holder !== m.opKey) {
        err(
          m.sheet,
          m.row,
          `${labelOf(m.itemKey)} sigue montada en la OP de ${holder.replace('|', ' · ')}, que no está completa: usa otra bobina o completa esa OP antes del ${m.date}`,
        );
        rejected += 1;
        if (m.part !== undefined) failedParts.add(m.part);
        continue;
      }
    }
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
        if (m.part !== undefined) failedParts.add(m.part);
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
    // La OP de esta venta y este SKU: con su bobina ocupada hasta completar lo vendido.
    if (m.opKey !== undefined && m.type === 'IN' && m.step === 3) {
      const made = (madeByOp.get(m.opKey) ?? ZERO).plus(m.qty);
      madeByOp.set(m.opKey, made);
      const coilKey = m.coilKey;
      if (coilKey !== undefined) {
        if (made.gte(m.opTarget ?? made)) coilHolder.delete(coilKey);
        else coilHolder.set(coilKey, m.opKey);
      }
    }
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
    newCustomers: [...newCustomers.values()],
  };
}

function labelOf(key: string): string {
  const [kind, code] = key.split(':');
  return kind === 'COIL' ? `bobina ${code ?? ''}` : (code ?? key);
}
