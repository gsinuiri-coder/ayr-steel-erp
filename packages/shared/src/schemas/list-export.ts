import type { z } from 'zod';
import type { paginationQuerySchema } from './pagination';

/**
 * cc26 (D-provisional): exportar a Excel un listado paginado.
 *
 * El Excel trae **todas** las filas que cumplen los filtros actuales de la pantalla, en el mismo
 * orden del servidor (`sort`/`dir`, D-323), no solo la página visible: quien exporta quiere el
 * listado, no los 50 que le tocó ver. Por eso la consulta de exportación es la de la lista **sin**
 * `page` ni `pageSize`.
 *
 * El tope existe para que un filtro vacío sobre el histórico entero no arme un archivo de decenas
 * de miles de filas en memoria. Pasado el tope, la API responde 400 y pide acotar: nunca un
 * archivo recortado en silencio, que se leería como completo.
 */
export const LIST_XLSX_MAX_ROWS = 5000;

/** El mensaje del 400 cuando la exportación pasa el tope. */
export function listExportTooLargeMessage(total: number, max: number = LIST_XLSX_MAX_ROWS): string {
  return `La exportación tiene ${String(total)} filas y el tope es ${String(max)}: acota los filtros.`;
}

type PaginatedQueryShape = typeof paginationQuerySchema.shape;

/**
 * La query de exportación de un listado: el mismo schema, con los mismos filtros, orden y
 * validación, sin `page` ni `pageSize` (si llegan en la URL, Zod los descarta). El `omit` de Zod
 * no acepta la máscara sobre un shape genérico; el tipo de salida es el mismo que daría.
 */
export function listExportQuerySchema<T extends PaginatedQueryShape & z.ZodRawShape>(
  schema: z.ZodObject<T>,
): z.ZodObject<Omit<T, keyof PaginatedQueryShape>> {
  return schema.omit({ page: true, pageSize: true } as never) as unknown as z.ZodObject<
    Omit<T, keyof PaginatedQueryShape>
  >;
}
