-- D-074: la cantidad que sale del kardex no siempre es la de venta. Una cobertura se
-- vende por pieza y sale de los kilos de una bobina (D-066), así que despachar 100
-- piezas tiene que sacar los kilos que esa línea reservó, no 100 kilos.
--
-- Se guarda en vez de derivarse para que la reversa devuelva exactamente lo mismo que
-- sacó, sin depender de que la línea del pedido siga diciendo lo mismo.
--
-- No hay despachos todavía: la columna entra NOT NULL sin default ni backfill.
ALTER TABLE "dispatch_items" ADD COLUMN "reserve_qty" DECIMAL(16,3) NOT NULL;
ALTER TABLE "dispatch_items" ADD CONSTRAINT "dispatch_items_reserve_qty_ck" CHECK ("reserve_qty" > 0);
