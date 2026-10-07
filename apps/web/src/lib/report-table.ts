import { toDecimal, type Decimal } from '@ayr/shared';
import { sortRows, type SortAccessor } from './sort-rows';
import type { SortState } from './use-sort';

/**
 * cc32 (plantilla de reportes): la lógica de la tabla de un reporte, sin React. Las filas ya
 * llegaron enteras del API; ordenar, buscar y sumar el pie se hace en el navegador.
 *
 * Los totales se calculan con los valores completos (`Decimal`) y se redondean solo al
 * mostrarlos (`formatAmount`): sumar cifras ya redondeadas arrastra céntimos.
 */
export interface ReportTableLogic<T> {
  key: string;
  /** Cómo se ordena la columna; sin él, el encabezado no ordena. */
  sortValue?: SortAccessor<T>;
  /** Lo que el buscador mira en esta columna. */
  searchText?: (row: T) => string | readonly string[];
}

/** Sin tildes ni mayúsculas, para que «alamos» encuentre «Álamos» (como `normalize` de «Ir a»). */
export function normalizeSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/** Las filas cuyo texto buscable contiene cada palabra de la búsqueda. */
export function filterReportRows<T>(
  rows: readonly T[],
  columns: readonly ReportTableLogic<T>[],
  search: string,
): T[] {
  const words = normalizeSearch(search).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((row) => {
    const haystack = normalizeSearch(
      columns
        .flatMap((c) => {
          const value = c.searchText?.(row);
          return value === undefined ? [] : typeof value === 'string' ? [value] : [...value];
        })
        .join(' '),
    );
    return words.every((w) => haystack.includes(w));
  });
}

/** Busca y después ordena, con el orden de la URL. */
export function visibleReportRows<T>(
  rows: readonly T[],
  columns: readonly ReportTableLogic<T>[],
  search: string,
  sort: SortState<string>,
): T[] {
  const accessors: Partial<Record<string, SortAccessor<T>>> = {};
  for (const c of columns) if (c.sortValue) accessors[c.key] = c.sortValue;
  return sortRows(filterReportRows(rows, columns, search), sort, accessors);
}

/** La suma exacta de una columna; un valor `null` (sin dato) no suma. */
export function sumDecimal<T>(rows: readonly T[], value: (row: T) => string | null): Decimal {
  let total = toDecimal('0');
  for (const row of rows) {
    const v = value(row);
    if (v !== null) total = total.plus(toDecimal(v));
  }
  return total;
}

/**
 * Margen sobre venta (§7) en puntos, con dos decimales como el API, o `null` sin base positiva
 * (el mismo criterio del API: con base cero o negativa el porcentaje se calla).
 */
export function marginPctOf(sales: Decimal, margin: Decimal): string | null {
  if (sales.lte(0)) return null;
  return margin.div(sales).times(100).toFixed(2);
}
