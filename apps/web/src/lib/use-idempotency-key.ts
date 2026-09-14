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
 *
 * **La clave es de un contenido, no del formulario** (F8-S4/M0). Si tras un fallo de red el
 * usuario corrige lo que manda y reintenta, ese ya no es el mismo envío: con la clave vieja el
 * servidor —si el primero sí había llegado— devolvía el resultado del **primero** y descartaba
 * la corrección sin decir nada. `current(fingerprint)` renueva la clave cuando la huella del
 * contenido cambió respecto de la que la clave llevó la última vez.
 */
export function useIdempotencyKey(): {
  current: (fingerprint?: string) => string;
  settle: (error?: unknown) => void;
} {
  // Perezoso y con respaldo: `crypto.randomUUID` solo existe en contexto seguro (HTTPS o
  // localhost), y abrir `/planta` por la IP de la red local lo dejaba `undefined` y el panel
  // reventaba al montarse. La clave solo tiene que ser única por intento, no criptográfica.
  const key = useRef<string | null>(null);
  const sentWith = useRef<string | undefined>(undefined);
  key.current ??= newKey();

  const current = useCallback((fingerprint?: string) => {
    if (
      fingerprint !== undefined &&
      sentWith.current !== undefined &&
      fingerprint !== sentWith.current
    ) {
      key.current = newKey();
    }
    sentWith.current = fingerprint;
    return (key.current ??= newKey());
  }, []);

  const settle = useCallback((error?: unknown) => {
    const uncertain = error !== undefined && !(error instanceof ApiError && error.status < 500);
    if (!uncertain) {
      key.current = newKey();
      sentWith.current = undefined;
    }
  }, []);

  return { current, settle };
}

function newKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
