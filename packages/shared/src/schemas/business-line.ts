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
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BusinessLineDto = z.infer<typeof businessLineSchema>;
