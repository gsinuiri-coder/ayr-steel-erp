import { Decimal, toDecimal, toFixedString, type DecimalInput } from './decimal';

/**
 * Códigos derivados de una bobina. Viven en `@ayr/shared` porque el API los genera
 * y el web los muestra/previsualiza; una sola definición evita que diverjan.
 *
 * - RF-13 `code`:    `{supplierCode}-{finishCode}-{thicknessMm}-{weightKg}-{correlativo}`
 * - RF-14 `typeKey`: `{finishCode}-{thicknessMm}` (agrupa ignorando el ancho)
 * - D-037 `sku`:     `BOB{finishCode}{thicknessMm}` (uno por `typeKey`)
 *
 * **El guion es un separador, no un carácter a borrar (D-168).** Un código de acabado real
 * lleva guiones adentro —`ALZ-ROJO-3002`— y por ahí se coló la única forma de que dos
 * funciones que dicen calcular el mismo SKU devuelvan cosas distintas: `coilSku` conservaba
 * los guiones del acabado (`BOBALZ-ROJO-30020.45`, que es lo que el catálogo dio de alta) y
 * `coilSkuFromTypeKey` los borraba todos (`BOBALZROJO30020.45`, que es lo que la venta
 * directa buscaba y no encontraba nunca). El síntoma era «no existe el producto de venta
 * directa» sobre una bobina que sí tenía su producto.
 *
 * Por eso hay **una sola** función que arma el SKU (`coilSku`) y la otra parte el `typeKey`
 * por su **último** guion —el que separa el espesor— y la llama.
 */

/** Normaliza un código de acabado o proveedor para usarlo dentro de un código compuesto. */
function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Espesor con la escala mm fija (2 decimales, D-003): `0.5` → `"0.50"`. */
export function formatThickness(thicknessMm: DecimalInput): string {
  return toFixedString(thicknessMm, 'MM');
}

/**
 * Peso en kilos enteros para el segmento de peso de RF-13. El código es una etiqueta
 * física legible; los kilos exactos viven en `coils.weightKg` con escala 3, y la
 * unicidad la garantiza el correlativo, no este segmento.
 */
export function formatCodeWeight(weightKg: DecimalInput): string {
  return toDecimal(weightKg).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
}

/** RF-14: clave de tipo de bobina, agrupa por acabado y espesor ignorando el ancho. */
export function coilTypeKey(finishCode: string, thicknessMm: DecimalInput): string {
  return `${normalizeCode(finishCode)}-${formatThickness(thicknessMm)}`;
}

/**
 * D-037: SKU del producto de `trading` con el que se vende la bobina sin transformar.
 *
 * **La única fuente del SKU de una bobina.** Todo lo que necesite este código pasa por acá,
 * incluida `coilSkuFromTypeKey`: mientras hubo dos cuentas, una generaba el producto y la
 * otra lo buscaba, y con un acabado con guiones no coincidían (D-168).
 */
export function coilSku(finishCode: string, thicknessMm: DecimalInput): string {
  return `BOB${normalizeCode(finishCode)}${formatThickness(thicknessMm)}`;
}

/**
 * D-037: el mismo SKU, partiendo del `typeKey` ya calculado.
 *
 * Parte por el **último** guion, que es el separador que `coilTypeKey` puso entre el acabado
 * y el espesor; los anteriores son parte del código de acabado y se conservan. Es el mismo
 * criterio que `describeTypeKey` usa para leerlo en el inventario valorizado.
 *
 * Sin `typeKey` reconocible —sin guion, con el guion al principio, o con algo que no es un
 * número donde va el espesor— devuelve el prefijo sobre la cadena entera en vez de inventar
 * un espesor o reventar: el llamador va a buscar un producto que no existe y lo va a
 * reportar nombrando el SKU, que es mejor que un 500 sin nombre.
 */
export function coilSkuFromTypeKey(typeKey: string): string {
  const separator = typeKey.lastIndexOf('-');
  const thickness = typeKey.slice(separator + 1);
  if (separator <= 0 || !/^\d+(\.\d+)?$/.test(thickness)) {
    return `BOB${normalizeCode(typeKey)}`;
  }
  return coilSku(typeKey.slice(0, separator), thickness);
}

/** RF-13: código único de una bobina concreta. `sequence` es el correlativo del proveedor. */
export function coilCode(input: {
  supplierCode: string;
  finishCode: string;
  thicknessMm: DecimalInput;
  weightKg: DecimalInput;
  sequence: number;
}): string {
  return [
    normalizeCode(input.supplierCode),
    normalizeCode(input.finishCode),
    formatThickness(input.thicknessMm),
    formatCodeWeight(input.weightKg),
    String(input.sequence),
  ].join('-');
}

/** Nombre legible del producto de catálogo que representa una bobina vendible (D-037). */
export function coilProductName(finishName: string, thicknessMm: DecimalInput): string {
  return `Bobina ${finishName} ${formatThickness(thicknessMm)} mm`;
}
