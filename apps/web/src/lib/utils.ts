import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * La afordancia de "esto navega" en todo el tema (Fase 7d): color + subrayado al pasar el
 * mouse, la misma combinación que ya trae `variant="link"` de `Button`/`Badge`. Antes cada
 * celda de tabla la escribía distinto —algunas con subrayado fijo, otras solo al pasar el
 * mouse, ninguna con color—, y un link en medio de una tabla se confundía con texto plano.
 * Un solo lugar para definirla es lo que evita que la próxima pantalla invente la suya.
 */
export const LINK_CLASSNAME = 'text-primary underline-offset-4 hover:underline';

/**
 * S11/B2: la celda de cliente de las listas comerciales. Las razones sociales peruanas
 * llegan a ochenta caracteres («… SOCIEDAD COMERCIAL DE RESPONSABILIDAD LIMITADA») y, con
 * `whitespace-nowrap` en toda la tabla, una sola de esas filas empujaba la tabla 360 px más
 * allá del ancho disponible: en una laptop de 1366 había que scrollear en horizontal para
 * ver el total y el estado.
 *
 * El nombre se corta y el documento **no**: el documento es el que desambigua dos clientes
 * que empiezan igual, y ocupa un ancho fijo. El nombre completo queda en el `title`.
 */
export const CUSTOMER_CELL_CLASSNAME = 'max-w-[24rem]';
export const CUSTOMER_NAME_CLASSNAME = 'inline-block max-w-[17rem] truncate align-bottom';

/**
 * D-172: no existe una ficha de cliente (`/clientes/[id]`), así que "el link a este
 * cliente" es la lista con su RUC/DNI ya escrito en el buscador — `clientes-view.tsx` lee
 * `?search=` una sola vez, al montar. El RUC/DNI y no el nombre: es el dato exacto, sin
 * ambigüedad entre dos clientes que se llaman parecido.
 */
export function customerSearchHref(docNumber: string): string {
  return `/clientes?search=${encodeURIComponent(docNumber)}`;
}
