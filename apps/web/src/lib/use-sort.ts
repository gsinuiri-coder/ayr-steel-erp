import { toDecimal } from '@ayr/shared';
import { useUrlState } from './use-url-state';

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
  // D-289: el orden vive en la URL (`?sort=code&dir=desc`) como el resto de los filtros.
  const [url, setUrl] = useUrlState({ sort: '', dir: 'asc' });
  const state: SortState<K> = {
    key: url.sort === '' ? null : (url.sort as K),
    dir: url.dir === 'desc' ? 'desc' : 'asc',
  };
  const toggle = (key: K) => {
    if (state.key === key) setUrl({ dir: state.dir === 'asc' ? 'desc' : 'asc' });
    else setUrl({ sort: key, dir: 'asc' });
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
