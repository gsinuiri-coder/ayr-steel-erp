import {
  Decimal,
  lineAmounts,
  money,
  roundDocumentTotals,
  salePriceFromValue,
  toDecimal,
  toFixedString,
  type LineAmounts,
  type SalesLineTotals,
} from '@ayr/shared';
import { isPositiveDecimal } from '@/lib/format';

/**
 * Precios del mostrador (cc27, UX26-01; D-452).
 *
 * El mostrador muestra **precios con IGV**, como el catálogo (D-162, AGENTS.md §7): la ficha del
 * producto, el precio unitario que se tipea y el importe de la línea. Lo que viaja al API y se
 * guarda sigue siendo el valor sin IGV, con las mismas funciones que usa el API (`lineAmounts`,
 * `roundDocumentTotals`, D-255 y D-377), así que el total que se ve es el del comprobante al
 * céntimo.
 */

/** El precio de lista con IGV, exactamente como lo muestra el catálogo (`price-list-cell`). */
export function listPriceWithIgv(listValuePen: string): string {
  return toFixedString(money(salePriceFromValue(listValuePen)), 'MONEY');
}

export interface PosCartLinePrice {
  /** Cantidad tipeada, en la unidad de venta del producto. */
  qty: string;
  /** Precio unitario **con IGV** tipeado (o sembrado desde la lista). */
  priceWithIgvPen: string;
  /** Valor de lista sin IGV del producto, o `null` si no tiene. */
  listValuePen: string | null;
}

/** Lo que la línea manda al API: el valor de lista si nadie tocó el precio, si no el precio con IGV. */
export type PosLinePayload = { unitPricePen: string } | { unitPriceWithIgvPen: string };

/**
 * D-377 (B3), igual que la cotización: un precio que nadie tocó viaja **por su valor de lista**
 * (sin IGV), no por el precio con IGV sembrado, para que la línea valga lo que dice la lista.
 * Un precio tipeado viaja como precio con IGV (D-255): el total de la línea es
 * `redondeo(cantidad × precio)` y el valor sin IGV se deriva. `null` si el precio no es válido.
 */
export function posLinePayload(line: PosCartLinePrice): PosLinePayload | null {
  const price = line.priceWithIgvPen.trim();
  if (!isPositiveDecimal(price)) return null;
  if (line.listValuePen !== null && price === listPriceWithIgv(line.listValuePen)) {
    return { unitPricePen: toFixedString(line.listValuePen, 'MONEY') };
  }
  const unitPriceWithIgvPen = toFixedString(price, 'MONEY');
  if (!toDecimal(unitPriceWithIgvPen).gt(0)) return null;
  return { unitPriceWithIgvPen };
}

/** Los importes de la línea como los va a guardar el API, o `null` si falta cantidad o precio. */
export function posLineAmounts(line: PosCartLinePrice): LineAmounts | null {
  if (!isPositiveDecimal(line.qty.trim())) return null;
  const payload = posLinePayload(line);
  if (payload === null) return null;
  const qty = toFixedString(line.qty.trim(), 'KG');
  return 'unitPricePen' in payload
    ? lineAmounts(qty, { unitValuePen: payload.unitPricePen })
    : lineAmounts(qty, { unitPriceWithIgvPen: payload.unitPriceWithIgvPen });
}

/**
 * El pie del carrito: subtotal sin IGV, IGV y total, al céntimo como el comprobante (D-377: se
 * redondea la suma de las líneas, no cada línea). Una línea incompleta no suma.
 */
export function posCartTotals(lines: readonly (LineAmounts | null)[]): SalesLineTotals {
  const valid = lines.filter((l): l is LineAmounts => l !== null);
  return roundDocumentTotals(
    valid.reduce((acc, l) => acc.plus(l.subtotal), new Decimal(0)),
    valid.reduce((acc, l) => acc.plus(l.igv), new Decimal(0)),
  );
}
