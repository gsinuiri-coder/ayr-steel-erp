'use client';

import { useEffect, useState } from 'react';

/**
 * Devuelve el valor recién cuando deja de cambiar durante `delay` ms.
 *
 * Sirve para las búsquedas que van al API (RF-84): sin esto, cada tecla dispara una
 * consulta y la lista parpadea con resultados de búsquedas viejas que llegan tarde.
 */
export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => {
      setDebounced(value);
    }, delay);
    return () => {
      clearTimeout(id);
    };
  }, [value, delay]);
  return debounced;
}
