-- ---------------------------------------------------------------------------
-- Sesión 7-final, M3/M4 — dos entidades de importación nuevas (D-137, D-138).
--
-- Sola en su propia migración por lo mismo que `RAW_MATERIAL`: Postgres deja agregar un
-- valor a un enum dentro de una transacción pero no deja usarlo hasta que commitea, y
-- Prisma corre cada migración en una.
--
-- `COILS_HISTORY` no reemplaza a `COILS`: aquella es la planilla **canónica** del ERP (RF-12,
-- con código de proveedor y línea de negocio por fila), esta es el Excel real con el que el
-- dueño lleva sus bobinas, que trae RUC, factura, valorización y stock actual. Lo mismo
-- entre `SALES_HISTORY` y `FISCAL_DOCUMENTS`.
-- ---------------------------------------------------------------------------

ALTER TYPE "ImportEntity" ADD VALUE IF NOT EXISTS 'COILS_HISTORY';
ALTER TYPE "ImportEntity" ADD VALUE IF NOT EXISTS 'SALES_HISTORY';
