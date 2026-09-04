import { z } from 'zod';
import { BUSINESS_LINES, INVENTORY_STRATEGIES } from '../enums';

/**
 * Líneas de negocio (§2.2). Datos fijos sembrados en la migración inicial de Fase 1;
 * el módulo API solo expone lectura (no hay alta/baja de líneas de negocio).
 */
export const businessLineSchema = z.object({
  id: z.string().uuid(),
  code: z.enum(BUSINESS_LINES),
  name: z.string(),
  inventoryStrategy: z.enum(INVENTORY_STRATEGIES),
  /**
   * D-065: la línea exige cotización confirmada antes de vender (coberturas, RF-31) o
   * admite pedido directo. El web lo usa para ofrecer o esconder el alta directa de pedido.
   */
  quotationRequired: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BusinessLineDto = z.infer<typeof businessLineSchema>;
