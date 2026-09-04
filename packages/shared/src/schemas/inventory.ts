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
  /** Costos en soles (D-042). Van en null para VENDEDOR, que no ve costos de compra. */
  unitCost: z.string().nullable(),
  totalCost: z.string().nullable(),
  refType: z.enum(INVENTORY_REF_TYPES),
  refId: z.string().nullable(),
  /** Motivo escrito por el usuario en una merma, una anulación o un ajuste de costo. */
  notes: z.string().nullable(),
  reversalOfId: z.string().nullable(),
  /** Id del movimiento que anula a este, si ya fue revertido (RF-18, RF-21). */
  reversedById: z.string().nullable(),
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
  /** Saldo **físico**: lo que el kardex dice que hay. No descuenta reservas. */
  qty: z.string(),
  unit: z.string(),
  /** D-066: suma de las reservas `ACTIVA` sobre este ítem. Cantidades, no costos: se ve con cualquier rol. */
  reservedQty: z.string(),
  /** `qty − reservedQty`. Es lo que una venta o una producción nueva puede tomar. */
  availableQty: z.string(),
  /** Costos en soles (D-042). Van en null para VENDEDOR, que no ve costos de compra. */
  avgCost: z.string().nullable(),
  /** qty × avgCost, precalculado por el API para no repetir la multiplicación en el web. */
  totalValue: z.string().nullable(),
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

/**
 * Inventario valorizado de una línea (RF-51, base de RF-90). Las bobinas se agrupan
 * por `typeKey` (RF-14: acabado + espesor, sin ancho) porque un partido cambia el
 * ancho pero no el material; los productos de catálogo van uno por SKU.
 * Todo el valorizado va en soles (D-042).
 */
export const inventorySummaryRowSchema = z.object({
  /** `typeKey` de la bobina o SKU del producto: identifica la fila y agrupa. */
  key: z.string(),
  itemType: z.enum(INVENTORY_ITEM_TYPES),
  name: z.string(),
  qty: z.string(),
  unit: z.string(),
  /** Costo promedio ponderado en soles del grupo (valor total / cantidad). */
  avgCostPen: z.string().nullable(),
  totalValuePen: z.string().nullable(),
  /** Cuántas bobinas hay detrás de la fila; siempre 1 en un producto de catálogo. */
  itemCount: z.number().int(),
  /** Id del ítem cuando la fila es un solo ítem (producto), para enlazar al kardex. */
  itemId: z.string().uuid().nullable(),
});
export type InventorySummaryRowDto = z.infer<typeof inventorySummaryRowSchema>;

export const inventorySummarySchema = z.object({
  businessLine: z.enum(BUSINESS_LINES),
  coils: z.array(inventorySummaryRowSchema),
  products: z.array(inventorySummaryRowSchema),
  totalValuePen: z.string().nullable(),
});
export type InventorySummaryDto = z.infer<typeof inventorySummarySchema>;

/** Cantidades de kardex: siempre positivas; el sentido lo da el tipo de movimiento. */
export const inventoryQtySchema = decimalStringSchema('KG', { positive: true });
export const inventoryCostSchema = decimalStringSchema('MONEY');
