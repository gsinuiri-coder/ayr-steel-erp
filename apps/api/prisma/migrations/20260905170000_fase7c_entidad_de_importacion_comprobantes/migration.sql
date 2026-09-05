-- RF-71: los comprobantes ya emitidos se importan por el mismo camino que el catálogo, los
-- clientes y las bobinas. Va **sola** en su migración por la misma razón que D-103: Postgres
-- no admite usar un valor de enum recién agregado dentro de la transacción que lo agregó.
ALTER TYPE "ImportEntity" ADD VALUE 'FISCAL_DOCUMENTS';
