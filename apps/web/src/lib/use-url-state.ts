'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { DEFAULT_PAGE_SIZE } from '@ayr/shared';
import { useDebounced } from './use-debounced';

/**
 * D-289: los filtros de una lista viven en la query string (`?search=…&page=2&status=…`), no
 * en `useState`. Recargar la página, volver atrás o pegar el enlace reproduce la misma vista.
 *
 * Reglas del hook:
 * - La URL es la única fuente de verdad: lo que devuelve sale de `useSearchParams` y lo que
 *   falta toma el valor por defecto. Un parámetro igual a su default no se escribe (URL limpia).
 * - `router.replace`, nunca `push`: filtrar no apila historial. Solo query string, jamás
 *   segmentos de path. `scroll: false` para que la lista no salte.
 * - Cambiar cualquier filtro vuelve a la página 1, salvo que el mismo parche traiga `page`.
 * - Todos los valores son strings; la vista convierte (`Number(state.page)`).
 */
export function useUrlState<S extends Record<string, string>>(
  defaults: S,
): [S, (patch: Partial<S> | ((current: S) => Partial<S>)) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // `defaults` es un literal nuevo en cada render: se fija la primera vez (sus claves y
  // valores no cambian en la vida de la vista).
  const defaultsRef = useRef(defaults);

  const state = useMemo(() => {
    const base = defaultsRef.current;
    const out: Record<string, string> = {};
    for (const key of Object.keys(base)) {
      out[key] = searchParams.get(key) ?? base[key] ?? '';
    }
    return out as S;
  }, [searchParams]);

  // La query string más reciente que este hook escribió: dos parches seguidos en el mismo
  // tick (p. ej. cambiar estado y luego el rango) parten de la URL ya parchada, no de la
  // que `useSearchParams` todavía no refleja.
  const latest = useRef(searchParams.toString());
  useEffect(() => {
    latest.current = searchParams.toString();
  }, [searchParams]);

  const setState = useCallback(
    (input: Partial<S> | ((current: S) => Partial<S>)) => {
      const base = defaultsRef.current;
      const next = new URLSearchParams(latest.current);
      // Con una función, el parche se calcula sobre la URL **más reciente** y no sobre lo que se
      // pintó: dos toggles seguidos (chips) parten cada uno del resultado del anterior.
      let patch: Partial<S>;
      if (typeof input === 'function') {
        const current: Record<string, string> = {};
        for (const key of Object.keys(base)) current[key] = next.get(key) ?? base[key] ?? '';
        patch = input(current as S);
      } else {
        patch = input;
      }
      const touchesPage = 'page' in patch;
      let changedFilter = false;
      for (const [key, value] of Object.entries(patch) as [string, string | undefined][]) {
        if (value === undefined) continue;
        // Ordenar no cambia qué filas hay: no devuelve a la página 1.
        if (key !== 'page' && key !== 'sort' && key !== 'dir') changedFilter = true;
        if (value === '' || value === base[key]) next.delete(key);
        else next.set(key, value);
      }
      // Un filtro nuevo puede dejar la página actual fuera del resultado: vuelve a la 1.
      if (changedFilter && !touchesPage) next.delete('page');
      const qs = next.toString();
      latest.current = qs;
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );

  return [state, setState];
}

/** Las claves de paginación que toda lista server-side lleva en sus defaults. */
export const URL_PAGINATION_DEFAULTS = { page: '1', pageSize: String(DEFAULT_PAGE_SIZE) };

/**
 * Paginación sobre la URL (`page`, `pageSize`): el reemplazo de `usePagination` para listas
 * server-side. Los defaults de la vista incluyen `URL_PAGINATION_DEFAULTS`; `page` y
 * `pageSize` no se escriben mientras valgan sus valores por defecto.
 */
export function useUrlPagination<S extends { page: string; pageSize: string }>(
  state: S,
  setState: (patch: Partial<S>) => void,
) {
  const page = Math.max(1, Number(state.page) || 1);
  const pageSize = Number(state.pageSize) || DEFAULT_PAGE_SIZE;
  return {
    page,
    pageSize,
    setPage: (p: number) => {
      setState({ page: String(p) } as Partial<S>);
    },
    // Cambiar el tamaño vuelve a la página 1 (`setState` borra `page` al no venir en el parche).
    setPageSize: (size: number) => {
      setState({ pageSize: String(size) } as Partial<S>);
    },
  };
}

/**
 * Cuadro de texto ligado a un parámetro de la URL. El usuario ve lo que teclea al instante
 * (estado local); la URL —y con ella la consulta— se actualiza cuando deja de teclear
 * `delay` ms. Si la URL cambia desde afuera (otro enlace `?search=…`, atrás/adelante), el
 * cuadro la sigue; el eco de su propio commit no lo pisa.
 *
 * Devuelve `[texto del cuadro, setter, valor ya comprometido en la URL]`.
 */
export function useUrlSearchInput(
  urlValue: string,
  commit: (value: string) => void,
  delay = 300,
): [string, (value: string) => void, string] {
  const [draft, setDraft] = useState(urlValue);
  const lastCommitted = useRef(urlValue);
  // Valores que este hook ya escribió y cuyo eco puede llegar tarde: con latencia, el
  // `router.replace` de «ab» puede resolverse cuando el usuario ya tecleó «abc», y ese eco no es
  // un cambio externo (no debe pisar el cuadro).
  const ownCommits = useRef(new Set<string>());
  const trimmed = draft.trim();
  const debounced = useDebounced(trimmed, delay);

  useEffect(() => {
    if (debounced !== lastCommitted.current) {
      lastCommitted.current = debounced;
      ownCommits.current.add(debounced);
      commit(debounced);
    }
    // `commit` cambia de identidad con el path; lo que importa es el valor debounced.
  }, [debounced]);

  useEffect(() => {
    if (urlValue === lastCommitted.current) {
      // La URL alcanzó lo último que se escribió: ya no hay ecos pendientes.
      ownCommits.current.clear();
      return;
    }
    if (ownCommits.current.has(urlValue)) return; // eco atrasado de un commit propio
    lastCommitted.current = urlValue; // cambio externo (otro enlace, atrás/adelante)
    setDraft(urlValue);
  }, [urlValue]);

  return [draft, setDraft, urlValue];
}
