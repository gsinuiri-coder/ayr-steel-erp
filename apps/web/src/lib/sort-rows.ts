import { toDecimal } from '@ayr/shared';
import type { SortState } from './use-sort';

/** Cómo se compara una columna al ordenar filas ya cargadas: como texto o como decimal. */
export type SortAccessor<T> = { text: (row: T) => string } | { decimal: (row: T) => string };

/**
 * D-323: ordena filas **ya cargadas** (una tabla que no pagina, o la página de una que sí cuando
 * la columna es derivada). Sin columna elegida devuelve las filas como vienen. El texto se compara
 * sin acentos ni mayúsculas y con los números por su valor (`PED-9` antes que `PED-10`); los
 * decimales por `Decimal`, nunca como `number` (regla dura 9). Un valor vacío va siempre al final.
 */
export function sortRows<T, K extends string>(
  rows: readonly T[],
  sort: SortState<K>,
  accessors: Readonly<Record<K, SortAccessor<T>>>,
): T[] {
  if (sort.key === null) return [...rows];
  const accessor = accessors[sort.key];
  const sign = sort.dir === 'asc' ? 1 : -1;
  const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
  return [...rows].sort((a, b) => {
    const [x, y] =
      'text' in accessor
        ? [accessor.text(a), accessor.text(b)]
        : [accessor.decimal(a), accessor.decimal(b)];
    if (x === '' || y === '') return x === y ? 0 : x === '' ? 1 : -1;
    return 'text' in accessor
      ? collator.compare(x, y) * sign
      : toDecimal(x).comparedTo(toDecimal(y)) * sign;
  });
}
