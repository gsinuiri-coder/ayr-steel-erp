import { useState } from 'react';
import { toDecimal } from '@ayr/shared';

export type SortDir = 'asc' | 'desc';

export interface SortState<K extends string> {
  key: K | null;
  dir: SortDir;
}

/**
 * S10b/M1: sort de columna sobre lo ya cargado (una lista paginada del servidor solo
 * ordena su página actual, no el total — tocar eso es tocar el API, y esta sesión no lo
 * hace). `key: null` es el estado inicial: sin ninguna columna clickeada, la lista se ve
 * exactamente como la manda el servidor (descendente por defecto, D-172..D-176 no la
 * tocan). Clickear una columna por primera vez ordena ascendente; clickearla de nuevo
 * invierte; clickear otra columna arranca esa en ascendente.
 */
export function useSort<K extends string>(): [SortState<K>, (key: K) => void] {
  const [state, setState] = useState<SortState<K>>({ key: null, dir: 'asc' });
  const toggle = (key: K) => {
    setState((s) =>
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );
  };
  return [state, toggle];
}

/** Compara dos valores ya extraídos de la fila, con el sentido de `dir`. */
export function compareBy<T>(dir: SortDir, a: T, b: T): number {
  const sign = dir === 'asc' ? 1 : -1;
  if (a < b) return -1 * sign;
  if (a > b) return 1 * sign;
  return 0;
}

/**
 * Regla dura 1: dinero/kg/mm no se comparan como `number`. `comparedTo` de `Decimal` es la
 * comparación, no una operación aritmética, pero igual pasa por `Decimal` y no por `<`/`>`
 * directo sobre el string.
 */
export function compareDecimalBy(dir: SortDir, a: string, b: string): number {
  const sign = dir === 'asc' ? 1 : -1;
  return toDecimal(a).comparedTo(toDecimal(b)) * sign;
}
