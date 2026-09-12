import { useCallback, useRef } from 'react';
import { ApiError } from '@/lib/api';

/**
 * Clave de idempotencia de un intento de submit (D-182).
 *
 * La clave se conserva **solo mientras el desenlace es incierto**: un error de red o un 5xx
 * (el proxy puede cortar con 502/504 después de que el API ya commiteó) dejan la misma clave
 * para el reintento, y el servidor devuelve lo que ya hizo en vez de repetirlo. Un éxito o
 * un 4xx la renuevan: en los dos casos el servidor respondió, así que el próximo envío es un
 * intento nuevo — y con un 4xx la transacción hizo rollback, la clave nunca quedó guardada.
 */
export function useIdempotencyKey(): {
  current: () => string;
  settle: (error?: unknown) => void;
} {
  const key = useRef<string>(crypto.randomUUID());

  const current = useCallback(() => key.current, []);

  const settle = useCallback((error?: unknown) => {
    const uncertain = error !== undefined && !(error instanceof ApiError && error.status < 500);
    if (!uncertain) key.current = crypto.randomUUID();
  }, []);

  return { current, settle };
}
