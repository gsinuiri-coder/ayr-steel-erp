-- ---------------------------------------------------------------------------
-- Sesión 7-final, M1 — `RAW_MATERIAL` como clase de ítem del ledger de reservas
-- (D-134).
--
-- Va **sola en su propia migración** a propósito: Postgres deja agregar un valor a un
-- enum dentro de una transacción, pero no deja **usarlo** hasta que esa transacción
-- commitea, y Prisma corre cada migración en una transacción. La migración que crea la
-- tabla y convierte las reservas vivas viene enseguida y ya puede nombrarlo.
-- ---------------------------------------------------------------------------

ALTER TYPE "InventoryItemType" ADD VALUE IF NOT EXISTS 'RAW_MATERIAL';
