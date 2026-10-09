import {
  Decimal,
  sellsByFixedLength,
  type ProductDto,
  type ProductStockDto,
  type SellableCoilDto,
} from '@ayr/shared';
import { formatKg, formatQty, isPositiveDecimal, unitSymbol } from '@/lib/format';

/**
 * cc36: lo que una línea del formulario de venta compromete, y el bloque «Material que
 * compromete al confirmar» que lo suma por material.
 *
 * **Solo presentación.** Se calcula con los datos que cada línea ya tiene —sus kilos a reservar y
 * el disponible que trae `GET /sales/stock-panel`— con las mismas cuentas que la celda de materia
 * prima usaba desde D-134/D-171. No decide nada: la comprobación que vale es la del API bajo lock
 * al confirmar.
 */

type ProductForNeed = Pick<ProductDto, 'id' | 'name' | 'roofingKind' | 'unit' | 'lengthMm'>;
type StockForNeed = Pick<
  ProductStockDto,
  | 'availableQty'
  | 'unit'
  | 'carriesInventory'
  | 'kgPerMeter'
  | 'rawMaterialAvailableKg'
  | 'rawMaterialLabel'
>;

export interface NeedInput {
  kind: 'PRODUCT' | 'BOBINA';
  qty: string;
  product?: ProductForNeed | undefined;
  stock?: StockForNeed | undefined;
  coil?: Pick<SellableCoilDto, 'coilId' | 'code'> | undefined;
}

export type LineNeed =
  | { kind: 'service' }
  | { kind: 'stock'; needed: Decimal | null; available: Decimal; unit: string }
  | { kind: 'raw'; needed: Decimal | null; available: Decimal | null; label: string | null }
  | { kind: 'coil'; qty: Decimal | null; code: string | null };

/** Lo que la línea pide y contra qué se compara, o `null` si todavía no hay producto. */
export function lineNeed({ kind, qty, product, stock, coil }: NeedInput): LineNeed | null {
  const typed = isPositiveDecimal(qty) ? new Decimal(qty.trim()) : null;
  if (kind === 'BOBINA') return { kind: 'coil', qty: typed, code: coil?.code ?? null };
  if (!product) return null;
  // D-167: un servicio no lleva existencias; su cero no es «se acabó».
  if (stock?.carriesInventory === false) return { kind: 'service' };
  // D-131/D-171: la rama la decide tener subtipo de cobertura, no la unidad.
  if (product.roofingKind === null) {
    if (!stock) return null;
    return {
      kind: 'stock',
      needed: typed,
      available: new Decimal(stock.availableQty),
      unit: stock.unit,
    };
  }
  // D-171: en una plancha la cantidad son planchas; los metros salen del largo del SKU, con el
  // mismo predicado que usa el API (`orderedMeters`).
  const meters =
    typed === null
      ? null
      : sellsByFixedLength(product) && product.lengthMm !== null
        ? typed.times(product.lengthMm).div(1000)
        : typed;
  const needed =
    stock?.kgPerMeter && meters !== null ? new Decimal(stock.kgPerMeter).times(meters) : null;
  const available =
    stock?.rawMaterialAvailableKg === null || stock?.rawMaterialAvailableKg === undefined
      ? null
      : new Decimal(stock.rawMaterialAvailableKg);
  return { kind: 'raw', needed, available, label: stock?.rawMaterialLabel ?? null };
}

export type StatusTone = 'ok' | 'short' | 'neutral' | 'warning';

