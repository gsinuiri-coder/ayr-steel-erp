import type { SortDirection } from '@ayr/shared';

/**
 * D-323: el `orderBy` de un listado paginado a partir de `?sort=&dir=`.
 *
 * - Sin `sort` (o con una clave que el listado no declara) queda el orden por defecto de
 *   siempre, sin tocarlo (D-113/D-124).
 * - Con `sort`, esa columna manda y el orden por defecto desempata: así dos filas iguales en la
 *   columna elegida no cambian de lugar entre página y página.
 * - `dir` ausente es ascendente.
 *
 * Cada listado pasa su tabla `clave → fragmento de orderBy`: solo columnas propias de la
 * entidad (o de una relación directa, como el nombre del cliente). Una columna derivada no es
 * una clave.
 */
export function listOrderBy<K extends string, O>(
  query: { sort?: K | undefined; dir?: SortDirection | undefined },
  columns: Readonly<Record<K, (dir: SortDirection) => O | readonly O[]>>,
  fallback: readonly O[],
): O[] {
  const column = query.sort === undefined ? undefined : columns[query.sort];
  if (column === undefined) return [...fallback];
  const chosen = column(query.dir ?? 'asc');
  return [...(Array.isArray(chosen) ? (chosen as readonly O[]) : [chosen as O]), ...fallback];
}
