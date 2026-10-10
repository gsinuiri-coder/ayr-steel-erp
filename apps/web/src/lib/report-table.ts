import { matchesSearch, searchWords } from '@ayr/shared';
import { sortRows, type SortAccessor } from './sort-rows';
import type { SortState } from './use-sort';

/**
 * cc32 (plantilla de reportes): la lógica de la tabla de un reporte, sin React. Las filas ya
 * llegaron enteras del API; ordenar, buscar y sumar el pie se hace en el navegador.
 *
 * Los totales se calculan con los valores completos (`Decimal`) y se redondean solo al
 * mostrarlos (`formatAmount`): sumar cifras ya redondeadas arrastra céntimos.
 *
 * cc40 (D-588): normalizar, buscar y sumar viven en `@ayr/shared` (`report-rows.ts`), porque el
 * Excel recibe la misma búsqueda y tiene que traer las mismas filas.
 */
export { marginPctOf, normalizeSearch, sumDecimal } from '@ayr/shared';

export interface ReportTableLogic<T> {
  key: string;
  /** Cómo se ordena la columna; sin él, el encabezado no ordena. */
  sortValue?: SortAccessor<T>;
  /** Lo que el buscador mira en esta columna. */
  searchText?: (row: T) => string | readonly string[];
}

/** Las filas cuyo texto buscable contiene cada palabra de la búsqueda. */
export function filterReportRows<T>(
  rows: readonly T[],
  columns: readonly ReportTableLogic<T>[],
  search: string,
): T[] {
  if (searchWords(search).length === 0) return [...rows];
  return rows.filter((row) =>
    matchesSearch(
      columns.flatMap((c) => {
        const value = c.searchText?.(row);
        return value === undefined ? [] : typeof value === 'string' ? [value] : [...value];
      }),
      search,
    ),
  );
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

/**
 * cc40 (D-588): la URL del Excel con la búsqueda de la pantalla, para que el archivo traiga las
 * mismas filas. Sin búsqueda, la URL de siempre. `params` son los filtros del reporte.
 */
export function xlsxHref(
  path: string,
  params: Record<string, string | undefined>,
  search: string,
): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
  if (searchWords(search).length > 0) qs.set('search', search.trim());
  const query = qs.toString();
  return query === '' ? path : `${path}?${query}`;
}