/** La única línea de estado bajo el producto: «Reserva X kg · alcanza» o «… · falta Y kg». */
export function lineStatus(need: LineNeed | null): { text: string; tone: StatusTone } | null {
  if (need === null || need.kind === 'coil') return null;
  if (need.kind === 'service') return { text: 'Servicio · sin inventario', tone: 'neutral' };
  if (need.kind === 'stock') {
    const unit = unitSymbol(need.unit);
    const has = formatQty(need.available.toFixed(3), unit);
    if (need.needed === null) return { text: `De stock · hay ${has}`, tone: 'neutral' };
    if (need.needed.gt(need.available)) {
      const short = formatQty(need.needed.minus(need.available).toFixed(3), unit);
      return { text: `De stock · falta ${short}`, tone: 'short' };
    }
    return { text: `De stock · hay ${has}`, tone: 'ok' };
  }
  if (need.available === null) return { text: 'Sin dato de materia prima', tone: 'warning' };
  if (need.needed === null) {
    return { text: `Hay ${formatKg(need.available)} de bobina`, tone: 'neutral' };
  }
  if (need.needed.gt(need.available)) {
    return {
      text: `Reserva ${formatKg(need.needed)} · falta ${formatKg(need.needed.minus(need.available))}`,
      tone: 'short',
    };
  }
  return { text: `Reserva ${formatKg(need.needed)} · alcanza`, tone: 'ok' };
}

export interface CommitmentInput extends NeedInput {
  /** Número visible de la línea (1, 2, …). */
  lineNumber: number;
}

export interface CommitmentRow {
  key: string;
  kind: 'raw' | 'stock' | 'coil';
  label: string;
  lines: number[];
  needed: Decimal;
  /** Contra cuánto se compara; en una bobina entera, su propio saldo. */
  available: Decimal;
  unit: string;
  /** Lo que falta, o `null` si alcanza. */
  short: Decimal | null;
}

/**
 * El bloque del pie: agrupa por material (el agregado de espesor y color que promete cada
 * cobertura) y por producto de stock, suma lo pedido y lo compara con el disponible.
 *
 * `missing` son las líneas con cantidad cuyo material no se puede calcular (falta el kilo por
 * metro o el disponible del agregado): se omiten del bloque y se nombran aparte.
 */
export function commitmentRows(inputs: readonly CommitmentInput[]): {
  rows: CommitmentRow[];
  missing: number[];
} {
  const rows = new Map<string, Omit<CommitmentRow, 'short'>>();
  const missing: number[] = [];
  const add = (key: string, row: Omit<CommitmentRow, 'short' | 'lines' | 'key'>, at: number) => {
    const current = rows.get(key);
    if (current) {
      current.needed = current.needed.plus(row.needed);
      current.lines.push(at);
    } else {
      rows.set(key, { ...row, key, lines: [at] });
    }
  };
  for (const input of inputs) {
    const need = lineNeed(input);
    if (need === null || need.kind === 'service') continue;
    if (need.kind === 'coil') {
      if (need.qty === null || need.code === null || !input.coil) continue;
      add(
        `coil|${input.coil.coilId}`,
        {
          kind: 'coil',
          label: `Bobina ${need.code}`,
          needed: need.qty,
          available: need.qty,
          unit: 'kg',
        },
        input.lineNumber,
      );
      continue;
    }
    if (need.kind === 'stock') {
      if (need.needed === null || !input.product) continue;
      add(
        `stock|${input.product.id}`,
        {
          kind: 'stock',
          label: input.product.name,
          needed: need.needed,
          available: need.available,
          unit: need.unit,
        },
        input.lineNumber,
      );
      continue;
    }
    if (!isPositiveDecimal(input.qty)) continue;
    if (need.needed === null || need.available === null) {
      missing.push(input.lineNumber);
      continue;
    }
    // El disponible va en la clave: dos SKU con la misma etiqueta pero distinto agregado (por la
    // tolerancia de espesor) no se suman contra un número que no es el de los dos.
    add(
      `raw|${need.label ?? ''}|${need.available.toFixed(3)}`,
      {
        kind: 'raw',
        label: need.label ?? 'Materia prima',
        needed: need.needed,
        available: need.available,
        unit: 'kg',
      },
      input.lineNumber,
    );
  }
  return {
    rows: [...rows.values()].map((row) => ({
      ...row,
      short: row.needed.gt(row.available) ? row.needed.minus(row.available) : null,
    })),
    missing,
  };
}

/** «línea 3» / «líneas 1 y 2» / «líneas 1, 2 y 4». */
export function linesLabel(lines: readonly number[]): string {
  if (lines.length === 1) return `línea ${String(lines[0])}`;
  const head = lines.slice(0, -1).join(', ');
  return `líneas ${head} y ${String(lines[lines.length - 1])}`;
}
