import { z } from 'zod';

/**
 * Paginación server-side (Fase 7d, D-113). Un solo patrón para todo listado que crece sin
 * techo: página 1-based + tamaño, y el total real para que la UI sepa cuántas páginas hay.
 *
 * Página y no cursor: cada vista quiere mostrar "N–M de T" y saltar a una página concreta,
 * no solo avanzar. Con volúmenes de una sola empresa (miles de filas, no millones) el costo
 * de `OFFSET` en Postgres es intrascendente frente a la simplicidad de que la URL, el
 * control de la UI y la consulta digan lo mismo: página y tamaño.
 */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
/**
 * Tope de `page` (auditoría de seguridad, Fase 7d): sin esto, `pageSize` topado no alcanza
 * para acotar `skip` — `(page - 1) * pageSize` con un `page` arbitrariamente grande sigue
 * siendo un `OFFSET` arbitrariamente grande, y Postgres lo recorre entero antes de aplicar
 * `take`. Con `pageSize` en su tope (200), este límite deja un `skip` máximo de 2 millones de
 * filas — generoso frente al volumen real de una sola empresa (D-113), pero ya no ilimitado.
 */
export const MAX_PAGE = 10_000;

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Forma de respuesta de todo listado paginado. `items` ya viene recortado a la página. */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** `skip`/`take` de Prisma a partir de una query ya validada. */
export function toSkipTake(query: PaginationQuery): { skip: number; take: number } {
  return { skip: (query.page - 1) * query.pageSize, take: query.pageSize };
}

/** Envuelve una página de filas ya recortada junto con el total real (sin recortar). */
export function paginate<T>(items: T[], total: number, query: PaginationQuery): PaginatedResult<T> {
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * Recorta en memoria una página de un arreglo **ya filtrado por completo** (Fase 7d).
 *
 * Existe para el filtro que no se puede empujar a SQL sin duplicar ahí una regla que ya
 * vive en `@ayr/shared` (D-075: el saldo de un comprobante o de una compra es derivado, no
 * una columna). El llamador trae todas las filas que pasan el filtro SQL de siempre y
 * aplica acá el filtro derivado; esta función solo corta la página sobre ese resultado ya
 * completo, así que `total` es el conteo real de filas que cumplen, no del recorte SQL que
 * las trajo.
 */
export function paginateInMemory<T>(all: T[], query: PaginationQuery): PaginatedResult<T> {
  const { skip, take } = toSkipTake(query);
  return {
    items: all.slice(skip, skip + take),
    total: all.length,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * Tope de filas que se traen **antes** de aplicar un filtro derivado (saldo pendiente de
 * un comprobante o de una compra, deuda por cliente). No es el tamaño de página: es cuánto
 * se está dispuesto a traer de la base para poder filtrar en memoria sin duplicar en SQL
 * la regla de saldo (D-075).
 *
 * Frontera conocida: si algún día el negocio tiene más de este número de comprobantes o
 * compras **vivos** (no el histórico entero, solo lo que sigue pudiendo tener saldo), el
 * filtro dejaría de ver los más antiguos. A la fecha de esta fase es una cota generosa
 * frente al volumen real; si deja de serlo, el filtro de saldo necesita moverse a SQL con
 * una consulta correlacionada, y ese día vale la pena porque el volumen ya lo justifica.
 */
export const DERIVED_FILTER_FETCH_CAP = 5000;
