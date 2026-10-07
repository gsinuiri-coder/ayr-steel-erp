import {
  fixedLengthValuePerMeter,
  money,
  salePriceFromValue,
  sellsByFixedLength,
  toDecimal,
  toFixedString,
  type ProductDto,
} from '@ayr/shared';

/**
 * cc31 (corte 6): el precio de lista **con IGV** de un producto, solo para mostrarlo («Lista
 * 18.50») en el formulario de venta y en el selector de producto.
 *
 * Es la misma traducción con la que el formulario siembra el precio al elegir un producto
 * (`chooseProduct`): el maestro guarda un valor sin IGV por unidad de venta, y en una plancha de
 * catálogo el campo se negocia por metro. Con `perPiece` devuelve el de la plancha entera (o de
 * la unidad, en el resto). `null` si el producto no tiene lista.
 */
export function listPriceWithIgv(
  product: Pick<ProductDto, 'listPricePen' | 'lengthMm' | 'unit' | 'roofingKind'>,
  perPiece = false,
): string | null {
  const listValue = product.listPricePen;
  if (!listValue) return null;
  const perUnitValue =
    !perPiece && sellsByFixedLength(product) && product.lengthMm !== null
      ? fixedLengthValuePerMeter(product.lengthMm, listValue)
      : toDecimal(listValue);
  return toFixedString(money(salePriceFromValue(perUnitValue)), 'MONEY');
}
