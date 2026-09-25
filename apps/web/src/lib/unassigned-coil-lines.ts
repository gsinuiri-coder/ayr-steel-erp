import { BusinessLine, COIL_SKU_PREFIX } from '@ayr/shared';

/** Lo mínimo de una línea para saber si es un `BOB…` sin bobina asignada. */
export interface CoilLineRef {
  lineNumber: number;
  productSku: string;
  businessLine: string;
  reserveItemType: string;
}

/**
 * D-322: las líneas que son el producto de venta de una bobina (`BOB…`, línea de reventa) pero
 * **no** tienen una bobina concreta. Nacen en una cotización importada (D-254) o en el duplicado
 * de una cuya bobina sigue atada a otro documento. Una así no se puede confirmar: hay que elegir
 * la bobina. Se deriva de las líneas; no hay campo aparte.
 */
export function unassignedCoilLines<T extends CoilLineRef>(items: readonly T[]): T[] {
  return items.filter(
    (i) =>
      i.businessLine === BusinessLine.TRADING &&
      i.productSku.toUpperCase().startsWith(COIL_SKU_PREFIX) &&
      i.reserveItemType !== 'COIL',
  );
}
