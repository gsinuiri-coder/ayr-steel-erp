import type { Prisma, PriceListChangeOrigin } from '@prisma/client';
import { toDecimal, type Decimal } from '@ayr/shared';

/**
 * Historial de `products.list_price_pen` (D-217/M1a). Mismo criterio que
 * `sales/price-changes.ts` (D-187): la tabla es propia y append-only, y quien escribe compara
 * valores con `Decimal`, nunca strings — dos representaciones del mismo número («7.5» y
 * «7.5000») no son un cambio.
 */

/**
 * `computePriceFloors` pide una tolerancia de plan de corte (D-086) que solo usa para el
 * costo de `RAW_MATERIAL` — un candidato de catálogo (`PRODUCT`, todo lo de M1/M2) nunca la
 * toca, así que no hay un valor "correcto" que pasar. Una sola constante para no repetir el
 * mismo comentario en cada llamador (`CatalogService.priceFloor`, `PriceListImportService`).
 */
export const PRICE_FLOOR_UNUSED_TOLERANCE_MM = '0.02';

export interface RecordPriceListChangeInput {
  productId: string;
  /** `null` cuando el producto no tenía precio de lista antes del cambio. */
  beforeValuePen: Decimal | string | null;
  /** `null` cuando el cambio **quita** el precio de lista (vuelve a "sin precio"). */
  afterValuePen: Decimal | string | null;
  changedById: string;
  origin: PriceListChangeOrigin;
  /** Solo con `origin: 'IMPORT'`. */
  batchId?: string;
  /** Solo cuando esta fila es la reversa de un lote. */
  revertsBatchId?: string;
}

/** `true` si el valor cambió de verdad — compara `Decimal`, no el string tal como llegó. */
export function priceListValueChanged(
  before: Decimal | string | null,
  after: Decimal | string | null,
): boolean {
  if (before === null && after === null) return false;
  if (before === null || after === null) return true;
  return !toDecimal(before.toString()).equals(toDecimal(after.toString()));
}

/** Una sola fila. Para un lote (M1c), `recordPriceListChanges` hace un solo `createMany`. */
export async function recordPriceListChange(
  tx: Prisma.TransactionClient,
  input: RecordPriceListChangeInput,
): Promise<void> {
  await tx.productListPriceChange.create({ data: toRow(input) });
}

/** El lado de lote de `recordPriceListChange`: un `createMany` para toda la carga confirmada. */
export async function recordPriceListChanges(
  tx: Prisma.TransactionClient,
  inputs: RecordPriceListChangeInput[],
): Promise<void> {
  if (inputs.length === 0) return;
  await tx.productListPriceChange.createMany({ data: inputs.map(toRow) });
}

function toRow(
  input: RecordPriceListChangeInput,
): Prisma.ProductListPriceChangeUncheckedCreateInput {
  return {
    productId: input.productId,
    beforeValuePen: input.beforeValuePen === null ? null : input.beforeValuePen.toString(),
    afterValuePen: input.afterValuePen === null ? null : input.afterValuePen.toString(),
    changedById: input.changedById,
    origin: input.origin,
    batchId: input.batchId ?? null,
    revertsBatchId: input.revertsBatchId ?? null,
  };
}
