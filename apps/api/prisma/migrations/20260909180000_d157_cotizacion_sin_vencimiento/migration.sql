-- D-157: una cotización puede no tener vencimiento.
--
-- `NULL` en `valid_until` significa **sin vencimiento**: no vence nunca y siempre se puede
-- confirmar. Lo pide el importador de cotizaciones (D-152), que carga comprobantes ya
-- vendidos: darles una vigencia obligaba a inventar una fecha o a crearlos vencidos, y una
-- cotización vencida no la deja confirmar ninguna validación.
--
-- Aditiva y reversible: aflojar `NOT NULL` no toca ninguna fila existente, y el API viejo
-- contra la base migrada sigue funcionando mientras nadie escriba un `NULL`.
ALTER TABLE "quotations" ALTER COLUMN "valid_until" DROP NOT NULL;
