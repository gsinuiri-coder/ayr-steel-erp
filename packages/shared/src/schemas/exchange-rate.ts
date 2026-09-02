import { z } from 'zod';
import { CURRENCIES, EXCHANGE_RATE_SOURCES } from '../enums';
import { decimalStringSchema } from '../decimal';

const isoDateSchema = z
  .string({ required_error: 'La fecha es obligatoria' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido (YYYY-MM-DD)');

/**
 * Tipo de cambio del día (D-029/P-06): caché de la consulta a apis.net.pe, o
 * un registro manual (`source: MANUAL`) cuando la API externa no responde.
 */
export const exchangeRateSchema = z.object({
  id: z.string().uuid(),
  date: z.string(),
  currency: z.enum(CURRENCIES),
  buy: z.string(),
  sell: z.string(),
  source: z.enum(EXCHANGE_RATE_SOURCES),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExchangeRateDto = z.infer<typeof exchangeRateSchema>;

export const getExchangeRateQuerySchema = z.object({
  date: isoDateSchema,
  currency: z.enum(CURRENCIES),
});
export type GetExchangeRateQuery = z.infer<typeof getExchangeRateQuerySchema>;

export const upsertManualExchangeRateSchema = z.object({
  date: isoDateSchema,
  currency: z.enum(CURRENCIES, { errorMap: () => ({ message: 'Moneda inválida' }) }),
  buy: decimalStringSchema('RATE', { positive: true }),
  sell: decimalStringSchema('RATE', { positive: true }),
});
export type UpsertManualExchangeRateInput = z.infer<typeof upsertManualExchangeRateSchema>;
