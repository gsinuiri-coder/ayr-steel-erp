import { Decimal, toDecimal, toFixedString, type DecimalInput } from './decimal';

/**
 * Códigos derivados de una bobina. Viven en `@ayr/shared` porque el API los genera
 * y el web los muestra/previsualiza; una sola definición evita que diverjan.
 *
 * - RF-13 `code`:    `{supplierCode}-{finishCode}-{thicknessMm}-{weightKg}-{correlativo}`
 * - RF-14 `typeKey`: `{finishCode}-{thicknessMm}` (agrupa ignorando el ancho)
 * - D-037 `sku`:     `BOB{finishCode}{thicknessMm}` (uno por `typeKey`, sin guiones)
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

/** D-037: SKU del producto de `trading` con el que se vende la bobina sin transformar. */
export function coilSku(finishCode: string, thicknessMm: DecimalInput): string {
  return `BOB${normalizeCode(finishCode)}${formatThickness(thicknessMm)}`;
}

/** D-037: mismo SKU, partiendo del `typeKey` ya calculado. */
export function coilSkuFromTypeKey(typeKey: string): string {
  return `BOB${typeKey.replace(/-/g, '')}`;
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
