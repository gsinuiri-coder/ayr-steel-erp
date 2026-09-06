import { MAX_PAGE_SIZE, type PaginatedResult } from '@ayr/shared';
import { api } from './api';

/**
 * Trae "todo" de un listado que ya pagina (Fase 7d, D-113) para un selector o
 * autocompletado que necesita elegir de la lista entera, no de una página.
 *
 * No es paginación de verdad: pide la página más grande que el servidor admite
 * (`MAX_PAGE_SIZE`) y devuelve solo `items`. Es el mismo atajo que estos selectores ya
 * usaban antes de que el endpoint paginara —traerse el maestro completo—, ahora
 * documentado en un solo lugar: un selector con más de `MAX_PAGE_SIZE` opciones no las ve
 * todas. Reemplazarlo por una búsqueda contra el servidor (como ya tiene `/customers` con
 * `search`) queda para cuando el selector lo necesite de verdad, no antes.
 */
export async function fetchAllForPicker<T>(
  path: string,
  extraParams: Record<string, string> = {},
): Promise<T[]> {
  const params = new URLSearchParams({ pageSize: String(MAX_PAGE_SIZE), ...extraParams });
  const result = await api<PaginatedResult<T>>(`${path}?${params.toString()}`);
  return result.items;
}
