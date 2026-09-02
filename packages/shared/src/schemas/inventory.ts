import { z } from 'zod';
import { decimalStringSchema } from '../decimal';
import {
  BUSINESS_LINES,
  INVENTORY_ITEM_TYPES,
  INVENTORY_MOVEMENT_TYPES,
  INVENTORY_REF_TYPES,
} from '../enums';

/**
 * Kardex (§3.2, D-028). Todos los Decimal viajan como string (D-003).
 * El único escritor de estas tablas es `InventoryService`; el API solo expone lectura.
 */
export const inventoryMovementSchema = z.object({
  id: z.string(),
  businessLine: z.enum(BUSINESS_LINES),
  itemType: z.enum(INVENTORY_ITEM_TYPES),
  itemId: z.string().uuid(),
  /** Etiqueta legible del ítem: SKU del producto o código de bobina. */
  itemLabel: z.string(),
  type: z.enum(INVENTORY_MOVEMENT_TYPES),
  qty: z.string(),
  unit: z.string(),
  unitCost: z.string(),
  totalCost: z.string(),
  refType: z.enum(INVENTORY_REF_TYPES),
  refId: z.string().nullable(),
  reversalOfId: z.string().nullable(),
  actorId: z.string().uuid().nullable(),
  actorName: z.string().nullable(),
  at: z.string(),
  /**
   * Saldo y costo promedio justo después de este movimiento. Solo vienen cuando la
   * consulta es el kardex de un ítem concreto (RF-53), que es donde el saldo corrido
   * tiene sentido; en un listado mezclado de ítems son `null`.
   */
  balanceQty: z.string().nullable(),
  balanceAvgCost: z.string().nullable(),
});
export type InventoryMovementDto = z.infer<typeof inventoryMovementSchema>;

export const inventoryBalanceSchema = z.object({
  id: z.string().uuid(),
  businessLine: z.enum(BUSINESS_LINES),
  itemType: z.enum(INVENTORY_ITEM_TYPES),
  itemId: z.string().uuid(),
  itemLabel: z.string(),
  itemName: z.string(),
  qty: z.string(),
  unit: z.string(),
  avgCost: z.string(),
  /** qty × avgCost, precalculado por el API para no repetir la multiplicación en el web. */
  totalValue: z.string(),
  updatedAt: z.string(),
});
export type InventoryBalanceDto = z.infer<typeof inventoryBalanceSchema>;

/** Filtros del kardex de un ítem (RF-53) y del inventario valorizado (RF-51). */
export const inventoryQuerySchema = z.object({
  itemType: z.enum(INVENTORY_ITEM_TYPES).optional(),
  itemId: z.string().uuid().optional(),
  businessLine: z.enum(BUSINESS_LINES).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD)')
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD)')
    .optional(),
});
export type InventoryQuery = z.infer<typeof inventoryQuerySchema>;

/** Cantidades de kardex: siempre positivas; el sentido lo da el tipo de movimiento. */
export const inventoryQtySchema = decimalStringSchema('KG', { positive: true });
export const inventoryCostSchema = decimalStringSchema('MONEY');
