import { z } from 'zod';
import { BUSINESS_LINES } from '../enums';
import { Decimal, decimalStringSchema, toDecimal, toFixedString } from '../decimal';
import { salePriceFromValue } from '../tax';

/**
 * Márgenes por línea de negocio (D-032/P-09). `marginPct`/`minMarginPct` son puntos
 * porcentuales (15.5 = 15.5%), guardados como Decimal (D-003), nunca `number`.
 */
export const pricingSettingSchema = z.object({
  id: z.string().uuid(),
  businessLineId: z.string().uuid(),
  businessLineCode: z.enum(BUSINESS_LINES),
  marginPct: z.string(),
  minMarginPct: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PricingSettingDto = z.infer<typeof pricingSettingSchema>;

/**
 * D-163: el margen es **sobre la venta**, así que un 100% es una división por cero y
 * cualquier cosa por encima da un piso negativo. El tope se pone acá y no solo en el
 * servicio porque la fórmula que lo divide vive en este mismo archivo.
 */
const marginPctSchema = decimalStringSchema('RATE', { positive: true }).refine(
  (v) => toDecimal(v).lt(100),
  'El margen debe ser menor que 100%: se calcula sobre el precio de venta, no sobre el costo',
);

export const updatePricingSettingSchema = z
  .object({
    marginPct: marginPctSchema,
    minMarginPct: marginPctSchema,
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: 'Nada que actualizar' });
export type UpdatePricingSettingInput = z.infer<typeof updatePricingSettingSchema>;

/**
 * D-163 — **margen sobre la venta**, no markup sobre el costo.
 *
 * `valor = costo ÷ (1 − margen)`. Hasta esta decisión la fórmula viva era
 * `costo × (1 + margen)`, que es otra cosa: con un costo de 100 y un 20%, el markup da 120 y
 * deja un margen real del 16.67%, no del 20%. El dueño confirmó que el número que la empresa
 * llama «margen» es el segundo, así que la cuenta cambia y los mínimos suben.
 *
 * Devuelve el Decimal **sin redondear**: es un paso intermedio de la cadena que termina en
 * `minAllowedValue`/`suggestedPrice`, y redondear acá metería medio céntimo en el piso.
 *
 * Precondición: `marginPct < 100`, garantizada por `marginPctSchema`. Con 100 o más el
 * denominador se va a cero o a negativo; quien lea un margen de la base sin pasar por el
 * schema tiene que comprobarlo antes (lo hace `resolvePriceFloors` en el API).
 */
export function valueForMargin(avgCost: string, marginPct: string): Decimal {
  const denominator = toDecimal('1').minus(toDecimal(marginPct).dividedBy(100));
  if (denominator.lte(0)) {
    throw new RangeError(`Margen inválido (${marginPct}%): tiene que ser menor que 100`);
  }
  return toDecimal(avgCost).dividedBy(denominator);
}

/**
 * **Valor de venta** (SIN IGV) sugerido a partir del costo promedio ponderado del kardex
 * (D-032, fórmula corregida por D-163).
 */
export function suggestedValue(avgCost: string, marginPct: string): string {
  return toFixedString(valueForMargin(avgCost, marginPct), 'MONEY');
}

/**
 * **Precio de venta** (CON IGV) sugerido: `costo ÷ (1 − margen) × 1.18` (D-163).
 *
 * Es el número que se le muestra al vendedor, porque desde D-162 lo que se tipea en la
 * cotización es el precio con IGV. El redondeo es uno solo y al final.
 */
export function suggestedPrice(avgCost: string, marginPct: string): string {
  return toFixedString(salePriceFromValue(valueForMargin(avgCost, marginPct)), 'MONEY');
}

/**
 * El **piso duro** de una línea, expresado como valor de venta sin IGV (D-163).
 *
 * La comparación del API se hace contra **este** número y no contra el precio con IGV, y no
 * es un detalle: lo que se guarda es el valor, así que un vendedor que tipea exactamente el
 * precio mínimo que la pantalla le muestra genera un valor redondeado a cuatro decimales
 * que, multiplicado de vuelta por 1.18, puede caer una diezmilésima por debajo del piso.
 * Comparando valor contra valor, «exactamente en el mínimo» pasa siempre.
 */
export function minAllowedValue(avgCost: string, minMarginPct: string): string {
  return suggestedValue(avgCost, minMarginPct);
}

/** El mismo piso, como precio con IGV y con la escala de dinero completa (D-163). */
export function minAllowedPrice(avgCost: string, minMarginPct: string): string {
  return suggestedPrice(avgCost, minMarginPct);
}

/** Los céntimos son la escala en la que una persona tipea un precio. */
export const PRICE_INPUT_SCALE = 2;

/**
 * D-163 — **el precio más chico que se puede tipear y que igual alcanza el piso.**
 *
 * Es el número que va en la pantalla y en el mensaje de rechazo, y no es
 * `minAllowedPrice` recortado a dos decimales. Ese recorte fue un defecto real: con un costo
 * de 17.50 y un mínimo del 10%, el piso en valor es 19.4444 y el precio 22.9444; la pantalla
 * mostraba «S/ 22.94», el vendedor tipeaba 22.94, el sistema lo dividía por 1.18 y guardaba
 * 19.4407 — **por debajo del piso que acababa de mostrar**. El mensaje decía «sube el precio»
 * sobre el precio que él mismo pedía. Pasaba en cerca de la mitad de las combinaciones.
 *
 * La forma correcta no es redondear hacia arriba y confiar: es **preguntarle a la cadena de
 * vuelta**. `toUnitValue` es exactamente la conversión que el formulario y el API aplican a lo
 * tipeado —dividir por 1.18, redondear, y en una plancha multiplicar por el largo del SKU y
 * volver a redondear— así que el resultado se verifica contra el mismo camino que después
 * decide. Se arranca del céntimo de arriba y se sube de a uno: en la práctica son cero o una
 * vueltas, y el bucle está porque «en la práctica» no es una garantía cuando hay dos
 * redondeos encadenados y un largo de por medio.
 */
export function minTypeablePrice(
  minValuePen: string,
  basisValuePen: string,
  toUnitValue: (pricePen: string) => Decimal,
): string {
  const min = toDecimal(minValuePen);
  // El punto de partida va en la **unidad en la que se tipea** (`basisValuePen`) y el objetivo
  // en la unidad de venta (`minValuePen`), que en una plancha no son la misma: arrancar del
  // piso por plancha para un campo que se llena por metro daba un mínimo 3.6 veces más caro.
  let price = salePriceFromValue(basisValuePen).toDecimalPlaces(
    PRICE_INPUT_SCALE,
    Decimal.ROUND_CEIL,
  );
  const step = toDecimal('0.01');
  // Cota de seguridad: sin ella, un `toUnitValue` que devolviera siempre cero —un largo
  // ausente, un producto mal cargado— haría girar esto para siempre dentro de una request.
  for (let i = 0; i < 100 && toUnitValue(price.toFixed(PRICE_INPUT_SCALE)).lt(min); i += 1) {
    price = price.plus(step);
  }
  return price.toFixed(PRICE_INPUT_SCALE);
}
