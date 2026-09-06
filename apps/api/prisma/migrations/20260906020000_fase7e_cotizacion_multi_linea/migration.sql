-- Fase 7e (D-119): una cotización o un pedido ya no tienen una única línea de negocio —
-- cada ítem trae la suya (vía su producto). Se elimina la columna y su índice compuesto;
-- Postgres suelta el índice y la FK dependientes al soltar la columna.
ALTER TABLE "quotations" DROP COLUMN "business_line_id";
ALTER TABLE "sales_orders" DROP COLUMN "business_line_id";
