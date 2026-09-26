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
export function useSort<K extends string>(
  /** Prefijo de las claves de la URL, para una segunda tabla en la misma pantalla (`h` → `hsort`). */
  prefix = '',
): [SortState<K>, (key: K) => void] {
  // D-289: el orden vive en la URL (`?sort=code&dir=desc`) como el resto de los filtros.
  // `page` va en los defaults solo para poder borrarla: ordenar una lista paginada por el
  // servidor cambia qué filas hay en cada página, así que vuelve a la primera (D-323).
  const sortKey = `${prefix}sort`;
  const dirKey = `${prefix}dir`;
  const [url, setUrl] = useUrlState({ [sortKey]: '', [dirKey]: 'asc', page: '' });
  const current = url[sortKey] ?? '';
  const currentDir = url[dirKey] === 'desc' ? 'desc' : 'asc';
  const state: SortState<K> = {
    key: current === '' ? null : (current as K),
    dir: currentDir,
  };
  const toggle = (key: K) => {
    if (state.key === key) setUrl({ [dirKey]: state.dir === 'asc' ? 'desc' : 'asc', page: '' });
    else setUrl({ [sortKey]: key, [dirKey]: 'asc', page: '' });
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
