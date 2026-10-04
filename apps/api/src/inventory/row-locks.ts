import type { Prisma } from '@prisma/client';

/**
 * D-386: **el único `FOR UPDATE` sobre `coils` de todo el código.** El de `inventory_balances`
 * vive en `InventoryService.lockBalance`; los dos los vigila `row-locks.sentinel.spec.ts`.
 *
 * El orden canónico de bloqueos del sistema (D-386, `docs/ARQUITECTURA.md` §3):
 * documento(s) → reservas → **bobinas** → **saldos**. Las bobinas se piden siempre así: el
 * conjunto entero, sin duplicados, en una sola sentencia y por id ascendente. El orden de id
 * de un `uuid` en Postgres es el de sus bytes, que coincide con comparar el texto hexadecimal
 * en minúsculas por unidades de código (`compareLockKeys`); por eso el `sort` de acá y el
 * `ORDER BY` de la sentencia dicen lo mismo.
 *
 * Quien necesita varias bobinas **no** llama a esto en un bucle: junta el conjunto y lo pide de
 * una vez (`InventoryService.lockInOrder`). Dos pedidos separados sobre conjuntos que se
 * solapan se cruzan aunque cada uno vaya ordenado.
 *
 * Devuelve los ids que de verdad existían (y quedaron bloqueados).
 */
export async function lockCoilRows(
  tx: Prisma.TransactionClient,
  coilIds: readonly string[],
): Promise<string[]> {
  const sorted = sortedUniqueIds(coilIds);
  if (sorted.length === 0) return [];
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "coils" WHERE "id" = ANY(${sorted}::uuid[]) ORDER BY "id" FOR UPDATE
  `;
  return rows.map((r) => r.id);
}

/** Sin duplicados y en el orden de los bloqueos (el de `ORDER BY "id"` sobre un `uuid`). */
export function sortedUniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort(compareLockKeys);
}

/** La clave de orden de un saldo: tipo de ítem y después id (`COIL` antes que `PRODUCT`). */
export function balanceLockKey(ref: { itemType: string; itemId: string }): string {
  return `${ref.itemType}:${ref.itemId}`;
}

/** Comparación por unidades de código, sin reglas de idioma: determinista en cualquier entorno. */
export function compareLockKeys(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
