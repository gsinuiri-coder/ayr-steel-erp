'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * cc47 (D-617): la pestaña de una página con más de una tabla principal, en la URL (`?tab=…`).
 *
 * Como la pestaña de línea de los reportes (`useLineTab`): cambiar de pestaña **entra al
 * historial** (`router.push`), así retroceder vuelve a la pestaña anterior, y la pestaña por defecto
 * no se escribe (URL limpia). Un valor que no es una pestaña cae en la de defecto. Los demás
 * parámetros se conservan tal cual; la vista elige nombres que no choquen entre sus pestañas.
 */
export function useUrlTab<T extends string>(
  tabs: readonly T[],
  fallback: T,
  param = 'tab',
): [T, (next: T) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const raw = searchParams.get(param);
  const tab = tabs.find((t) => t === raw) ?? fallback;

  const select = useCallback(
    (next: T) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === fallback) params.delete(param);
      else params.set(param, next);
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams, fallback, param],
  );

  return [tab, select];
}
