import { useCallback, useRef } from 'react';
import { ApiError } from '@/lib/api';

/**
 * Clave de idempotencia de un intento de submit (D-182).
 *
 * La clave se conserva **solo mientras el desenlace es incierto**: un error de red o un 5xx
 * (el proxy puede cortar con 502/504 después de que el API ya commiteó) dejan la misma clave
 * para el reintento, y el servidor devuelve lo que ya hizo en vez de repetirlo. Un éxito o
 * un 4xx la descartan: en los dos casos el servidor respondió, así que el próximo envío es un
 * intento nuevo — y con un 4xx la transacción hizo rollback, la clave nunca quedó guardada.
 *
 * **La clave es de un contenido, no del formulario** (F8-S4/M0). Si tras un fallo de red el
 * usuario corrige lo que manda y reintenta, ese ya no es el mismo envío: con la clave vieja el
 * servidor —si el primero sí había llegado— devolvía el resultado del **primero** y descartaba
 * la corrección sin decir nada.
 *
 * Por eso se guarda una clave **por huella** mientras su desenlace sea incierto, y no una sola:
 * con A (corte de red, quizá grabado) → B (4xx) → A otra vez, el segundo A tiene que salir con la
 * clave del primero. Recordar solo la última huella lo mandaba con clave nueva y lo duplicaba.
 */
export function useIdempotencyKey(): {
  current: (fingerprint?: string) => string;
  settle: (error?: unknown) => void;
} {
  // Perezoso y con respaldo: `crypto.randomUUID` solo existe en contexto seguro (HTTPS o
  // localhost), y abrir `/planta` por la IP de la red local lo dejaba `undefined` y el panel
  // reventaba al montarse. La clave solo tiene que ser única por intento, no criptográfica.
  const keys = useRef<Map<string, string>>(new Map());
  const lastSent = useRef<string>('');

  const current = useCallback((fingerprint = '') => {
    lastSent.current = fingerprint;
    let key = keys.current.get(fingerprint);
    if (key === undefined) {
      key = newKey();
      keys.current.set(fingerprint, key);
    }
    return key;
  }, []);

  const settle = useCallback((error?: unknown) => {
    const uncertain = error !== undefined && !(error instanceof ApiError && error.status < 500);
    // Solo se olvida la clave del envío que tuvo respuesta; las demás siguen inciertas.
    if (!uncertain) keys.current.delete(lastSent.current);
  }, []);

  return { current, settle };
}

function newKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
