import type { Prisma } from '@prisma/client';
import {
  compareLockKeys,
  isLockNotAvailable,
  LockOrderConflict,
  lockStateOf,
  sortedUniqueIds,
} from './row-locks';

/**
 * cc30 (grupo C de D-386): **la puerta de los `FOR UPDATE` sobre las tablas de documentos.**
 * Tiene el mismo patrón que `lockCoilRows` para las bobinas: recibe el conjunto
 * entero de la operación y lo toma en el orden canónico, una sentencia por clase y por id
 * ascendente dentro de cada una. Lo vigila `document-locks.sentinel.spec.ts` (desde el corte 2).
 *
 * El orden canónico completo del sistema es el de esta lista seguido del tramo de inventario de
 * D-386 (bobinas → saldos, `lockCoilRows`/`InventoryService.lockBalance`):
 *
 * cotización → pedido → OP → reserva temporal → reserva → … → bobinas → saldos
 *
 * El padre va antes que el hijo: una operación de planta lee el pedido de su OP sin bloquear (el
 * vínculo no cambia), toma pedido y OP juntos por esta puerta, y después relee lo que decide.
 *
 * **Una segunda toma no amplía el conjunto fuera de orden.** Igual que `lockCoilRows`: la
 * transacción recuerda qué tomó; si una toma posterior trae filas que esperar rompería el orden
 * —una clase anterior a otra ya tomada, un id menor que uno ya tomado de la misma clase, o
 * cualquier documento con inventario ya en mano—, esas filas se piden con `NOWAIT` y, si otra
 * operación las tiene, sale el 409 de `LockConflictFilter` en el acto en vez de esperar en un
 * ciclo. Es la red para los conjuntos que se amplían; el camino normal toma todo al inicio.
 *
 * Devuelve, por clase, los ids que de verdad existían (y quedaron bloqueados).
 */
export const DOCUMENT_LOCK_ORDER = [
  'quotations',
  'salesOrders',
  'productionOrders',
  'quotationReservations',
  'reservations',
] as const;

export type DocumentClass = (typeof DOCUMENT_LOCK_ORDER)[number];

export type DocumentLockSet = Partial<
  Record<DocumentClass, readonly (string | null | undefined)[]>
>;

export type LockedDocuments = Record<DocumentClass, string[]>;

/** Nombre de la clase en el mensaje de un `NOWAIT` (el log lo distingue de una bobina). */
const LABELS: Record<DocumentClass, string> = {
  quotations: 'cotización',
  salesOrders: 'pedido',
  productionOrders: 'orden de producción',
  quotationReservations: 'reserva temporal',
  reservations: 'reserva',
};

/** La tabla de cada clase; el centinela vigila estas. */
export const DOCUMENT_LOCK_TABLES: Record<DocumentClass, string> = {
  quotations: 'quotations',
  salesOrders: 'sales_orders',
  productionOrders: 'production_orders',
  quotationReservations: 'quotation_reservations',
  reservations: 'reservations',
};

/**
 * Una sentencia literal por tabla —y no un nombre de tabla armado— para que el centinela vea cada
 * `FOR UPDATE` tal cual y nada más en el repo pueda escribir uno igual sin que falle.
 */
async function lockRows(
  tx: Prisma.TransactionClient,
  cls: DocumentClass,
  ids: string[],
  nowait: boolean,
): Promise<{ id: string }[]> {
  switch (cls) {
    case 'quotations':
      return nowait
        ? tx.$queryRaw`SELECT "id" FROM "quotations" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR UPDATE NOWAIT`
        : tx.$queryRaw`SELECT "id" FROM "quotations" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR UPDATE`;
    case 'salesOrders':
      return nowait
        ? tx.$queryRaw`SELECT "id" FROM "sales_orders" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR UPDATE NOWAIT`
        : tx.$queryRaw`SELECT "id" FROM "sales_orders" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR UPDATE`;
    case 'productionOrders':
      return nowait
        ? tx.$queryRaw`SELECT "id" FROM "production_orders" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR UPDATE NOWAIT`
        : tx.$queryRaw`SELECT "id" FROM "production_orders" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR UPDATE`;
    case 'quotationReservations':
      return nowait
        ? tx.$queryRaw`SELECT "id" FROM "quotation_reservations" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR UPDATE NOWAIT`
        : tx.$queryRaw`SELECT "id" FROM "quotation_reservations" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR UPDATE`;
    case 'reservations':
      return nowait
        ? tx.$queryRaw`SELECT "id" FROM "reservations" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR UPDATE NOWAIT`
        : tx.$queryRaw`SELECT "id" FROM "reservations" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR UPDATE`;
  }
}

export async function lockDocuments(
  tx: Prisma.TransactionClient,
  set: DocumentLockSet,
): Promise<LockedDocuments> {
  const state = lockStateOf(tx);
  const out = Object.fromEntries(
    DOCUMENT_LOCK_ORDER.map((c) => [c, [] as string[]]),
  ) as LockedDocuments;

  for (const [rank, cls] of DOCUMENT_LOCK_ORDER.entries()) {
    const sorted = sortedUniqueIds((set[cls] ?? []).filter((id): id is string => !!id));
    if (sorted.length === 0) continue;
    let held = state.documents.get(cls);
    if (!held) {
      held = new Set();
      state.documents.set(cls, held);
    }
    const fresh = sorted.filter((id) => !held.has(id));
    if (fresh.length > 0) {
      const highestHeld = [...held].sort(compareLockKeys).at(-1);
      const laterClassHeld = DOCUMENT_LOCK_ORDER.slice(rank + 1).some(
        (later) => (state.documents.get(later)?.size ?? 0) > 0,
      );
      const outOfOrder =
        state.balances ||
        state.coils.size > 0 ||
        laterClassHeld ||
        (highestHeld !== undefined && fresh.some((id) => compareLockKeys(id, highestHeld) < 0));
      let rows: { id: string }[];
      try {
        rows = await lockRows(tx, cls, outOfOrder ? fresh : sorted, outOfOrder);
      } catch (error) {
        if (outOfOrder && isLockNotAvailable(error)) throw new LockOrderConflict(LABELS[cls]);
        throw error;
      }
      for (const r of rows) held.add(r.id);
    }
    out[cls] = sorted.filter((id) => held.has(id));
  }
  return out;
}
