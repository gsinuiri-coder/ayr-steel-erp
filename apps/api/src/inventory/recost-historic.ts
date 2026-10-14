import { Decimal, toFixedString } from '@ayr/shared';

/**
 * cc53 (D-651) — la **vista previa** de la corrección histórica (`pnpm recosteo:historico`).
 * Funciones puras: la CLI mide antes y después (dentro de la misma transacción) y estas arman las
 * tablas. Nada de esto escribe.
 */

export interface HistoricAdjust {
  /** SKU o código de bobina. */
  item: string;
  /** `YYYY-MM-DD` de la fila corregida. */
  operationDate: string;
  type: 'IN' | 'OUT' | 'ADJUST';
  refType: string;
  /** Diferencia en costo de fila (una salida que cuesta más: positiva). */
  delta: Decimal;
}

export interface MonthDelta {
  item: string;
  month: string;
  /** Costo de venta (salidas por despacho y sus anulaciones/devoluciones), recalculado − registrado. */
  costOfSales: Decimal;
  /** Lo demás (consumos de producción, mermas, entradas derivadas), en valor del saldo. */
  other: Decimal;
  rows: number;
}

const ZERO = new Decimal(0);
const COST_OF_SALES_REFS = new Set(['SALE', 'SALES_RETURN']);

/**
 * Costo de venta por SKU y mes: una salida que cuesta más suma; la anulación o la devolución que
 * vuelve con más valor resta.
 */
export function monthlyDeltas(adjusts: readonly HistoricAdjust[]): MonthDelta[] {
  const map = new Map<string, MonthDelta>();
  for (const a of adjusts) {
    const month = a.operationDate.slice(0, 7);
    const key = `${a.item}|${month}`;
    const row = map.get(key) ?? { item: a.item, month, costOfSales: ZERO, other: ZERO, rows: 0 };
    const signed = a.type === 'OUT' ? a.delta : a.delta.negated();
    if (COST_OF_SALES_REFS.has(a.refType)) row.costOfSales = row.costOfSales.plus(signed);
    else row.other = row.other.plus(signed);
    row.rows += 1;
    map.set(key, row);
  }
  return [...map.values()].sort((x, y) =>
    x.item === y.item ? x.month.localeCompare(y.month) : x.item.localeCompare(y.item),
  );
}

export interface BeforeAfter {
  label: string;
  before: string;
  after: string;
}

export interface DocumentBeforeAfter {
  number: string;
  issueDate: string;
  salesPen: string;
  costBefore: string;
  costAfter: string;
  profitBefore: string;
  profitAfter: string;
  marginBefore: string | null;
  marginAfter: string | null;
}

export interface HistoricPreview {
  branch: string;
  generatedAt: string;
  skus: string[];
  adjustments: number;
  rowsReplayed: number;
  months: MonthDelta[];
  documents: DocumentBeforeAfter[];
  salesMargin: BeforeAfter[];
  inventory: BeforeAfter[];
  /** Filas que un segundo recálculo todavía cambiaría (debe ser 0: el recosteo es idempotente). */
  residual: number;
}

const money = (d: Decimal) => toFixedString(d, 'MONEY');
const two = (s: string) => new Decimal(s).toFixed(2);

/** Diferencia `after − before` de dos importes en texto, a dos decimales. */
export function diff(before: string, after: string): string {
  return new Decimal(after).minus(before).toFixed(2);
}

/** La vista previa en Markdown (va a `local-data/`, fuera del repo). */
export function renderHistoricPreview(p: HistoricPreview): string {
  const lines: string[] = [
    `# cc53 · Recosteo histórico — vista previa (${p.branch})`,
    '',
    `Generada ${p.generatedAt}. SKU: ${p.skus.join(', ')}. Ajustes: ${String(p.adjustments)}; ` +
      `filas recalculadas: ${String(p.rowsReplayed)}; residuo tras recalcular otra vez: ${String(p.residual)}.`,
    '',
    '## Costo de venta por SKU y mes (recalculado − registrado)',
    '',
    '| SKU | Mes | Costo de venta | Otros (valor) | Filas |',
    '|---|---|---:|---:|---:|',
    ...p.months.map(
      (m) =>
        `| ${m.item} | ${m.month} | ${two(money(m.costOfSales))} | ${two(money(m.other))} | ${String(m.rows)} |`,
    ),
    '',
    '## Comprobantes afectados (rentabilidad)',
    '',
    '| Comprobante | Emisión | Venta | Costo antes | Costo después | Utilidad antes | Utilidad después | Margen antes | Margen después |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|',
    ...p.documents.map(
      (d) =>
        `| ${d.number} | ${d.issueDate} | ${two(d.salesPen)} | ${two(d.costBefore)} | ${two(d.costAfter)} | ` +
        `${two(d.profitBefore)} | ${two(d.profitAfter)} | ${d.marginBefore ?? '—'} | ${d.marginAfter ?? '—'} |`,
    ),
    '',
    '## Ventas y margen',
    '',
    '| Cifra | Antes | Después | Diferencia |',
    '|---|---:|---:|---:|',
    ...p.salesMargin.map(
      (r) => `| ${r.label} | ${two(r.before)} | ${two(r.after)} | ${diff(r.before, r.after)} |`,
    ),
    '',
    '## Inventario valorizado',
    '',
    '| Ítem | Antes | Después | Diferencia |',
    '|---|---:|---:|---:|',
    ...p.inventory.map(
      (r) => `| ${r.label} | ${two(r.before)} | ${two(r.after)} | ${diff(r.before, r.after)} |`,
    ),
    '',
  ];
  return lines.join('\n');
}

/**
 * Compara dos vistas previas (la del dry-run y la de la ejecución) al céntimo. Devuelve las
 * diferencias; vacío = coinciden.
 */
export function comparePreviews(expected: HistoricPreview, actual: HistoricPreview): string[] {
  const out: string[] = [];
  const pairs = (p: HistoricPreview) =>
    new Map<string, string>([
      ...p.months.map((m) => [`mes ${m.item} ${m.month}`, two(money(m.costOfSales))] as const),
      ...p.documents.map((d) => [`comprobante ${d.number}`, two(d.costAfter)] as const),
      ...p.salesMargin.map((r) => [`margen ${r.label}`, two(r.after)] as const),
      ...p.inventory.map((r) => [`inventario ${r.label}`, two(r.after)] as const),
    ]);
  const a = pairs(expected);
  const b = pairs(actual);
  for (const [k, v] of a)
    if (b.get(k) !== v) out.push(`${k}: esperado ${v}, quedó ${b.get(k) ?? '—'}`);
  for (const k of b.keys()) if (!a.has(k)) out.push(`${k}: no estaba en la vista previa`);
  if (actual.residual !== 0) out.push(`residuo ${String(actual.residual)} (debe ser 0)`);
  return out;
}
