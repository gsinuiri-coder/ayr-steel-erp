'use client';

import { useCallback, useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { BusinessLine } from '@ayr/shared';

/**
 * cc23 (D-393..D-395): la pestaña de línea de negocio de un reporte vive en la query string,
 * con el mismo estilo que los filtros de D-289 (`?linea=drywall`), y la pestaña por defecto no
 * se escribe (URL limpia).
 *
 * Diferencias con `useUrlState`, a propósito:
 * - Cambiar de pestaña **entra al historial** (`router.push`): retroceder vuelve a la pestaña
 *   anterior. Los filtros siguen con `replace`.
 * - Cambiar de pestaña conserva solo los filtros comunes que la vista nombra (`keep`) y
 *   descarta el resto, que puede no aplicar a la línea nueva.
 * - Una línea inválida o sin reporte aplicable cae a la pestaña por defecto y la URL se
 *   corrige con `replace` (no deja una entrada rota en el historial).
 */
export const LINE_TAB_PARAM = 'linea';
export const ALL_LINES_TAB = 'todas';

export type LineTab = BusinessLine | typeof ALL_LINES_TAB;

export interface LineTabsConfig {
  /** Las líneas que tienen este reporte, en el orden de las pestañas (D-391). */
  lines: readonly BusinessLine[];
  /** D-393: «Todas», primera y por defecto. */
  includeAll: boolean;
  /** Los filtros comunes que sobreviven al cambio de pestaña (D-395). */
  keep?: readonly string[];
}

/** La pestaña por defecto: «Todas» si el reporte la lleva; si no, la primera línea. */
export function defaultLineTab(config: LineTabsConfig): LineTab {
  if (config.includeAll) return ALL_LINES_TAB;
  const [first] = config.lines;
  if (first === undefined) throw new Error('Un reporte por línea necesita al menos una línea');
  return first;
}

/**
 * Lee la pestaña desde el valor crudo del parámetro. `valid: false` significa que la URL trae
 * algo que no es una pestaña de este reporte —una línea inexistente, una línea sin este
 * reporte (D-394) o el nombre de la pestaña por defecto escrito a mano— y hay que corregirla.
 */
export function resolveLineTab(
  raw: string | null,
  config: LineTabsConfig,
): { tab: LineTab; valid: boolean } {
  const fallback = defaultLineTab(config);
  if (raw === null) return { tab: fallback, valid: true };
  const match = config.lines.find((line) => line === raw);
  if (match !== undefined && match !== fallback) return { tab: match, valid: true };
  return { tab: fallback, valid: false };
}

/** La URL de una pestaña: los filtros de `keep` que había, más `linea` si no es la de defecto. */
export function lineTabHref(
  pathname: string,
  current: URLSearchParams,
  tab: LineTab,
  config: LineTabsConfig,
): string {
  const next = new URLSearchParams();
  for (const key of config.keep ?? []) {
    const value = current.get(key);
    if (value !== null) next.set(key, value);
  }
  if (tab !== defaultLineTab(config)) next.set(LINE_TAB_PARAM, tab);
  const qs = next.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/** La URL corregida: la misma, sin el parámetro de línea inválido. */
export function withoutLineParam(pathname: string, current: URLSearchParams): string {
  const next = new URLSearchParams(current);
  next.delete(LINE_TAB_PARAM);
  const qs = next.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/**
 * La pestaña actual y cómo cambiarla. `line` es la línea que se le pide a la API: `undefined`
 * en «Todas».
 */
export function useLineTab(config: LineTabsConfig): {
  tab: LineTab;
  line: BusinessLine | undefined;
  select: (tab: LineTab) => void;
} {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { tab, valid } = resolveLineTab(searchParams.get(LINE_TAB_PARAM), config);

  useEffect(() => {
    if (!valid) {
      router.replace(withoutLineParam(pathname, new URLSearchParams(searchParams.toString())), {
        scroll: false,
      });
    }
  }, [valid, router, pathname, searchParams]);

  const { lines, includeAll, keep } = config;
  const select = useCallback(
    (next: LineTab) => {
      if (next === tab) return;
      const href = lineTabHref(pathname, new URLSearchParams(searchParams.toString()), next, {
        lines,
        includeAll,
        keep,
      });
      router.push(href, { scroll: false });
    },
    [router, pathname, searchParams, tab, lines, includeAll, keep],
  );

  return { tab, line: tab === ALL_LINES_TAB ? undefined : tab, select };
}
