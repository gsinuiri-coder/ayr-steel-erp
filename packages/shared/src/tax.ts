import { toDecimal, type Decimal, type DecimalInput } from './decimal';

/**
 * IGV y la única traducción entre **valor de venta** y **precio de venta** (D-162).
 *
 * La terminología no es cosmética y por eso vive en una función y no suelta en cada pantalla:
 *
 * - **valor de venta** = SIN IGV. Es lo que el sistema guarda en `unitPricePen`,
 *   `subtotalPen` y lo que SUNAT/Nubefact facturan (`valorUnitario`, `valorVenta`).
 * - **precio de venta** = CON IGV. Es lo que el cliente paga, lo que el vendedor negocia y
 *   —desde D-162— lo que se **tipea** en la cotización.
 *
 * Mientras las dos palabras se usaron como sinónimas hubo pantallas que rotulaban «precio
 * unitario» un número sin IGV: el vendedor tipeaba lo que le había prometido al cliente y el
 * documento salía un 18% más caro.
 *
 * Módulo hoja, sin más dependencia que `./decimal`, por el mismo motivo que `business-date`
 * (D-130): `schemas/pricing` lo necesita y se carga **antes** que `schemas/sales`, así que
 * dejar el IGV en `sales` habría cerrado un ciclo que en CommonJS no lanza — deja
 * `undefined` y borra el factor en silencio.
 */

/** IGV en puntos porcentuales. Fijo en ventas (D-068); en compras es un input (D-030). */
export const IGV_RATE_PCT = '18.0000';

/** `1 + IGV`. El factor exacto que separa el valor del precio. */
export function igvFactor(): Decimal {
  return toDecimal('1').plus(toDecimal(IGV_RATE_PCT).div(100));
}

/**
 * Valor de venta (sin IGV) a partir del precio de venta (con IGV): `precio ÷ 1.18`.
 *
 * Devuelve el Decimal **sin redondear**: el redondeo a la escala de dinero se hace una sola
 * vez, al final de la cadena de cuentas, nunca en un paso intermedio (D-003). Con un precio
 * de 10.00 esto vale 8.474576271186…, y es el llamador el que decide dónde cortarlo.
 */
export function saleValueFromPrice(pricePen: DecimalInput): Decimal {
  return toDecimal(pricePen).div(igvFactor());
}

/** Precio de venta (con IGV) a partir del valor de venta (sin IGV): `valor × 1.18`. Sin redondear. */
export function salePriceFromValue(valuePen: DecimalInput): Decimal {
  return toDecimal(valuePen).times(igvFactor());
}
