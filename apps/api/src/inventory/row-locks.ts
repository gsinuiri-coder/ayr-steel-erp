import type { InventoryItemType, Prisma } from '@prisma/client';

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
 * **Una segunda toma no amplía el conjunto fuera de orden** (D-386, P3-2 de cc15b). La
 * transacción recuerda qué bobinas ya bloqueó y si ya tiene algún saldo. Si una toma posterior
 * trae bobinas nuevas y esperar por ellas rompería el orden —ya hay un saldo en mano, o alguna
 * nueva tiene un id menor que una ya tomada—, las nuevas se piden con `NOWAIT`: si están libres
 * se toman sin esperar, y si otra transacción las tiene, la operación sale en el acto con el 409
 * de `LockConflictFilter` en vez de quedarse esperando en un ciclo. Pasa cuando entre la primera
 * toma y una salida de kardex otra transacción confirma una promesa sobre un agregado nuevo.
 *
 * Devuelve los ids que de verdad existían (y quedaron bloqueados).
 */
export async function lockCoilRows(
  tx: Prisma.TransactionClient,
  coilIds: readonly string[],
): Promise<string[]> {
  const sorted = sortedUniqueIds(coilIds);
  if (sorted.length === 0) return [];
  const state = lockStateOf(tx);
  const fresh = sorted.filter((id) => !state.coils.has(id));
  if (fresh.length === 0) return sorted;

  const highestHeld = [...state.coils].sort(compareLockKeys).at(-1);
  const outOfOrder =
    state.balances ||
    (highestHeld !== undefined && fresh.some((id) => compareLockKeys(id, highestHeld) < 0));
  if (!outOfOrder) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "coils" WHERE "id" = ANY(${sorted}::uuid[]) ORDER BY "id" FOR UPDATE
    `;
    for (const r of rows) state.coils.add(r.id);
    return rows.map((r) => r.id);
  }

  let rows: { id: string }[];
  try {
    rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "coils" WHERE "id" = ANY(${fresh}::uuid[]) ORDER BY "id" FOR UPDATE NOWAIT
    `;
  } catch (error) {
    if (isLockNotAvailable(error)) throw new LockOrderConflict();
    throw error;
  }
  for (const r of rows) state.coils.add(r.id);
  return sorted.filter((id) => state.coils.has(id));
}

/**
 * Lo que una transacción ya bloqueó, por objeto de transacción (el `tx` de Prisma es el mismo
 * objeto durante toda la transacción interactiva). `WeakMap`: se olvida solo con la transacción.
 */
const lockStates = new WeakMap<object, TxLockState>();

/**
 * `documents` (cc30): las filas de documento ya tomadas por `lockDocuments`
 * (`document-locks.ts`), por clase. Vive en el mismo estado que las bobinas y los saldos porque
 * el orden es uno solo: un documento pedido con inventario ya en mano va fuera de orden.
 */
export interface TxLockState {
  coils: Set<string>;
  balances: boolean;
  documents: Map<string, Set<string>>;
}

export function lockStateOf(tx: Prisma.TransactionClient): TxLockState {
  let state = lockStates.get(tx);
  if (!state) {
    state = { coils: new Set(), balances: false, documents: new Map() };
    lockStates.set(tx, state);
  }
  return state;
}

/** `InventoryService.lockBalance` avisa que la transacción ya tiene un saldo en mano. */
export function markBalanceHeld(tx: Prisma.TransactionClient): void {
  lockStateOf(tx).balances = true;
}

/**
 * La fila estaba tomada y la toma no podía esperar sin romper el orden (`NOWAIT`). Lleva el
 * código de Postgres de un deadlock para que `LockConflictFilter` responda el mismo 409: para el
 * usuario es lo mismo —otra operación usaba ese inventario— y la salida también.
 */
export class LockOrderConflict extends Error {
  /** `55P03` (`lock_not_available`): no es un deadlock, y el log lo distingue (autorrevisión P3-5). */
  readonly code = '55P03';
  constructor(what = 'bobina') {
    super(
      `NOWAIT: fila de ${what} tomada por otra operación; esperar habría roto el orden de bloqueos`,
    );
  }
}

/** `55P03` (`lock_not_available`), como lo entrega Prisma desde un `$queryRaw`. */
export function isLockNotAvailable(error: unknown): boolean {
  const e = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  return (
    e.meta?.code === '55P03' ||
    (typeof e.message === 'string' && /\b55P03\b|could not obtain lock/i.test(e.message))
  );
}

/**
 * Sin duplicados, **en minúsculas** —como los devuelve Postgres; un `uuid` en mayúsculas que
 * acepta `ParseUUIDPipe` es la misma fila (autorrevisión P3-4)— y en el orden de los bloqueos (el
 * de `ORDER BY "id"` sobre un `uuid`).
 */
export function sortedUniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()))].sort(compareLockKeys);
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

/** Las coordenadas de saldo de un movimiento, para pasarlas a `InventoryService.lockInOrder`. */
export function itemRefOf(m: {
  businessLineId: string;
  itemType: InventoryItemType;
  itemId: string;
  unit: string;
}): { businessLineId: string; itemType: InventoryItemType; itemId: string; unit: string } {
  return { businessLineId: m.businessLineId, itemType: m.itemType, itemId: m.itemId, unit: m.unit };
}
