import { z } from 'zod';
import { BUSINESS_LINES } from '../enums';
import { decimalStringSchema, toDecimal, toFixedString } from '../decimal';

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

export const updatePricingSettingSchema = z
  .object({
    marginPct: decimalStringSchema('RATE', { positive: true }),
    minMarginPct: decimalStringSchema('RATE', { positive: true }),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: 'Nada que actualizar' });
export type UpdatePricingSettingInput = z.infer<typeof updatePricingSettingSchema>;

/** Precio sugerido = costo promedio ponderado del kardex × (1 + margen%) (D-032). */
export function suggestedPrice(avgCost: string, marginPct: string): string {
  const cost = toDecimal(avgCost);
  const factor = toDecimal('1').plus(toDecimal(marginPct).dividedBy(100));
  return toFixedString(cost.times(factor), 'MONEY');
}

/** Precio mínimo permitido a un VENDEDOR = costo promedio × (1 + margen mínimo%) (D-032). */
export function minAllowedPrice(avgCost: string, minMarginPct: string): string {
  return suggestedPrice(avgCost, minMarginPct);
}
