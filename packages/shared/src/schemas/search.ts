import { z } from 'zod';

/**
 * Búsqueda server-side de un selector (RF-S3/M1): reemplaza el patrón de traer el maestro
 * entero y filtrar en el navegador (D-113 ya lo hizo para el listado paginado; esto lo hace
 * para el selector). `q` corto no busca nada — dos caracteres es lo mínimo que separa "a" de
 * cualquier cosa sin devolver medio maestro — y el tope es el mismo `SEARCH_RESULT_LIMIT` en
 * los dos maestros que lo usan hoy (clientes, catálogo), para que el selector compartido no
 * tenga que saber cuál es cuál.
 */
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_RESULT_LIMIT = 20;

export const searchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(SEARCH_MIN_CHARS, `Escribe al menos ${String(SEARCH_MIN_CHARS)} caracteres`)
    .max(80),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/**
 * Orden por relevancia simple: prefijo antes que contiene (RF-S3/M1). El llamador ya filtró
 * por `contains` en SQL (rinde con `ILIKE '%q%'`, D-113) y trajo más filas de las que
 * devuelve — esto solo decide el orden final y el recorte a `SEARCH_RESULT_LIMIT`.
 *
 * `sort` es estable (V8, Node ≥ 11): dentro de un mismo rango (prefijo o contiene), las filas
 * quedan en el orden que ya traía la consulta (alfabético), así que no hace falta un
 * desempate propio.
 */
export function rankSearchMatches<T>(
  rows: readonly T[],
  query: string,
  fieldsOf: (row: T) => readonly string[],
): T[] {
  const needle = query.trim().toLowerCase();
  const rankOf = (row: T): number =>
    fieldsOf(row).some((f) => f.toLowerCase().startsWith(needle)) ? 0 : 1;
  return [...rows].sort((a, b) => rankOf(a) - rankOf(b)).slice(0, SEARCH_RESULT_LIMIT);
}
