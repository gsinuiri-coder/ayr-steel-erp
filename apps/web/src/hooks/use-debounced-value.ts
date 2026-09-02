'use client';

import { useEffect, useState } from 'react';

/**
 * Retrasa un valor para no disparar una request por pulsación en los filtros de texto.
 * 300 ms es lo que tarda en notarse como "instantáneo" sin inundar el API.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debounced;
}
