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
